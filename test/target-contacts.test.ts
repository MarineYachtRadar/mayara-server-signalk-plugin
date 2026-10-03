import { describe, expect, it, vi } from 'vitest'
import {
  TargetContactReporter,
  radarAlarmPreset,
  targetsApiOf,
  toContact
} from '../src/collision/target-contacts.js'

const SELF = 'vessels.urn:mrn:signalk:uuid:self'

/** A mayara ARPA target as it appears on mayara's v1 stream. */
function target(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    status: 'tracking',
    position: { bearing: 0, distance: 1500, latitude: 52.0135, longitude: 4 },
    motion: { course: Math.PI, speed: 5 },
    acquisition: 'auto',
    ...overrides
  }
}

function setup() {
  let now = 0
  const updateTargetContact = vi.fn()
  const removeTargetContact = vi.fn()
  const reporter = new TargetContactReporter(
    { updateTargetContact, removeTargetContact },
    { selfContext: SELF, maxAge: 30_000, now: () => now }
  )
  return {
    reporter,
    updateTargetContact,
    removeTargetContact,
    advanceClock: (ms: number) => {
      now += ms
    }
  }
}

describe('toContact', () => {
  it('maps an ARPA target to a radar contact', () => {
    expect(toContact('radar-0', '7', target(), SELF)).toEqual({
      id: 'radar-0-7',
      type: 'radar',
      position: { latitude: 52.0135, longitude: 4 },
      courseOverGroundTrue: Math.PI,
      speedOverGround: 5,
      ref: `${SELF}.radars.radar-0.targets.7`
    })
  })

  it('reports a target before mayara knows its motion', () => {
    const contact = toContact('radar-0', '7', target({ motion: undefined }), SELF)
    expect(contact?.position).toEqual({ latitude: 52.0135, longitude: 4 })
    expect(contact).not.toHaveProperty('speedOverGround')
  })

  it('has no contact for a lost target or one without a position', () => {
    expect(toContact('radar-0', '7', target({ status: 'lost' }), SELF)).toBeNull()
    expect(
      toContact('radar-0', '7', target({ position: { bearing: 0, distance: 1500 } }), SELF)
    ).toBeNull()
    expect(toContact('radar-0', '7', null, SELF)).toBeNull()
  })
})

describe('TargetContactReporter', () => {
  it('reports ARPA targets and ignores other radar paths', () => {
    const { reporter, updateTargetContact } = setup()
    reporter.update('radars.radar-0.controls.gain', { value: 50 })
    reporter.update('radars.radar-0.targets.7', target())
    expect(updateTargetContact).toHaveBeenCalledTimes(1)
    expect(updateTargetContact.mock.calls[0][0]).toMatchObject({ id: 'radar-0-7' })
  })

  it('withdraws a target mayara reports lost', () => {
    const { reporter, removeTargetContact } = setup()
    reporter.update('radars.radar-0.targets.7', target())
    reporter.update('radars.radar-0.targets.7', null)
    reporter.update('radars.radar-0.targets.7', null)
    expect(removeTargetContact).toHaveBeenCalledTimes(1)
    expect(removeTargetContact).toHaveBeenCalledWith('radar-0-7')
  })

  it('withdraws targets mayara stopped reporting', () => {
    const { reporter, removeTargetContact, advanceClock } = setup()
    reporter.update('radars.radar-0.targets.7', target())
    advanceClock(20_000)
    reporter.update('radars.radar-0.targets.8', target())
    advanceClock(15_000)
    reporter.expire()
    expect(removeTargetContact.mock.calls).toEqual([['radar-0-7']])
  })

  it('withdraws everything when stopped', () => {
    const { reporter, removeTargetContact } = setup()
    reporter.update('radars.radar-0.targets.7', target())
    reporter.update('radars.radar-1.targets.2', target())
    reporter.stop()
    expect(removeTargetContact.mock.calls).toEqual([['radar-0-7'], ['radar-1-2']])
  })
})

describe('targetsApiOf', () => {
  it('is null on servers without the Targets API', () => {
    expect(targetsApiOf({})).toBeNull()
  })

  it('returns the contact methods when the server has them', () => {
    const api = { updateTargetContact: vi.fn(), removeTargetContact: vi.fn() }
    expect(targetsApiOf(api)).toEqual(api)
  })
})

describe('radarAlarmPreset', () => {
  it('keeps radar alarms here unless the user hands them over', () => {
    expect(radarAlarmPreset('coastal', true)).toBe('coastal')
    expect(radarAlarmPreset('off', true)).toBe('off')
  })

  it('leaves radar alarms to the collision alerts plugin on a Targets API server', () => {
    expect(radarAlarmPreset('collision-alerts-plugin', true)).toBe('off')
  })

  it('falls back to coastal when the server cannot pass radar targets on', () => {
    expect(radarAlarmPreset('collision-alerts-plugin', false)).toBe('coastal')
  })
})
