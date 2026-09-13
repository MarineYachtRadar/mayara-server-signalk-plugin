import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Controls are settings, not measurements: mayara emits one when it changes
// and then stays quiet. Under signalk-server's stale-data enforcement (60 s by
// default) every control on an idle radar was blanked to null a minute after
// the last change — range, gain and autoStandby vanished from the Data Browser
// while the radar was working normally.
//
// The fix declares `timeout: 0` for each control path via setDefaultMetadata,
// the supported way for a plugin to state stale-data behaviour for paths it
// publishes (SignalK/signalk-server#3025). These tests pin that it happens for
// every control, that a server without the method still gets its PUT handlers,
// and that the declaration is a separate call rather than delta metadata —
// which the server does not consult when resolving a timeout.

const RADAR_ID = 'fur6424A'
// autoStandby is the control from the reported incident; the other two are
// ordinary settings that go equally quiet.
const CONTROLS = { autoStandby: 1, range: 1852, gain: 'auto' }

vi.mock('../src/mayara-client.js', () => {
  function MayaraClient() {
    return {
      getRadars: vi.fn().mockResolvedValue({ [RADAR_ID]: {} }),
      getCapabilities: vi.fn().mockResolvedValue({}),
      getControls: vi.fn().mockResolvedValue(CONTROLS),
      setControl: vi.fn().mockResolvedValue({}),
      close: vi.fn(),
      getSpokeStreamUrl: vi.fn().mockReturnValue('ws://localhost:6502/spokes'),
      getTargetStreamUrl: vi.fn().mockReturnValue('ws://localhost:6502/targets'),
      getStateStreamUrl: vi.fn().mockReturnValue('ws://localhost:6502/signalk/v1/stream')
    }
  }
  return { MayaraClient }
})

vi.mock('../src/radar-provider.js', () => ({
  createRadarProvider: vi.fn().mockReturnValue({})
}))

// The forwarders open real sockets on start(); stub them out.
vi.mock('../src/delta-forwarder.js', () => ({
  DeltaForwarder: function () {
    return { start: vi.fn(), stop: vi.fn() }
  }
}))
vi.mock('../src/spoke-forwarder.js', () => ({
  SpokeForwarder: function () {
    return { start: vi.fn(), stop: vi.fn() }
  }
}))

interface Recorded {
  metadata: Array<{ path: string; value: Record<string, unknown> }>
  putPaths: string[]
}

// Minimal app stub. `setDefaultMetadata` is optional so one test can drop it
// and stand in for a server predating the method.
function makeApp(opts: { withSetDefaultMetadata?: boolean } = {}): {
  app: Record<string, unknown>
  rec: Recorded
} {
  const rec: Recorded = { metadata: [], putPaths: [] }
  const app: Record<string, unknown> = {
    debug: vi.fn(),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn(),
    getDataDirPath: () => '/tmp/mayara-staleness-test',
    savePluginOptions: vi.fn((_c: unknown, cb: (e: null) => void) => {
      cb(null)
    }),
    handleMessage: vi.fn(),
    registerPutHandler: vi.fn((_ctx: string, path: string) => {
      rec.putPaths.push(path)
    }),
    radarApi: { register: vi.fn(), unRegister: vi.fn() },
    binaryStreamManager: undefined
  }
  if (opts.withSetDefaultMetadata !== false) {
    app.setDefaultMetadata = vi.fn((path: string, value: Record<string, unknown>) => {
      rec.metadata.push({ path, value })
      return Promise.resolve(true)
    })
  }
  return { app, rec }
}

// Start the plugin against a stub app and let the discovery microtasks settle.
// registerControlPutHandlers is fire-and-forget (`void`), so the assertions
// need a turn of the event loop, not just an await on start().
async function startPlugin(app: Record<string, unknown>): Promise<{ stop: () => void }> {
  const factory = (await import('../src/index.js')).default
  const plugin = factory(app as never)
  // start() is declared void; the discovery it kicks off is what the
  // assertions wait on below.
  plugin.start({ managedContainer: false })
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return plugin
}

describe('control paths are exempted from stale-data enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('declares timeout: 0 for every control on a discovered radar', async () => {
    const { app, rec } = makeApp()
    const plugin = await startPlugin(app)

    for (const controlId of Object.keys(CONTROLS)) {
      const path = `radars.${RADAR_ID}.controls.${controlId}`
      const entry = rec.metadata.find((m) => m.path === path)
      expect(entry, `no metadata declared for ${path}`).toBeDefined()
      // 0 disables enforcement; anything else leaves the path expiring.
      expect(entry?.value.timeout).toBe(0)
    }
    plugin.stop()
  })

  it('covers autoStandby, the control from the reported incident', async () => {
    const { app, rec } = makeApp()
    const plugin = await startPlugin(app)

    const path = `radars.${RADAR_ID}.controls.autoStandby`
    expect(rec.metadata.map((m) => m.path)).toContain(path)
    plugin.stop()
  })

  it('still registers PUT handlers when the server has no setDefaultMetadata', async () => {
    // A server predating SignalK/signalk-server#3025 has no such method, so the
    // call throws TypeError. That must not abort registration of the PUT
    // handler that follows it — the paths would otherwise become unwritable.
    const { app, rec } = makeApp({ withSetDefaultMetadata: false })
    const plugin = await startPlugin(app)

    for (const controlId of Object.keys(CONTROLS)) {
      expect(rec.putPaths).toContain(`radars.${RADAR_ID}.controls.${controlId}`)
    }
    plugin.stop()
  })

  it('declares metadata out of band, not as delta metadata', async () => {
    // The server does not consult metadata attached to individual deltas when
    // resolving a timeout, so a `meta` key riding along on handleMessage would
    // look right and do nothing.
    const { app, rec } = makeApp()
    const plugin = await startPlugin(app)

    expect(rec.metadata.length).toBeGreaterThan(0)
    const handleMessage = app.handleMessage as ReturnType<typeof vi.fn>
    const metaDeltas = handleMessage.mock.calls.filter((call) =>
      JSON.stringify(call[1] ?? {}).includes('"timeout"')
    )
    expect(metaDeltas).toHaveLength(0)
    plugin.stop()
  })
})
