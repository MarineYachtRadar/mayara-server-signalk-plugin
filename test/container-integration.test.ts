import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync } from 'fs'
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
  // A `new`-able stand-in. `vi.fn().mockImplementation(() => ({...}))`
  // returns an arrow function, which throws "is not a constructor" when
  // the plugin does `new MayaraClient(...)`, so use a plain function.
  function MayaraClient() {
    return {
      getRadars: vi.fn().mockResolvedValue({}),
      getCapabilities: vi.fn().mockResolvedValue({}),
      close: vi.fn(),
      getSpokeStreamUrl: vi.fn().mockReturnValue('ws://localhost:6502/x'),
      getTargetStreamUrl: vi.fn().mockReturnValue('ws://localhost:6502/y'),
      getStateStreamUrl: vi.fn().mockReturnValue('ws://localhost:6502/signalk/v1/stream')
    }
  }
  return { MayaraClient }
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
    deleteCachedToken: vi.fn(),
    // Default: a cached token (when present) validates fine, so existing
    // tests are unaffected. Revocation tests override per-call.
    validateCachedToken: vi.fn(() => Promise.resolve('valid' as const)),
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
  vi.mocked(tokenModule.deleteCachedToken).mockReset()
  vi.mocked(tokenModule.validateCachedToken).mockReset().mockResolvedValue('valid')
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
      const call = vi.mocked(containers.updates.sources.githubReleases).mock.calls[0]
      expect(call[0]).toBe('MarineYachtRadar/mayara-server')
      // Second arg is the options object carrying the (optional) token.
      expect(call[1]).toHaveProperty('token')
      await plugin.stop()
    })

    it('passes the GitHub token into the update source when one is available', async () => {
      const saved = process.env.GITHUB_TOKEN
      process.env.GITHUB_TOKEN = 'ghp_update_test'
      try {
        const { containers, plugin } = await loadPlugin()
        expect(containers.updates.sources.githubReleases).toHaveBeenCalledWith(
          'MarineYachtRadar/mayara-server',
          { token: 'ghp_update_test' }
        )
        await plugin.stop()
      } finally {
        if (saved === undefined) delete process.env.GITHUB_TOKEN
        else process.env.GITHUB_TOKEN = saved
      }
    })

    it('passes token undefined (unauthenticated, no regression) when none is available', async () => {
      const savedGithub = process.env.GITHUB_TOKEN
      const savedGh = process.env.GH_TOKEN
      delete process.env.GITHUB_TOKEN
      delete process.env.GH_TOKEN
      rmSync(join('/tmp/mayara-test', 'github-token'), { force: true })
      try {
        const { containers, plugin } = await loadPlugin()
        expect(containers.updates.sources.githubReleases).toHaveBeenCalledWith(
          'MarineYachtRadar/mayara-server',
          { token: undefined }
        )
        await plugin.stop()
      } finally {
        if (savedGithub !== undefined) process.env.GITHUB_TOKEN = savedGithub
        if (savedGh !== undefined) process.env.GH_TOKEN = savedGh
      }
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

      // The startup connect path also calls checkOne (to surface the
      // update hint); clear it so this asserts only the route's call.
      containers._calls.updateCheckOne = []

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

  describe('update-available status hint', () => {
    it('appends an update hint to the Connected status when one is available', async () => {
      const containers = makeMockContainerManager()
      containers._nextCheckResult = {
        pluginId: 'mayara-server-signalk-plugin',
        containerName: 'mayara-server',
        runningTag: 'main',
        tagKind: 'floating',
        currentVersion: null,
        latestVersion: null,
        updateAvailable: true,
        reason: 'digest-drift',
        checkedAt: '2026-06-01T00:00:00.000Z',
        lastSuccessfulCheckAt: '2026-06-01T00:00:00.000Z',
        fromCache: false
      }
      globalThis.__signalk_containerManager = containers
      const app = makeMockApp()
      vi.resetModules()
      const mod = (await import('../src/index')) as unknown as {
        default: (a: unknown) => { start: (c: unknown) => void; stop: () => void | Promise<void> }
      }
      const plugin = mod.default(app)
      plugin.start({ managedContainer: true, mayaraVersion: 'main', requestSignalkToken: false })
      // Allow the connect + async refreshUpdateHint().then() chain to settle.
      await new Promise<void>((resolve) => setTimeout(resolve, 80))

      const statuses = app.setPluginStatus.mock.calls.map((c) => c[0] as string)
      expect(statuses.some((s) => s.includes('update available'))).toBe(true)
      await plugin.stop()
    })

    it('does not append a hint when no update is available', async () => {
      // Default mock checkOne returns updateAvailable: false.
      const { app, plugin } = await loadPlugin({ mayaraVersion: 'main' })
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
      const statuses = app.setPluginStatus.mock.calls.map((c) => c[0] as string)
      expect(statuses.some((s) => s.startsWith('Connected'))).toBe(true)
      expect(statuses.some((s) => s.includes('update available'))).toBe(false)
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

  describe('GET /api/versions', () => {
    // The route does a real `fetch` against GitHub; stub it with a
    // URL-discriminating implementation so each test controls both sources.
    // CI (GitHub Actions) injects GITHUB_TOKEN into the environment, which
    // readGithubToken would pick up — delete both here so the auth/no-auth
    // cases are deterministic, and restore whatever CI set afterwards.
    let savedGithubToken: string | undefined
    let savedGhToken: string | undefined
    beforeEach(() => {
      savedGithubToken = process.env.GITHUB_TOKEN
      savedGhToken = process.env.GH_TOKEN
      delete process.env.GITHUB_TOKEN
      delete process.env.GH_TOKEN
      // makeMockApp hardcodes getDataDirPath() => '/tmp/mayara-test' (a
      // shared path, not an isolated temp dir). readGithubToken falls back
      // to a github-token FILE there, so remove any stray one to keep the
      // no-token / auth-header cases hermetic regardless of ambient state.
      rmSync(join('/tmp/mayara-test', 'github-token'), { force: true })
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = savedGithubToken
      if (savedGhToken === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = savedGhToken
    })

    // Captured (url, init) tuples so tests can assert request headers.
    let fetchCalls: { url: string; init?: { headers?: Record<string, string> } }[]

    function stubFetch(impl: (url: string, init?: unknown) => Promise<unknown>) {
      fetchCalls = []
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: { headers?: Record<string, string> }) => {
          fetchCalls.push({ url, init })
          return impl(url, init)
        })
      )
    }

    // Responses carry a headers.get() so the classify() rate-limit check
    // (headers.get('x-ratelimit-remaining')) never throws on a stub.
    const okJson = (body: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve(body)
      })

    // GitHub's primary-rate-limit signature: 403 with remaining == '0'.
    const rateLimited = (status = 403) =>
      Promise.resolve({
        ok: false,
        status,
        headers: {
          get: (h: string) => (h === 'x-ratelimit-remaining' ? '0' : null)
        },
        json: () => Promise.resolve([])
      })

    it('merges release tags and labeled open PRs, skipping unlabeled PRs', async () => {
      stubFetch((url) => {
        if (url.includes('/releases')) {
          return okJson([
            { tag_name: 'v3.4.0', prerelease: false, draft: false },
            { tag_name: 'v3.5.0-rc1', prerelease: true, draft: false },
            { tag_name: 'v3.3.0-draft', prerelease: false, draft: true }
          ])
        }
        if (url.includes('/pulls')) {
          return okJson([
            { number: 123, title: 'Fix gain', labels: [{ name: 'build-image' }] },
            { number: 99, title: 'WIP', labels: [] }
          ])
        }
        return Promise.reject(new Error(`unexpected url: ${url}`))
      })

      const { router, plugin } = await loadPlugin()
      const handler = getHandler(router, 'GET /api/versions')
      const res = makeRes()
      await handler({}, res)

      expect(res.statusCode).toBe(200)
      const body = res.body as {
        versions: { tag: string; prerelease?: boolean; pr?: number; title?: string }[]
        sources: { releases: string; prImages: string }
      }
      expect(body.versions).toContainEqual({ tag: 'v3.4.0', prerelease: false })
      expect(body.versions).toContainEqual({ tag: 'v3.5.0-rc1', prerelease: true })
      expect(body.versions).toContainEqual({ tag: 'pr123', pr: 123, title: 'Fix gain' })
      // draft release filtered out
      expect(body.versions.some((v) => v.tag === 'v3.3.0-draft')).toBe(false)
      // unlabeled PR filtered out
      expect(body.versions.some((v) => v.tag === 'pr99')).toBe(false)
      expect(body.sources).toEqual({ releases: 'ok', prImages: 'ok' })
      await plugin.stop()
    })

    it('records prImages as rate-limited when /pulls is throttled but keeps releases (the boat bug)', async () => {
      stubFetch((url) => {
        if (url.includes('/releases')) {
          return okJson([{ tag_name: 'v3.4.0', prerelease: false, draft: false }])
        }
        return rateLimited()
      })

      const { router, plugin } = await loadPlugin()
      const handler = getHandler(router, 'GET /api/versions')
      const res = makeRes()
      await handler({}, res)

      expect(res.statusCode).toBe(200)
      const body = res.body as {
        versions: { tag: string }[]
        sources: { releases: string; prImages: string }
      }
      expect(body.versions).toContainEqual({ tag: 'v3.4.0', prerelease: false })
      expect(body.versions.some((v) => v.tag.startsWith('pr'))).toBe(false)
      // The failure is RECORDED, not silently dropped, so the panel can
      // say "rate-limited, retry" instead of implying no PR images exist.
      expect(body.sources).toEqual({ releases: 'ok', prImages: 'rate-limited' })
      await plugin.stop()
    })

    it('records a generic error (not rate-limited) when /pulls rejects', async () => {
      stubFetch((url) => {
        if (url.includes('/releases')) {
          return okJson([{ tag_name: 'v3.4.0', prerelease: false, draft: false }])
        }
        return Promise.reject(new Error('network down'))
      })

      const { router, plugin } = await loadPlugin()
      const handler = getHandler(router, 'GET /api/versions')
      const res = makeRes()
      await handler({}, res)

      expect(res.statusCode).toBe(200)
      const body = res.body as { sources: { releases: string; prImages: string } }
      expect(body.sources).toEqual({ releases: 'ok', prImages: 'error' })
      await plugin.stop()
    })

    it('returns 502 with per-source status when both sources are rate-limited', async () => {
      stubFetch(() => rateLimited())

      const { router, plugin } = await loadPlugin()
      const handler = getHandler(router, 'GET /api/versions')
      const res = makeRes()
      await handler({}, res)

      expect(res.statusCode).toBe(502)
      const body = res.body as { error: string; sources: { releases: string; prImages: string } }
      expect(body.sources).toEqual({ releases: 'rate-limited', prImages: 'rate-limited' })
      await plugin.stop()
    })

    it('sends an Authorization header on both calls when a GitHub token is set', async () => {
      process.env.GITHUB_TOKEN = 'ghp_test'
      stubFetch(() => okJson([]))

      const { router, plugin } = await loadPlugin()
      const handler = getHandler(router, 'GET /api/versions')
      await handler({}, makeRes())

      expect(fetchCalls).toHaveLength(2)
      for (const call of fetchCalls) {
        expect(call.init?.headers?.Authorization).toBe('Bearer ghp_test')
        expect(call.init?.headers?.Accept).toBe('application/vnd.github+json')
      }
      await plugin.stop()
    })

    it('sends no Authorization header when no GitHub token is available', async () => {
      stubFetch(() => okJson([]))

      const { router, plugin } = await loadPlugin()
      const handler = getHandler(router, 'GET /api/versions')
      await handler({}, makeRes())

      expect(fetchCalls).toHaveLength(2)
      for (const call of fetchCalls) {
        expect(call.init?.headers?.Authorization).toBeUndefined()
      }
      await plugin.stop()
    })

    it('retries without the token when a present token is rejected (401), so a bad token is never worse than none', async () => {
      process.env.GITHUB_TOKEN = 'ghp_expired'
      // Authenticated calls 401; the unauthenticated retry succeeds. The
      // retry must return the shape matching each URL (releases vs pulls),
      // or the pulls handler would choke on release-shaped data.
      stubFetch((url, init) => {
        const headers = (init as { headers?: Record<string, string> } | undefined)?.headers
        const authed = !!headers?.Authorization
        if (authed) {
          return Promise.resolve({
            ok: false,
            status: 401,
            headers: { get: () => null },
            json: () => Promise.resolve([])
          })
        }
        if (url.includes('/releases')) {
          return okJson([{ tag_name: 'v3.4.0', prerelease: false, draft: false }])
        }
        return okJson([])
      })

      const { router, plugin } = await loadPlugin()
      const handler = getHandler(router, 'GET /api/versions')
      const res = makeRes()
      await handler({}, res)

      // 2 authenticated + 2 retries = 4 calls; the last two carry no auth.
      expect(fetchCalls).toHaveLength(4)
      const retries = fetchCalls.filter((c) => !c.init?.headers?.Authorization)
      expect(retries).toHaveLength(2)
      // The retry populated the list — strictly better than the 502 the
      // un-retried authenticated 401s would have produced.
      expect(res.statusCode).toBe(200)
      const body = res.body as { versions: { tag: string }[]; sources: { releases: string } }
      expect(body.versions).toContainEqual({ tag: 'v3.4.0', prerelease: false })
      expect(body.sources.releases).toBe('ok')
      await plugin.stop()
    })

    it('classifies a non-rate-limit failure (500) as error, not rate-limited', async () => {
      // 500 with no x-ratelimit-remaining header must NOT be mislabeled
      // "rate-limited, retry shortly" — that would tell the operator to
      // wait when the real problem is a server error.
      stubFetch((url) => {
        if (url.includes('/releases')) {
          return okJson([{ tag_name: 'v3.4.0', prerelease: false, draft: false }])
        }
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: { get: () => null },
          json: () => Promise.resolve([])
        })
      })

      const { router, plugin } = await loadPlugin()
      const handler = getHandler(router, 'GET /api/versions')
      const res = makeRes()
      await handler({}, res)

      const body = res.body as { sources: { releases: string; prImages: string } }
      expect(body.sources).toEqual({ releases: 'ok', prImages: 'error' })
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

    it('re-requests on the reconnect cadence after a recoverable failure', async () => {
      // A recoverable outcome (here: device requests disabled) should not be
      // terminal — the operator may enable requests later, so the plugin
      // re-attempts on the reconnect cadence without needing a restart.
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.beginTokenRequest).mockResolvedValue({
        kind: 'requests-disabled'
      })

      // Tiny reconnect interval so several recovery attempts fire quickly.
      const { plugin } = await loadPlugin({
        requestSignalkToken: true,
        reconnectInterval: 0.01
      })

      // Let a few recovery cycles run.
      await new Promise<void>((resolve) => setTimeout(resolve, 80))
      expect(vi.mocked(tokenModule.beginTokenRequest).mock.calls.length).toBeGreaterThan(1)
      await plugin.stop()
    })

    it('stops re-requesting once the plugin is stopped', async () => {
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.beginTokenRequest).mockResolvedValue({
        kind: 'requests-disabled'
      })

      const { plugin } = await loadPlugin({
        requestSignalkToken: true,
        reconnectInterval: 0.01
      })
      await plugin.stop()
      const countAfterStop = vi.mocked(tokenModule.beginTokenRequest).mock.calls.length

      // No further attempts should accrue after stop() flips the cancel flag.
      await new Promise<void>((resolve) => setTimeout(resolve, 80))
      expect(vi.mocked(tokenModule.beginTokenRequest).mock.calls.length).toBe(countAfterStop)
    })

    it('drops a revoked cached token and re-requests', async () => {
      const tokenModule = await loadTokenMock()
      // A token is on disk, but the server has revoked it.
      vi.mocked(tokenModule.readCachedToken).mockReturnValue('revoked-jwt')
      vi.mocked(tokenModule.validateCachedToken).mockResolvedValue('revoked')
      vi.mocked(tokenModule.beginTokenRequest).mockResolvedValue({
        kind: 'pending',
        requestId: 'r-1',
        href: '/signalk/v1/requests/r-1'
      })

      const { plugin, app } = await loadPlugin({ requestSignalkToken: true })

      // The dead token is dropped and a fresh request is issued rather than
      // the plugin trusting the cache forever.
      expect(tokenModule.deleteCachedToken).toHaveBeenCalledTimes(1)
      expect(tokenModule.beginTokenRequest).toHaveBeenCalledTimes(1)
      expect(app.setPluginStatus).toHaveBeenCalledWith(expect.stringContaining('revoked'))
      await plugin.stop()
    })

    it('keeps a valid cached token without re-requesting', async () => {
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.readCachedToken).mockReturnValue('good-jwt')
      vi.mocked(tokenModule.validateCachedToken).mockResolvedValue('valid')

      const { plugin } = await loadPlugin({ requestSignalkToken: true })

      // A still-valid token short-circuits: no delete, no new request.
      expect(tokenModule.deleteCachedToken).not.toHaveBeenCalled()
      expect(tokenModule.beginTokenRequest).not.toHaveBeenCalled()
      await plugin.stop()
    })

    it('does not POST again when SK reports a request already pending', async () => {
      const tokenModule = await loadTokenMock()
      vi.mocked(tokenModule.beginTokenRequest).mockResolvedValue({
        kind: 'already-pending'
      })

      const { plugin, app } = await loadPlugin({
        requestSignalkToken: true,
        reconnectInterval: 0.01
      })
      // It surfaces "awaiting approval" and waits — it does NOT call
      // awaitApproval on a non-existent href, and recovery just re-checks.
      expect(app.setPluginStatus).toHaveBeenCalledWith(
        expect.stringContaining('Awaiting Signal K token approval')
      )
      expect(tokenModule.awaitApproval).not.toHaveBeenCalled()
      await plugin.stop()
    })

    it('a token loop superseded by stop()+start() does not keep requesting', async () => {
      const tokenModule = await loadTokenMock()
      // The first loop opens a request and blocks in awaitApproval until its
      // generation is cancelled — modelling an admin who hasn't approved yet.
      vi.mocked(tokenModule.beginTokenRequest).mockResolvedValue({
        kind: 'pending',
        requestId: 'r-1',
        href: '/signalk/v1/requests/r-1'
      })
      vi.mocked(tokenModule.awaitApproval).mockImplementation(
        (_href, _port, isCancelled: () => boolean) =>
          new Promise((resolve) => {
            const timer = setInterval(() => {
              if (isCancelled()) {
                clearInterval(timer)
                resolve(undefined)
              }
            }, 5)
          })
      )

      const { plugin, app } = await loadPlugin({
        requestSignalkToken: true,
        reconnectInterval: 0.01
      })

      // Restart: stop() then start() bump the generation twice. The original
      // loop's awaitApproval is now cancelled and must not resume/re-POST.
      await plugin.stop()
      const callsAfterRestart = vi.mocked(tokenModule.beginTokenRequest).mock.calls.length
      plugin.start({
        managedContainer: true,
        mayaraVersion: 'latest',
        mayaraArgs: [],
        requestSignalkToken: false, // the new generation doesn't request
        host: 'localhost',
        port: 6502,
        secure: false,
        discoveryPollInterval: 10,
        reconnectInterval: 5
      })
      await new Promise((resolve) => setTimeout(resolve, 80))

      // The superseded loop exited rather than looping into more POSTs.
      expect(vi.mocked(tokenModule.beginTokenRequest).mock.calls.length).toBe(callsAfterRestart)
      void app
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
