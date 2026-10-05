import { describe, it, expect } from 'vitest'
import { ConfigSchema, SCHEMA_DEFAULTS, parseConfig } from '../src/config/schema.js'

describe('SCHEMA_DEFAULTS', () => {
  it('holds each setting at the default its schema declares', () => {
    const declared = Object.fromEntries(
      Object.entries(ConfigSchema.properties).map(([key, schema]) => [key, schema.default])
    )
    expect(SCHEMA_DEFAULTS).toEqual(declared)
  })
})

describe('parseConfig', () => {
  it('fills an empty configuration with the defaults', () => {
    expect(parseConfig({})).toEqual({ config: SCHEMA_DEFAULTS, invalid: [] })
  })

  it('treats a missing or non-object configuration as empty', () => {
    for (const stored of [undefined, null, [], 'furuno', 5]) {
      expect(parseConfig(stored)).toEqual({ config: SCHEMA_DEFAULTS, invalid: [] })
    }
  })

  it('keeps valid settings', () => {
    const stored = {
      managedContainer: false,
      host: 'radar.local',
      port: 6510,
      mayaraArgs: ['--brand', 'furuno'],
      collisionAlerts: 'offshore'
    }
    const { config, invalid } = parseConfig(stored)
    expect(config).toEqual({ ...SCHEMA_DEFAULTS, ...stored })
    expect(invalid).toEqual([])
  })

  it('converts values that parse cleanly', () => {
    const { config, invalid } = parseConfig({ port: '6510', secure: 'true' })
    expect(config.port).toBe(6510)
    expect(config.secure).toBe(true)
    expect(invalid).toEqual([])
  })

  it('replaces only the invalid settings with their defaults', () => {
    const { config, invalid } = parseConfig({
      host: 'radar.local',
      port: 'abc',
      discoveryPollInterval: -5,
      collisionAlerts: 'coastel'
    })
    expect(config).toEqual({ ...SCHEMA_DEFAULTS, host: 'radar.local' })
    expect(invalid).toEqual([
      { key: 'port', reason: 'must be number' },
      { key: 'discoveryPollInterval', reason: 'must be >= 5' },
      {
        key: 'collisionAlerts',
        reason: 'must be one of off, harbour, coastal, offshore, collision-alerts-plugin'
      }
    ])
  })

  it('replaces a null setting instead of converting it', () => {
    // Converted, these would be `false` (no managed container) and the
    // hostname "null", both silently.
    const { config, invalid } = parseConfig({ managedContainer: null, host: null })
    expect(config).toEqual(SCHEMA_DEFAULTS)
    expect(invalid).toEqual([
      { key: 'managedContainer', reason: 'must be boolean' },
      { key: 'host', reason: 'must be string' }
    ])
  })

  it('drops keys the schema does not define', () => {
    const { config } = parseConfig({ legacyOption: true })
    expect(config).not.toHaveProperty('legacyOption')
  })

  it('leaves the stored configuration untouched', () => {
    const stored = { port: '6510', mayaraArgs: ['-v'], discoveryPollInterval: -5, host: null }
    const before = structuredClone(stored)
    parseConfig(stored)
    expect(stored).toEqual(before)
  })

  it('gives every configuration its own mayaraArgs array', () => {
    parseConfig({}).config.mayaraArgs.push('--emulator')
    expect(parseConfig({}).config.mayaraArgs).toEqual([])
    expect(SCHEMA_DEFAULTS.mayaraArgs).toEqual([])
  })
})
