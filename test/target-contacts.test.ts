import { describe, expect, it, vi } from 'vitest'
import type { Delta } from '@signalk/server-api'
import {
  RadarTargetPublisher,
  radarAlarmPreset,
  targetValues
} from '../src/collision/target-contacts.js'

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
  const publish = vi.fn<(delta: Delta) => void>()
  const publisher = new RadarTargetPublisher(publish, { maxAge: 30_000, now: () => now })
  /** What each delta said: context and the paths it set. */
  const published = () =>
    publish.mock.calls.map(([delta]) => [
      delta.context,
      Object.fromEntries(
        delta.updates.flatMap((u) => ('values' in u ? u.values : [])).map((v) => [v.path, v.value])
      )
    ])
  return {
    publisher,
    publish,
    published,
    advanceClock: (ms: number) => {
      now += ms
    }
  }
}

describe('targetValues', () => {
  it('maps an ARPA target to the paths a vessel uses', () => {
    expect(targetValues(target())).toEqual([
      { path: 'navigation.position', value: { latitude: 52.0135, longitude: 4 } },
      { path: 'navigation.courseOverGroundTrue', value: Math.PI },
      { path: 'navigation.speedOverGround', value: 5 }
    ])
  })

  it('publishes a target before mayara knows its motion', () => {
    expect(targetValues(target({ motion: undefined }))).toEqual([
      { path: 'navigation.position', value: { latitude: 52.0135, longitude: 4 } }
    ])
  })

  it('has nothing for a lost target or one without a position', () => {
    expect(targetValues(target({ status: 'lost' }))).toBeNull()
    expect(targetValues(target({ position: { bearing: 0, distance: 1500 } }))).toBeNull()
    expect(targetValues(null)).toBeNull()
  })
})

const LOST = {
  'navigation.position': null,
  'navigation.courseOverGroundTrue': null,
  'navigation.speedOverGround': null
}

describe('RadarTargetPublisher', () => {
  it('publishes ARPA targets under targets.* and ignores other radar paths', () => {
    const { publisher, published } = setup()
    publisher.update('radars.radar-0.controls.gain', { value: 50 })
    publisher.update('radars.radar-0.targets.7', target())
    expect(published()).toEqual([
      [
        'targets.radar:radar-0-7',
        {
          'navigation.position': { latitude: 52.0135, longitude: 4 },
          'navigation.courseOverGroundTrue': Math.PI,
          'navigation.speedOverGround': 5
        }
      ]
    ])
  })

  it('leaves the timestamp to the server clock', () => {
    const { publisher, publish } = setup()
    publisher.update('radars.radar-0.targets.7', target())
    expect(publish.mock.calls[0][0].updates[0]).not.toHaveProperty('timestamp')
  })

  it('gives radars whose ids contain a dash distinct contexts', () => {
    const { publisher, published } = setup()
    publisher.update('radars.a-1.targets.2', target())
    publisher.update('radars.a.targets.1-2', target())
    publisher.update('radars.a.targets.12', target({ status: 'lost' }))
    expect(published().map(([context]) => context)).toEqual(['targets.radar:a-1-2'])
  })

  it('clears position, course and speed once for a target mayara reports lost', () => {
    const { publisher, published } = setup()
    publisher.update('radars.radar-0.targets.7', target())
    publisher.update('radars.radar-0.targets.7', null)
    publisher.update('radars.radar-0.targets.7', null)
    expect(published().slice(1)).toEqual([['targets.radar:radar-0-7', LOST]])
  })

  it('loses targets mayara stopped reporting', () => {
    const { publisher, published, advanceClock } = setup()
    publisher.update('radars.radar-0.targets.7', target())
    advanceClock(20_000)
    publisher.update('radars.radar-0.targets.8', target())
    advanceClock(15_000)
    publisher.expire()
    expect(published().slice(2)).toEqual([['targets.radar:radar-0-7', LOST]])
  })

  it('loses everything when stopped', () => {
    const { publisher, published } = setup()
    publisher.update('radars.radar-0.targets.7', target())
    publisher.update('radars.radar-1.targets.2', target())
    publisher.stop()
    expect(
      published()
        .slice(2)
        .map(([context]) => context)
    ).toEqual(['targets.radar:radar-0-7', 'targets.radar:radar-1-2'])
  })
})

describe('radarAlarmPreset', () => {
  it('keeps radar alarms here unless the user hands them over', () => {
    expect(radarAlarmPreset('coastal')).toBe('coastal')
    expect(radarAlarmPreset('off')).toBe('off')
  })

  it('leaves radar alarms to the collision alerts plugin when asked', () => {
    expect(radarAlarmPreset('collision-alerts-plugin')).toBe('off')
  })
})
