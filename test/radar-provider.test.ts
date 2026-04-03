import { describe, it, expect, vi } from 'vitest'
import { createRadarProvider } from '../src/radar-provider'
import { MayaraClient } from '../src/mayara-client'
import { MayaraServerAPI } from '../src/types'

function createMockClient(overrides: Partial<MayaraClient> = {}): MayaraClient {
  return {
    getRadars: vi.fn().mockResolvedValue({
      'radar-0': { brand: 'Furuno', model: 'DRS4D-NXT', name: 'Furuno DRS4D-NXT' },
      'radar-1': { brand: 'Navico', model: 'HALO', name: 'Navico HALO' }
    }),
    getCapabilities: vi.fn().mockResolvedValue({
      spokesPerRevolution: 2048,
      maxSpokeLength: 512
    }),
    getState: vi.fn().mockResolvedValue({
      status: 'transmit',
      controls: { range: { value: 3000 }, gain: { auto: false, value: 50 } }
    }),
    setControl: vi.fn().mockResolvedValue({ success: true }),
    setControls: vi.fn().mockResolvedValue({ success: true }),
    getTargets: vi.fn().mockResolvedValue({ targets: [] }),
    acquireTarget: vi.fn().mockResolvedValue({ targetId: 1 }),
    cancelTarget: vi.fn().mockResolvedValue({}),
    getSpokeStreamUrl: vi.fn().mockReturnValue('ws://localhost:6502/v2/api/radars/radar-0/spokes'),
    getTargetStreamUrl: vi
      .fn()
      .mockReturnValue('ws://localhost:6502/v2/api/radars/radar-0/targets/stream'),
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
    } as unknown as Partial<MayaraClient>)
    const provider = createRadarProvider(client, createMockApp())

    const ids = await provider.getRadars()
    expect(ids).toEqual([])
  })

  it('getRadarInfo builds RadarInfo from state and capabilities', async () => {
    const client = createMockClient()
    const provider = createRadarProvider(client, createMockApp())

    const info = await provider.getRadarInfo('radar-0')
    expect(info).not.toBeNull()
    if (info) {
      expect(info.id).toBe('radar-0')
      expect(info.name).toBe('Furuno DRS4D-NXT')
      expect(info.brand).toBe('Furuno')
      expect(info.status).toBe('transmit')
      expect(info.spokesPerRevolution).toBe(2048)
      expect(info.range).toBe(3000)
    }
  })

  it('getRadarInfo returns null when state unavailable', async () => {
    const client = createMockClient({
      getState: vi.fn().mockResolvedValue(null)
    } as unknown as Partial<MayaraClient>)
    const provider = createRadarProvider(client, createMockApp())

    const info = await provider.getRadarInfo('radar-0')
    expect(info).toBeNull()
  })

  it('setPower proxies to client', async () => {
    const setControlFn = vi.fn().mockResolvedValue({ success: true })
    const client2 = createMockClient({
      setControl: setControlFn
    } as unknown as Partial<MayaraClient>)
    const provider2 = createRadarProvider(client2, createMockApp())

    const result = await provider2.setPower?.('radar-0', 'transmit')
    expect(result).toBe(true)
    expect(setControlFn).toHaveBeenCalledWith('radar-0', 'power', 'transmit')
  })

  it('setPower returns false on error', async () => {
    const client = createMockClient({
      setControl: vi.fn().mockRejectedValue(new Error('timeout'))
    } as unknown as Partial<MayaraClient>)
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

  it('setControl returns error on failure', async () => {
    const client = createMockClient({
      setControl: vi.fn().mockRejectedValue(new Error('invalid value'))
    } as unknown as Partial<MayaraClient>)
    const provider = createRadarProvider(client, createMockApp())

    const result = await provider.setControl?.('radar-0', 'gain', -1)
    expect(result).toEqual({ success: false, error: 'invalid value' })
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
