import { describe, it, expect, vi } from 'vitest'
import { createRadarProvider } from '../src/radar-provider'
import { MayaraClient } from '../src/mayara-client'
import { MayaraServerAPI } from '../src/types'

function createMockClient(overrides: Partial<MayaraClient> = {}): MayaraClient {
  return {
    getRadars: vi.fn().mockResolvedValue({
      'radar-0': {
        brand: 'Furuno',
        model: 'DRS4D-NXT',
        name: 'DRS4D-NXT 6424',
        radarIpAddress: '10.0.0.5'
      },
      'radar-1': { brand: 'Navico', model: 'HALO', name: 'HALO 034A' }
    }),
    getCapabilities: vi.fn().mockResolvedValue({
      spokesPerRevolution: 8192,
      maxSpokeLength: 883,
      pixelValues: 64
    }),
    getControls: vi.fn().mockResolvedValue({
      power: { value: 2 },
      range: { value: 3000 },
      gain: { auto: false, value: 50 }
    }),
    setControl: vi.fn().mockResolvedValue({ success: true }),
    setControls: vi.fn().mockResolvedValue({ success: true }),
    getTargets: vi.fn().mockResolvedValue({ targets: [] }),
    acquireTarget: vi.fn().mockResolvedValue({ targetId: 1, radarId: 'radar-0' }),
    cancelTarget: vi.fn().mockResolvedValue({}),
    getSpokeStreamUrl: vi
      .fn()
      .mockReturnValue('ws://localhost:6502/signalk/v2/api/vessels/self/radars/radar-0/spokes'),
    getTargetStreamUrl: vi
      .fn()
      .mockReturnValue(
        'ws://localhost:6502/signalk/v2/api/vessels/self/radars/radar-0/targets/stream'
      ),
    close: vi.fn(),
    request: vi.fn(),
    ...overrides
  } as unknown as MayaraClient
}

function createMockApp(): MayaraServerAPI {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn()
  } as unknown as MayaraServerAPI
}

describe('createRadarProvider', () => {
  it('getRadars returns radar IDs from client', async () => {
    const client = createMockClient()
    const provider = createRadarProvider(client, createMockApp())

    const ids = await provider.getRadars()
    expect(ids).toEqual(['radar-0', 'radar-1'])
  })

  it('getRadars returns empty on error', async () => {
    const client = createMockClient({
      getRadars: vi.fn().mockRejectedValue(new Error('connection refused'))
    })
    const provider = createRadarProvider(client, createMockApp())

    const ids = await provider.getRadars()
    expect(ids).toEqual([])
  })

  it('getRadarInfo returns the lean discovery object (no live state)', async () => {
    const client = createMockClient()
    const provider = createRadarProvider(client, createMockApp())

    const info = await provider.getRadarInfo('radar-0')
    expect(info).not.toBeNull()
    if (info) {
      expect(info.name).toBe('DRS4D-NXT 6424')
      expect(info.brand).toBe('Furuno')
      expect(info.model).toBe('DRS4D-NXT')
      expect(info.radarIpAddress).toBe('10.0.0.5')
      // spokeDataUrl/streamUrl omitted so clients use signalk-server's own
      // endpoints; live state (status/controls) lives on getState, not here.
      expect(info.spokeDataUrl).toBeUndefined()
      expect(info.streamUrl).toBeUndefined()
      expect('status' in info).toBe(false)
      expect('controls' in info).toBe(false)
    }
  })

  it('getState forwards the full normalized control set', async () => {
    const client = createMockClient({
      getControls: vi.fn().mockResolvedValue({
        power: { value: 2 },
        range: { value: 3000 },
        gain: { auto: false, value: 50 },
        sea: { auto: true, value: 30 },
        rain: { value: 10 },
        // mayara serves enum/list controls as their label string, not a number.
        targetTrails: { value: 'Medium' },
        mode: { value: 'dopplerNormal' },
        // and on/off controls as booleans.
        interferenceRejection: { value: true }
      })
    })
    const provider = createRadarProvider(client, createMockApp())

    const state = await provider.getState('radar-0')
    expect(state).not.toBeNull()
    if (state) {
      expect(state.status).toBe('transmit')
      expect(state.controls.gain).toEqual({ auto: false, value: 50 })
      expect(state.controls.sea).toEqual({ auto: true, value: 30 })
      expect(state.controls.rain).toEqual({ value: 10 })
      // Non-numeric controls pass through verbatim instead of being dropped.
      expect(state.controls.targetTrails).toEqual({ value: 'Medium' })
      expect(state.controls.mode).toEqual({ value: 'dopplerNormal' })
      expect(state.controls.interferenceRejection).toEqual({ value: true })
    }
  })

  it('getState does not staple auto onto a string-valued auto-capable control', async () => {
    const client = createMockClient({
      getControls: vi.fn().mockResolvedValue({
        power: { value: 2 },
        gain: { value: 40 },
        // A radar that reports sea as an enum ("Off"/"Harbour"/...) rather than a level:
        // it must forward as-is, never gain a spurious { auto: false }.
        sea: { value: 'Harbour' }
      })
    })
    const provider = createRadarProvider(client, createMockApp())

    const state = await provider.getState('radar-0')
    expect(state).not.toBeNull()
    if (state) {
      expect(state.controls.gain).toEqual({ auto: false, value: 40 })
      expect(state.controls.sea).toEqual({ value: 'Harbour' })
    }
  })

  it('getState defaults auto on gain and sea when mayara omits it', async () => {
    const client = createMockClient({
      getControls: vi.fn().mockResolvedValue({
        power: { value: 2 },
        gain: { value: 40 },
        sea: { value: 20 },
        rain: { value: 10 }
      })
    })
    const provider = createRadarProvider(client, createMockApp())

    const state = await provider.getState('radar-0')
    expect(state).not.toBeNull()
    if (state) {
      expect(state.controls.gain).toEqual({ auto: false, value: 40 })
      expect(state.controls.sea).toEqual({ auto: false, value: 20 })
      expect(state.controls.rain).toEqual({ value: 10 })
    }
  })

  it('getRadarInfo returns null for unknown radar', async () => {
    const client = createMockClient()
    const provider = createRadarProvider(client, createMockApp())

    const info = await provider.getRadarInfo('nonexistent')
    expect(info).toBeNull()
  })

  it('getState derives status from power control value', async () => {
    const client = createMockClient()
    const provider = createRadarProvider(client, createMockApp())

    const state = await provider.getState?.('radar-0')
    expect(state).not.toBeNull()
    if (state) {
      expect(state.status).toBe('transmit')
      expect(state.controls.power).toEqual({ value: 2 })
    }
  })

  it('setPower proxies to client', async () => {
    const setControlFn = vi.fn().mockResolvedValue({ success: true })
    const client = createMockClient({
      setControl: setControlFn
    })
    const provider = createRadarProvider(client, createMockApp())

    const result = await provider.setPower?.('radar-0', 'transmit')
    expect(result).toBe(true)
    expect(setControlFn).toHaveBeenCalledWith('radar-0', 'power', 'transmit')
  })

  it('setPower returns false on error', async () => {
    const client = createMockClient({
      setControl: vi.fn().mockRejectedValue(new Error('timeout'))
    })
    const provider = createRadarProvider(client, createMockApp())

    const result = await provider.setPower?.('radar-0', 'transmit')
    expect(result).toBe(false)
  })

  it('setControl returns success object', async () => {
    const client = createMockClient()
    const provider = createRadarProvider(client, createMockApp())

    const result = await provider.setControl?.('radar-0', 'gain', 42)
    expect(result).toEqual({ success: true })
  })

  it('acquireTarget returns targetId on success', async () => {
    const client = createMockClient()
    const provider = createRadarProvider(client, createMockApp())

    const result = await provider.acquireTarget?.('radar-0', 45.0, 1000)
    expect(result).toEqual({ success: true, targetId: 1 })
  })

  it('cancelTarget returns true on success', async () => {
    const client = createMockClient()
    const provider = createRadarProvider(client, createMockApp())

    const result = await provider.cancelTarget?.('radar-0', 1)
    expect(result).toBe(true)
  })
})
