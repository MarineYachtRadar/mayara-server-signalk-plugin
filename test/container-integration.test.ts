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

// Default-stub the token flow so tests that aren't specifically about
// it don't issue stray HTTP requests against a non-existent local
// Signal K server. Token-flow tests override per-call via vi.mocked().
vi.mock('../src/signalk-token', async () => {
  const actual =
    await vi.importActual<typeof import('../src/signalk-token')>('../src/signalk-token')
  return {
    ...actual,
    readCachedToken: vi.fn(() => undefined),
    writeCachedToken: vi.fn(),
    beginTokenRequest: vi.fn(() =>
      Promise.resolve({ kind: 'error' as const, message: 'stubbed in tests' })
    ),
    awaitApproval: vi.fn(() => Promise.resolve(undefined))
  }
})

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
    whenReady: vi.fn(() => Promise.resolve()),
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
    // Bare-metal-style resolver: source = the absolute path itself,
    // subPath = "". Mirrors what real signalk-container does when SK
    // is NOT containerized. SK-in-container tests can override per-call.
    resolveHostPath: vi.fn((absPath: string) => Promise.resolve({ source: absPath, subPath: '' })),
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
        })),
        dockerHubTags: vi.fn(() => ({
          fetch: vi.fn(() => Promise.resolve(undefined))
        }))
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
  // Mirrors signalk-server's runtime `app.config`. The public
  // `@signalk/server-api` types don't declare it, so the plugin reads it
  // via an untyped cast; tests populate `settings.ssl`/`sslport`/`port`
  // to drive the nav-address scheme/port resolution.
  config?: { settings?: { ssl?: boolean; sslport?: number; port?: number } }
}

function makeMockApp(config?: MockApp['config']): MockApp {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn(),
    // Opaque string — mayara no longer reads or writes anything in
    // getDataDirPath() now that the hash-file workaround is gone.
    getDataDirPath: () => '/tmp/mayara-test',
    config,
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
  mounts: string[]
  get(path: string, handler: Handler): void
  post(path: string, handler: Handler): void
  // The plugin mounts a reverse-proxy middleware via `router.use('/gui', ...)`.
  // Capture the mount path so tests can assert the proxy is registered;
  // tests don't exercise the proxy behavior itself.
  use(path: string, middleware: unknown): void
}

function makeRouter(): CapturedRouter {
  const routes = new Map<string, Handler>()
  const mounts: string[] = []
  return {
    routes,
    mounts,
    get: (path: string, h: Handler) => {
      routes.set(`GET ${path}`, h)
    },
    post: (path: string, h: Handler) => {
      routes.set(`POST ${path}`, h)
    },
    // Note: `middleware` is intentionally not captured; the mock only
    // needs to record the mount path. The ESLint argsIgnorePattern in
    // this repo is `^$` so a `_middleware` placeholder would lint-error.
    use: (path: string) => {
      mounts.push(path)
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

async function loadPlugin(
  initialConfig: Record<string, unknown> = {},
  appConfig?: MockApp['config']
): Promise<LoadedPlugin> {
  const containers = makeMockContainerManager()
  globalThis.__signalk_containerManager = containers

  const app = makeMockApp(appConfig)

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
    // Tests that aren't specifically about the token flow opt out so
    // they don't issue stray HTTP requests against a non-existent
    // local Signal K server. Token-flow tests override to `true`.
    requestSignalkToken: false,
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

function loadTokenMock(): Promise<typeof import('../src/signalk-token')> {
  return import('../src/signalk-token')
}

beforeEach(async () => {
  // Wipe the global between tests so they're isolated.
  delete (globalThis as { __signalk_containerManager?: unknown }).__signalk_containerManager
  // Reset signalk-token mock state between tests so call counts and
  // stubbed return values don't leak across the suite.
  const tokenModule = await loadTokenMock()
  vi.mocked(tokenModule.readCachedToken).mockReset().mockReturnValue(undefined)
  vi.mocked(tokenModule.writeCachedToken).mockReset()
  vi.mocked(tokenModule.beginTokenRequest)
    .mockReset()
    .mockResolvedValue({ kind: 'error', message: 'stubbed in tests' })
  vi.mocked(tokenModule.awaitApproval).mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  // Each test calls plugin.stop() explicitly; this is a safety net to
  // make sure the global doesn't leak across tests.
  delete (globalThis as { __signalk_containerManager?: unknown }).__signalk_containerManager
})

describe('mayara-server-signalk-plugin container integration', () => {
  describe('startup ensureRunning call', () => {
    // Regression: 0.5.6 added signalk-plugin-enabled-by-default, which
    // makes Signal K call start() with `{}` on first install — schema
    // defaults are NOT injected. Without merging defaults at start()
    // time, `settings.managedContainer` would be undefined and the
    // container would never be started.
    it('starts the container even when start() is called with empty config', async () => {
      const containers = makeMockContainerManager()
      globalThis.__signalk_containerManager = containers
      const app = makeMockApp()
      vi.resetModules()
      const mod = (await import('../src/index')) as unknown as {
        default: (a: unknown) => LoadedPlugin['plugin']
      }
      const plugin = mod.default(app)
      plugin.registerWithRouter(makeRouter())

      plugin.start({})
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      expect(containers._calls.ensureRunning.length).toBe(1)
      const { config } = containers._calls.ensureRunning[0]
      expect(config.tag).toBe('latest')
      expect(config.resources).toBeDefined()
      await plugin.stop()
    })

    it('passes the default resource limits', async () => {
      const { containers, plugin } = await loadPlugin()
      expect(containers._calls.ensureRunning.length).toBe(1)
      const { config } = containers._calls.ensureRunning[0]
      expect(config.resources).toEqual({
        cpus: 2,
        memory: '512m',
        memorySwap: '512m',
        pidsLimit: 200
      })
      await plugin.stop()
    })

    it('declares the mayara image in-image UID/GID for correct uid mapping', async () => {
      // The mayara image runs as `mayara` (UID 1000). signalk-container
      // defaults inImageUid to 0 when this field is omitted; without the
      // explicit declaration the rootless-podman keep-id mapping would
      // put the container in the subuid range, and on docker / rootful
      // podman the in-container process would run under the SK host
      // user's UID instead of the image's mayara user — either way,
      // the in-image XDG data dir (owned by uid 1000 inside the image)
      // is unwritable and mayara fails to start.
      const { containers, plugin } = await loadPlugin()
      const { config } = containers._calls.ensureRunning[0]
      expect(config.user).toEqual({ inImageUid: 1000, inImageGid: 1000 })
      await plugin.stop()
    })

    it('opts into floating-tag auto-update in buildContainerConfig', async () => {
      // Without autoUpdateOnFloatingTag, a boat that started on
      // `:latest` six months ago keeps the cached image forever — the
      // image+tag string match in ensureRunning short-circuits before
      // any digest probe. Setting it true delegates pull + digest
      // compare + recreate-on-drift to signalk-container (≥1.9.0),
      // which silently skips the check on offline errors so boats
      // out of cell coverage still boot. Semver-pinned users are
      // unaffected because the floating-tag classifier skips them.
      const { containers, plugin } = await loadPlugin()
      const { config } = containers._calls.ensureRunning[0]
      expect(config.autoUpdateOnFloatingTag).toBe(true)
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

    it('awaits containers.whenReady() before calling ensureRunning', async () => {
      // signalk-container 1.6.0 exposes whenReady() as the canonical
      // "wait for runtime detection to settle" signal. Mayara must
      // await it before any other container API call, otherwise
      // ensureRunning would race against runtime probing on a cold
      // SK boot. Use vitest's invocationCallOrder to assert
      // whenReady was invoked strictly before ensureRunning.
      const { containers, plugin } = await loadPlugin()
      expect(containers.whenReady).toHaveBeenCalledTimes(1)
      const whenReadyOrder = (
        containers.whenReady as unknown as { mock: { invocationCallOrder: number[] } }
      ).mock.invocationCallOrder[0]
      const ensureRunningOrder = (
        containers.ensureRunning as unknown as { mock: { invocationCallOrder: number[] } }
      ).mock.invocationCallOrder[0]
      expect(whenReadyOrder).toBeLessThan(ensureRunningOrder)
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
        cpus: 2,
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

  describe('Signal K token integration', () => {
    it('starts in tcp: mode when no token is cached and request flow is disabled', async () => {
      const { containers, plugin } = await loadPlugin({ requestSignalkToken: false })
      const { config } = containers._calls.ensureRunning[0]
      expect(config.command?.[1]).toBe('-n')
      expect(config.command?.[2]).toMatch(/^tcp:127\.0\.0\.1:\d+$/)
      expect(config.command).not.toContain('--signalk-token-file')
      expect(config.env?.MAYARA_SIGNALK_TOKEN).toBeUndefined()
      expect(config.volumes).toBeUndefined()
      await plugin.stop()
    })

    it('starts in ws: mode with MAYARA_SIGNALK_TOKEN env var when a token is cached', async () => {
      // The plugin delivers the token via env, not a bind-mounted
      // file, so the in-container mayara user (uid 1000) can read it
      // regardless of the host file's owner. No host-path resolution
      // or bind-mount needed.
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.readCachedToken).mockReturnValue('cached-jwt-abc')

      // No app.config / no SSLPORT env → non-TLS default: plain ws:.
      const { containers, plugin } = await loadPlugin({ requestSignalkToken: true })
      const { config } = containers._calls.ensureRunning[0]
      const command = config.command ?? []
      expect(command).not.toContain('--signalk-token-file')
      // Plain ws → no cert-acceptance flag.
      expect(command).not.toContain('--accept-invalid-certs')
      const navIdx = command.indexOf('-n')
      expect(command[navIdx + 1]).toMatch(/^ws:127\.0\.0\.1:\d+$/)
      expect(config.env).toEqual({ MAYARA_SIGNALK_TOKEN: 'cached-jwt-abc' })
      // No bind mount needed for the token under env-var delivery.
      expect(config.volumes).toBeUndefined()

      vi.mocked(tokenModule.readCachedToken).mockReturnValue(undefined)
      await plugin.stop()
    })

    it('uses wss: + --accept-invalid-certs and the SSL port when SK has TLS enabled', async () => {
      // A TLS-enabled SK only serves wss:// (plain HTTP 302-redirects to
      // HTTPS, which mayara's discovery client can't follow). The
      // nav-address must therefore be wss: on the SSL port, with
      // --accept-invalid-certs for the self-signed loopback cert.
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.readCachedToken).mockReturnValue('cached-jwt-abc')

      const { containers, plugin } = await loadPlugin(
        { requestSignalkToken: true },
        { settings: { ssl: true, sslport: 8443 } }
      )
      const { config } = containers._calls.ensureRunning[0]
      const command = config.command ?? []
      const navIdx = command.indexOf('-n')
      expect(command[navIdx + 1]).toBe('wss:127.0.0.1:8443')
      expect(command).toContain('--accept-invalid-certs')
      expect(config.env).toEqual({ MAYARA_SIGNALK_TOKEN: 'cached-jwt-abc' })

      vi.mocked(tokenModule.readCachedToken).mockReturnValue(undefined)
      await plugin.stop()
    })

    it('falls back to the default SSL port 3443 when ssl is on but sslport is unset', async () => {
      // Locks in the getSslPort fallback (SSLPORT || sslport || 3443) so
      // a regression in the default doesn't go unnoticed.
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.readCachedToken).mockReturnValue('cached-jwt-abc')

      const { containers, plugin } = await loadPlugin(
        { requestSignalkToken: true },
        { settings: { ssl: true } }
      )
      const { config } = containers._calls.ensureRunning[0]
      const command = config.command ?? []
      const navIdx = command.indexOf('-n')
      expect(command[navIdx + 1]).toBe('wss:127.0.0.1:3443')
      expect(command).toContain('--accept-invalid-certs')

      vi.mocked(tokenModule.readCachedToken).mockReturnValue(undefined)
      await plugin.stop()
    })

    it('uses the configured non-SSL port from app.config when TLS is off', async () => {
      // Port must track the live SK config, not a frozen process.env.PORT
      // — the user switches the SK port on dev machines.
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.readCachedToken).mockReturnValue('cached-jwt-abc')

      const { containers, plugin } = await loadPlugin(
        { requestSignalkToken: true },
        { settings: { ssl: false, port: 3001 } }
      )
      const { config } = containers._calls.ensureRunning[0]
      const command = config.command ?? []
      const navIdx = command.indexOf('-n')
      expect(command[navIdx + 1]).toBe('ws:127.0.0.1:3001')
      expect(command).not.toContain('--accept-invalid-certs')

      vi.mocked(tokenModule.readCachedToken).mockReturnValue(undefined)
      await plugin.stop()
    })

    it('respects user-overridden -n by not injecting ws nor the token env var', async () => {
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.readCachedToken).mockReturnValue('cached-jwt-abc')

      const { containers, plugin } = await loadPlugin({
        requestSignalkToken: true,
        mayaraArgs: ['-n', 'tcp:0.0.0.0:9999']
      })
      const { config } = containers._calls.ensureRunning[0]
      expect(config.command?.filter((a) => a === '-n').length).toBe(1)
      expect(config.command).toContain('tcp:0.0.0.0:9999')
      expect(config.command).not.toContain('--signalk-token-file')
      // User explicitly chose a transport; don't shadow it with our
      // token env (mayara would still pick it up for the WS path if
      // the user navigated back to ws:, but the operator's explicit
      // override wins).
      expect(config.env?.MAYARA_SIGNALK_TOKEN).toBeUndefined()
      expect(config.volumes).toBeUndefined()

      vi.mocked(tokenModule.readCachedToken).mockReturnValue(undefined)
      await plugin.stop()
    })

    it('issues a beginTokenRequest when requestSignalkToken is true and no cache', async () => {
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.beginTokenRequest).mockResolvedValue({
        kind: 'pending',
        requestId: 'r-1',
        href: '/signalk/v1/requests/r-1'
      })

      const { plugin, app } = await loadPlugin({ requestSignalkToken: true })

      expect(tokenModule.beginTokenRequest).toHaveBeenCalledTimes(1)
      const call = vi.mocked(tokenModule.beginTokenRequest).mock.calls[0][0]
      expect(call.clientId).toBe('mayara-server-signalk-plugin')
      // Request `readwrite` so the cached token is broad enough for the
      // future radar/target/notification writeback features; the operator
      // approves once and we don't have to migrate later.
      expect(call.permissions).toBe('readwrite')
      // The "awaiting approval" status should appear so users see the
      // pending request without having to grep the debug log.
      expect(app.setPluginStatus).toHaveBeenCalledWith(
        expect.stringContaining('Awaiting Signal K token approval')
      )
      await plugin.stop()
    })

    it('does NOT issue a beginTokenRequest when requestSignalkToken is false', async () => {
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.beginTokenRequest).mockClear()

      const { plugin } = await loadPlugin({ requestSignalkToken: false })

      expect(tokenModule.beginTokenRequest).not.toHaveBeenCalled()
      await plugin.stop()
    })

    it('writes the token and recreates the container after admin approves', async () => {
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.beginTokenRequest).mockResolvedValue({
        kind: 'pending',
        requestId: 'r-1',
        href: '/signalk/v1/requests/r-1'
      })
      vi.mocked(tokenModule.awaitApproval).mockResolvedValue('approved-jwt')
      // After awaitApproval resolves, the plugin writes the token and
      // re-calls ensureRunning. The second call's buildContainerConfig
      // must see the cached token via readCachedToken so the new config
      // delivers it via env + uses ws: transport.
      let cached: string | undefined
      vi.mocked(tokenModule.readCachedToken).mockImplementation(() => cached)
      vi.mocked(tokenModule.writeCachedToken).mockImplementation((_dir, token) => {
        cached = token
      })

      const { plugin, containers } = await loadPlugin({ requestSignalkToken: true })

      // Give the awaitApproval / writeCachedToken / ensureRunning chain
      // time to settle. Same shape as the existing loadPlugin wait.
      await new Promise<void>((resolve) => setTimeout(resolve, 100))

      // Should have called writeCachedToken once with the approved token.
      expect(tokenModule.writeCachedToken).toHaveBeenCalledWith(expect.any(String), 'approved-jwt')
      // ensureRunning called twice: first with tcp config (no token yet),
      // then with ws config after the token landed.
      expect(containers._calls.ensureRunning.length).toBeGreaterThanOrEqual(2)
      const lastCall = containers._calls.ensureRunning[containers._calls.ensureRunning.length - 1]
      expect(lastCall.config.env?.MAYARA_SIGNALK_TOKEN).toBe('approved-jwt')
      const lastCmd = lastCall.config.command ?? []
      const navIdx = lastCmd.indexOf('-n')
      expect(lastCmd[navIdx + 1]).toMatch(/^ws:127\.0\.0\.1:\d+$/)

      vi.mocked(tokenModule.readCachedToken).mockReturnValue(undefined)
      await plugin.stop()
    })

    it('surfaces a status hint when device access requests are disabled', async () => {
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.beginTokenRequest).mockResolvedValue({
        kind: 'requests-disabled'
      })

      const { plugin, app } = await loadPlugin({ requestSignalkToken: true })

      expect(app.setPluginStatus).toHaveBeenCalledWith(
        expect.stringContaining('device access requests are disabled')
      )
      await plugin.stop()
    })
  })

  describe('GUI reverse proxy mount', () => {
    it('mounts the mayara GUI proxy at /gui via router.use', async () => {
      // Regression guard: without this mount, clicking the radar icon
      // in the SK admin would fall back to opening mayara's :6502
      // directly, breaking single-port and SSL deployments.
      const { router, plugin } = await loadPlugin()
      expect(router.mounts).toContain('/gui')
      await plugin.stop()
    })

    it('wires fixRequestBody on proxyReq to re-stream body-parser-consumed JSON', () => {
      // SK mounts express.json() before the plugin router, which drains
      // the request stream into req.body. Without re-streaming, every
      // PUT/POST through the GUI proxy hangs until the client times
      // out (HTTP 000) — the upstream socket has the right
      // Content-Length but zero body bytes. fixRequestBody (a public
      // export of http-proxy-middleware) re-serializes req.body and
      // writes it to the ClientRequest. This static guard catches
      // accidental removal — radar control PUTs would silently break
      // and the radar would stay in standby with no obvious error.
      const source = readFileSync(join(__dirname, '../src/index.ts'), 'utf-8')
      expect(source).toMatch(/proxyReq:\s*fixRequestBody/)
      expect(source).toMatch(/from\s+['"]http-proxy-middleware['"]/)
      expect(source).toMatch(/\bfixRequestBody\b/)
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

  it('src/index.ts does not import fs (hash-file pattern is obsolete)', () => {
    // signalk-container ≥1.6.0 handles ContainerConfig drift centrally.
    // Re-introducing fs imports here is almost always a sign someone
    // is about to add another local hash file or sidecar marker.
    const source = readFileSync(join(__dirname, '../src/index.ts'), 'utf-8')
    expect(source).not.toMatch(/from\s+['"]fs['"]/)
    expect(source).not.toMatch(/require\s*\(\s*['"]fs['"]/)
  })
})
