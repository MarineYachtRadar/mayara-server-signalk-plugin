import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type {
  ContainerConfig,
  ContainerManagerApi,
  ContainerResourceLimits,
  UpdateCheckResult,
  UpdateRegistration
} from '../src/types'

// =============================================================================
// Mocks for the plugin's other collaborators
// =============================================================================
//
// We're testing the container integration in index.ts. The radar/spoke side
// would otherwise try to make real network calls when start() runs, so we
// mock the modules at import time.

vi.mock('../src/mayara-client', () => {
  return {
    MayaraClient: vi.fn().mockImplementation(() => ({
      getRadars: vi.fn().mockResolvedValue({}),
      getCapabilities: vi.fn().mockResolvedValue({}),
      close: vi.fn(),
      getSpokeStreamUrl: vi.fn().mockReturnValue('ws://localhost:6502/x'),
      getTargetStreamUrl: vi.fn().mockReturnValue('ws://localhost:6502/y')
    }))
  }
})

vi.mock('../src/radar-provider', () => ({
  createRadarProvider: vi.fn().mockReturnValue({})
}))

vi.mock('../src/spoke-forwarder', () => ({
  SpokeForwarder: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    isConnected: () => false
  }))
}))

// =============================================================================
// Test doubles for the signalk-container API
// =============================================================================

interface MockContainerManager extends ContainerManagerApi {
  // Capture state for assertions
  _calls: {
    ensureRunning: Array<{ name: string; config: ContainerConfig }>
    pullImage: string[]
    remove: string[]
    stop: string[]
    updateRegistrations: UpdateRegistration[]
    updateCheckOne: string[]
    updateUnregister: string[]
  }
  // Allow tests to control what checkOne returns
  _nextCheckResult: UpdateCheckResult | null
}

function makeMockContainerManager(): MockContainerManager {
  const calls: MockContainerManager['_calls'] = {
    ensureRunning: [],
    pullImage: [],
    remove: [],
    stop: [],
    updateRegistrations: [],
    updateCheckOne: [],
    updateUnregister: []
  }

  const defaultCheckResult = (id: string): UpdateCheckResult => ({
    pluginId: id,
    containerName: 'mayara-server',
    runningTag: 'latest',
    tagKind: 'floating',
    currentVersion: null,
    latestVersion: '3.4.0',
    updateAvailable: false,
    reason: 'up-to-date',
    checkedAt: new Date().toISOString(),
    lastSuccessfulCheckAt: new Date().toISOString(),
    fromCache: false
  })

  const mock: MockContainerManager = {
    _calls: calls,
    _nextCheckResult: null,
    getRuntime: () => ({
      runtime: 'podman',
      version: '5.0.0',
      isPodmanDockerShim: false
    }),
    pullImage: vi.fn((image: string) => {
      calls.pullImage.push(image)
      return Promise.resolve()
    }),
    imageExists: vi.fn(() => Promise.resolve(true)),
    getImageDigest: vi.fn(() => Promise.resolve('sha256:test')),
    ensureRunning: vi.fn((name: string, config: ContainerConfig) => {
      calls.ensureRunning.push({ name, config })
      return Promise.resolve()
    }),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn((name: string) => {
      calls.stop.push(name)
      return Promise.resolve()
    }),
    remove: vi.fn((name: string) => {
      calls.remove.push(name)
      return Promise.resolve()
    }),
    getState: vi.fn(() => Promise.resolve('running' as const)),
    listContainers: vi.fn(() => Promise.resolve([])),
    updateResources: vi.fn(() => Promise.resolve({ method: 'live' as const })),
    getResources: vi.fn((): ContainerResourceLimits => ({})),
    updates: {
      register: vi.fn((reg: UpdateRegistration) => {
        calls.updateRegistrations.push(reg)
      }),
      unregister: vi.fn((id: string) => {
        calls.updateUnregister.push(id)
      }),
      checkOne: vi.fn((id: string) => {
        calls.updateCheckOne.push(id)
        return Promise.resolve(mock._nextCheckResult ?? defaultCheckResult(id))
      }),
      checkAll: vi.fn(() => Promise.resolve([])),
      getLastResult: vi.fn(() => null),
      sources: {
        // Source factories return opaque markers; the service handles the real fetching.
        githubReleases: vi.fn((repo: string) => ({
          fetch: vi.fn(() => Promise.resolve(undefined)),
          _kind: 'githubReleases',
          _repo: repo
        })) as unknown as ContainerManagerApi['updates']['sources']['githubReleases'],
        dockerHubTags: vi.fn(() => ({
          fetch: vi.fn(() => Promise.resolve(undefined))
        })) as unknown as ContainerManagerApi['updates']['sources']['dockerHubTags']
      }
    }
  }

  return mock
}

// =============================================================================
// Mock app
// =============================================================================

interface MockApp {
  debug: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  setPluginStatus: ReturnType<typeof vi.fn>
  setPluginError: ReturnType<typeof vi.fn>
  getDataDirPath: () => string
  savePluginOptions: ReturnType<typeof vi.fn>
  radarApi: { register: ReturnType<typeof vi.fn>; unRegister: ReturnType<typeof vi.fn> }
  binaryStreamManager: undefined
}

function makeMockApp(): MockApp {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn(),
    getDataDirPath: () => '/tmp/mayara-test',
    // SignalK persistence API: writes to plugin-config-data/<pluginId>.json
    // The signature is (config, callback) where callback gets a NodeJS.ErrnoException | null.
    savePluginOptions: vi.fn(
      (_config: unknown, cb: (err: NodeJS.ErrnoException | null) => void) => {
        cb(null)
      }
    ),
    radarApi: {
      register: vi.fn(),
      unRegister: vi.fn()
    },
    binaryStreamManager: undefined
  }
}

// =============================================================================
// Fake Express router
// =============================================================================

// Express handler return values are typed as `void | Promise<void>` —
// `unknown` would flatten the union under typescript-eslint's redundant
// constituents rule. Mayara's handlers are always void or Promise<void>.
type Handler = (req: unknown, res: unknown) => void | Promise<void>

interface CapturedRouter {
  routes: Map<string, Handler>
  get(path: string, handler: Handler): void
  post(path: string, handler: Handler): void
}

function makeRouter(): CapturedRouter {
  const routes = new Map<string, Handler>()
  return {
    routes,
    get: (path: string, h: Handler) => {
      routes.set(`GET ${path}`, h)
    },
    post: (path: string, h: Handler) => {
      routes.set(`POST ${path}`, h)
    }
  }
}

/**
 * Look up a captured route handler and assert it exists. Lets tests
 * use `await getHandler(...)({...}, res)` without non-null assertions.
 */
function getHandler(router: CapturedRouter, key: string): Handler {
  const handler = router.routes.get(key)
  if (!handler) throw new Error(`No handler captured for ${key}`)
  return handler
}

interface MockResponse {
  statusCode: number
  body: unknown
  status(code: number): MockResponse
  json(value: unknown): MockResponse
}

function makeRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(value) {
      this.body = value
      return this
    }
  }
  return res
}

// =============================================================================
// Plugin loader helper
// =============================================================================

interface LoadedPlugin {
  plugin: {
    id: string
    name: string
    start: (config: unknown) => void
    stop: () => void | Promise<void>
    registerWithRouter: (router: unknown) => void
  }
  app: MockApp
  containers: MockContainerManager
  router: CapturedRouter
}

async function loadPlugin(initialConfig: Record<string, unknown> = {}): Promise<LoadedPlugin> {
  const containers = makeMockContainerManager()
  globalThis.__signalk_containerManager = containers

  const app = makeMockApp()

  // Force a fresh module load each test so module-level state doesn't leak.
  vi.resetModules()
  // The plugin uses CommonJS `module.exports = function(app)`. Vitest's
  // dynamic import wraps that as the default export.
  const mod = (await import('../src/index')) as unknown as {
    default: (a: unknown) => LoadedPlugin['plugin']
  }
  const factory = mod.default
  const plugin = factory(app)

  const router = makeRouter()
  plugin.registerWithRouter(router)

  plugin.start({
    managedContainer: true,
    mayaraVersion: 'latest',
    mayaraArgs: [],
    host: 'localhost',
    port: 6502,
    secure: false,
    discoveryPollInterval: 10,
    reconnectInterval: 5,
    ...initialConfig
  })

  // Let asyncStart's microtask chain run. The mocked MayaraClient.getRadars
  // resolves with {} immediately, so the chain settles in a few ticks.
  await new Promise<void>((resolve) => setTimeout(resolve, 50))

  return { plugin, app, containers, router }
}

// =============================================================================
// Tests
// =============================================================================

beforeEach(() => {
  // Wipe the global between tests so they're isolated.
  delete (globalThis as { __signalk_containerManager?: unknown }).__signalk_containerManager
})

afterEach(() => {
  // Each test calls plugin.stop() explicitly; this is a safety net to
  // make sure the global doesn't leak across tests.
  delete (globalThis as { __signalk_containerManager?: unknown }).__signalk_containerManager
})

describe('mayara-server-signalk-plugin v0.1.5 container integration', () => {
  describe('startup ensureRunning call', () => {
    it('passes the default resource limits', async () => {
      const { containers, plugin } = await loadPlugin()
      expect(containers._calls.ensureRunning.length).toBe(1)
      const { config } = containers._calls.ensureRunning[0]
      expect(config.resources).toEqual({
        cpus: 1.5,
        memory: '512m',
        memorySwap: '512m',
        pidsLimit: 200
      })
      await plugin.stop()
    })

    it('uses host network mode and unless-stopped restart policy', async () => {
      const { containers, plugin } = await loadPlugin()
      const { config } = containers._calls.ensureRunning[0]
      expect(config.networkMode).toBe('host')
      expect(config.restart).toBe('unless-stopped')
      await plugin.stop()
    })

    it('passes the configured tag', async () => {
      const { containers, plugin } = await loadPlugin({ mayaraVersion: 'v3.4.0' })
      const { config } = containers._calls.ensureRunning[0]
      expect(config.tag).toBe('v3.4.0')
      await plugin.stop()
    })

    it('builds command with -n auto-injected when user did not pass it', async () => {
      const { containers, plugin } = await loadPlugin({ mayaraArgs: ['--brand', 'furuno'] })
      const { config } = containers._calls.ensureRunning[0]
      expect(config.command).toEqual([
        'mayara-server',
        '-n',
        expect.stringMatching(/^tcp:127\.0\.0\.1:\d+$/),
        '--brand',
        'furuno'
      ])
      await plugin.stop()
    })

    it('does NOT auto-inject -n when user already passed it', async () => {
      const { containers, plugin } = await loadPlugin({
        mayaraArgs: ['-n', 'tcp:0.0.0.0:9999']
      })
      const { config } = containers._calls.ensureRunning[0]
      expect(config.command?.filter((a) => a === '-n').length).toBe(1)
      expect(config.command).toContain('tcp:0.0.0.0:9999')
      await plugin.stop()
    })
  })

  describe('update service registration', () => {
    it('registers with signalk-container update service at startup', async () => {
      const { containers, plugin } = await loadPlugin()
      expect(containers._calls.updateRegistrations.length).toBe(1)
      const reg = containers._calls.updateRegistrations[0]
      expect(reg.pluginId).toBe('mayara-server-signalk-plugin')
      expect(reg.containerName).toBe('mayara-server')
      expect(reg.image).toBe('ghcr.io/marineyachtradar/mayara-server')
      await plugin.stop()
    })

    it('uses githubReleases source pointing at MarineYachtRadar/mayara-server', async () => {
      const { containers, plugin } = await loadPlugin()
      expect(containers.updates.sources.githubReleases).toHaveBeenCalledWith(
        'MarineYachtRadar/mayara-server'
      )
      await plugin.stop()
    })

    it('currentTag is a function that reads live config', async () => {
      const { containers, plugin } = await loadPlugin({ mayaraVersion: 'v3.0.0' })
      const reg = containers._calls.updateRegistrations[0]
      expect(typeof reg.currentTag).toBe('function')
      expect(reg.currentTag()).toBe('v3.0.0')
      await plugin.stop()
    })
  })

  describe('GET /api/update/check', () => {
    it('delegates to containers.updates.checkOne and returns its result', async () => {
      const { router, containers, plugin } = await loadPlugin()
      const handler = getHandler(router, 'GET /api/update/check')

      const customResult: UpdateCheckResult = {
        pluginId: 'mayara-server-signalk-plugin',
        containerName: 'mayara-server',
        runningTag: 'latest',
        tagKind: 'floating',
        currentVersion: null,
        latestVersion: '3.4.0',
        updateAvailable: true,
        reason: 'digest-drift',
        checkedAt: '2026-04-08T12:00:00.000Z',
        lastSuccessfulCheckAt: '2026-04-08T12:00:00.000Z',
        fromCache: false
      }
      containers._nextCheckResult = customResult

      const res = makeRes()
      await handler({}, res)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual(customResult)
      expect(containers._calls.updateCheckOne).toEqual(['mayara-server-signalk-plugin'])
      await plugin.stop()
    })

    it('returns 503 when signalk-container is not loaded', async () => {
      const { router, plugin } = await loadPlugin()
      // Simulate signalk-container disappearing after startup.
      delete (globalThis as { __signalk_containerManager?: unknown }).__signalk_containerManager
      const handler = getHandler(router, 'GET /api/update/check')
      const res = makeRes()
      await handler({}, res)
      expect(res.statusCode).toBe(503)
      await plugin.stop()
    })
  })

  describe('POST /api/update/apply', () => {
    it('pulls, removes, recreates with new tag, returns success', async () => {
      const { router, containers, plugin } = await loadPlugin()
      const handler = getHandler(router, 'POST /api/update/apply')

      // Reset call counters from the startup ensureRunning call so we can
      // assert only against the route's actions.
      containers._calls.ensureRunning = []
      containers._calls.pullImage = []
      containers._calls.remove = []

      const res = makeRes()
      await handler({ body: { tag: 'v3.4.0' } }, res)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ success: true, tag: 'v3.4.0' })
      expect(containers._calls.pullImage).toEqual(['ghcr.io/marineyachtradar/mayara-server:v3.4.0'])
      expect(containers._calls.remove).toEqual(['mayara-server'])
      expect(containers._calls.ensureRunning.length).toBe(1)
      expect(containers._calls.ensureRunning[0].config.tag).toBe('v3.4.0')
      // Resources still applied on update
      expect(containers._calls.ensureRunning[0].config.resources).toEqual({
        cpus: 1.5,
        memory: '512m',
        memorySwap: '512m',
        pidsLimit: 200
      })
      await plugin.stop()
    })

    it('rejects unsafe tags (shell metacharacters)', async () => {
      const { router, plugin } = await loadPlugin()
      const handler = getHandler(router, 'POST /api/update/apply')
      const res = makeRes()
      await handler({ body: { tag: 'v1.2.3; rm -rf /' } }, res)
      expect(res.statusCode).toBe(400)
      expect((res.body as { error: string }).error).toMatch(/Invalid tag format/)
      await plugin.stop()
    })

    it('falls back to currentSettings.mayaraVersion when body has no tag', async () => {
      const { router, containers, plugin } = await loadPlugin({ mayaraVersion: 'v3.2.0' })
      const handler = getHandler(router, 'POST /api/update/apply')
      containers._calls.pullImage = []
      const res = makeRes()
      await handler({ body: {} }, res)
      expect(res.statusCode).toBe(200)
      expect(containers._calls.pullImage).toEqual(['ghcr.io/marineyachtradar/mayara-server:v3.2.0'])
      await plugin.stop()
    })

    it('persists the new tag to disk via app.savePluginOptions', async () => {
      // CodeRabbit PR #8 finding: previously the route updated only the
      // in-memory currentSettings, so a SK restart before the user clicked
      // "Save Configuration" reverted to the prior tag. Fix calls
      // savePluginOptions() to write through to plugin-config-data.
      const { router, app, plugin } = await loadPlugin({ mayaraVersion: 'v3.0.0' })
      const handler = getHandler(router, 'POST /api/update/apply')
      const res = makeRes()
      await handler({ body: { tag: 'v3.4.0' } }, res)
      expect(res.statusCode).toBe(200)
      expect(app.savePluginOptions).toHaveBeenCalledTimes(1)
      const savedConfig = app.savePluginOptions.mock.calls[0][0] as {
        mayaraVersion: string
      }
      expect(savedConfig.mayaraVersion).toBe('v3.4.0')
      await plugin.stop()
    })

    it('returns success even if persistence callback errors (non-fatal)', async () => {
      // savePluginOptions failure is logged but does not roll back the
      // already-running new container. The user just has to click Update
      // again after a future plugin restart if they want it to stick.
      const { router, app, plugin } = await loadPlugin()
      app.savePluginOptions.mockImplementationOnce(
        (_config: unknown, cb: (err: NodeJS.ErrnoException | null) => void) => {
          const err = new Error('disk full') as NodeJS.ErrnoException
          err.code = 'ENOSPC'
          cb(err)
        }
      )
      const handler = getHandler(router, 'POST /api/update/apply')
      const res = makeRes()
      await handler({ body: { tag: 'v3.4.0' } }, res)
      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ success: true, tag: 'v3.4.0' })
      // Should have logged an error to app.error explaining the situation
      expect(app.error).toHaveBeenCalled()
      await plugin.stop()
    })
  })

  describe('plugin.stop() lifecycle', () => {
    it('unregisters from update service and stops the container', async () => {
      const { plugin, containers } = await loadPlugin()
      await plugin.stop()
      expect(containers._calls.updateUnregister).toEqual(['mayara-server-signalk-plugin'])
      expect(containers._calls.stop).toEqual(['mayara-server'])
    })

    it('does NOT stop the container when managedContainer is false', async () => {
      const { plugin, containers } = await loadPlugin({ managedContainer: false })
      await plugin.stop()
      expect(containers._calls.stop).toEqual([])
      expect(containers._calls.updateUnregister).toEqual([])
    })
  })
})

// =============================================================================
// Static guard against the old shellout pattern
// =============================================================================
//
// Mayara used to shell out to `podman inspect` directly via child_process to
// get image digests. signalk-container v0.1.5 exposes getImageDigest() so the
// shellout is gone. This test guards against accidental regression — if
// anyone re-imports child_process they'll get a clear test failure that
// points at the right modernization.

describe('no shellout regression', () => {
  it('src/index.ts does not import child_process', () => {
    const source = readFileSync(join(__dirname, '../src/index.ts'), 'utf-8')
    expect(source).not.toMatch(/from\s+['"]child_process['"]/)
    expect(source).not.toMatch(/require\s*\(\s*['"]child_process['"]/)
  })

  it('src/index.ts does not import util.promisify (used to wrap exec)', () => {
    const source = readFileSync(join(__dirname, '../src/index.ts'), 'utf-8')
    expect(source).not.toMatch(/promisify/)
  })
})
