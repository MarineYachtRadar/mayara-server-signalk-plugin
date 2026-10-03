import { describe, expect, it, vi } from 'vitest'
import type { AlarmSink, CollisionAlert } from '../src/collision/alarms.js'
import { PRESETS } from '../src/collision/zones.js'
import {
  RadarCollisionMonitor,
  advance,
  ownShipFrom,
  type Motion
} from '../src/collision/radar-targets.js'

const SELF = 'vessels.urn:mrn:signalk:uuid:self'
const OWN: Motion = { position: { latitude: 52, longitude: 4 }, course: 0, speed: 5 }

/** A mayara ARPA target as it appears on mayara's v1 stream. */
function target(cpa: number, tcpa: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    status: 'tracking',
    position: { bearing: 0, distance: 1500, latitude: 52.0135, longitude: 4 },
    motion: { course: Math.PI, speed: 5 },
    danger: { cpa, tcpa, is_dangerous: false },
    acquisition: 'auto',
    firstSeen: '2026-10-03T00:00:00.000Z',
    lastSeen: '2026-10-03T00:00:10.000Z',
    ...overrides
  }
}

function setup(ownShip: Motion | null = OWN) {
  let now = 0
  const set = vi.fn<AlarmSink['set']>()
  const clearAll = vi.fn<AlarmSink['clearAll']>()
  const monitor = new RadarCollisionMonitor(
    {
      zones: PRESETS.coastal, // warn 926 m / 720 s, alarm 463 m / 360 s
      maxAge: 30_000,
      selfContext: SELF,
      ownShip: () => ownShip,
      now: () => now
    },
    { set, clearAll }
  )
  const raised = (call: number): CollisionAlert => {
    const alert = set.mock.calls[call]?.[1]
    if (!alert) throw new Error(`call ${call} was not a raise`)
    return alert
  }
  return {
    monitor,
    set,
    clearAll,
    raised,
    advanceClock: (ms: number) => {
      now += ms
    }
  }
}

describe('RadarCollisionMonitor', () => {
  it('raises an alarm in the shared shape for a target inside a zone', () => {
    const { monitor, set, raised } = setup()
    monitor.update('radars.nav1.targets.7', target(200, 150))

    expect(set).toHaveBeenCalledOnce()
    expect(set.mock.calls[0]?.[0]).toBe('radar:nav1:7')
    const alert = raised(0)
    expect(alert.level).toBe('alarm')
    expect(alert.data).toMatchObject({
      targetRef: `${SELF}.radars.nav1.targets.7`,
      source: 'radar',
      cpa: 200,
      tcpa: 150,
      range: 1500
    })
    expect(alert.message).toBe('Collision risk: radar target 7 (nav1), CPA 0.11 NM in 3 min')
  })

  it('places both ends of the CPA line where each ship will be at TCPA', () => {
    const { monitor, raised } = setup()
    monitor.update('radars.nav1.targets.7', target(200, 150))
    const positions = raised(0).data.cpaPositions as {
      self: { latitude: number }
      target: { latitude: number }
    }
    // Own ship north at 5 m/s, target south at 5 m/s, 150 s each.
    expect(positions.self.latitude).toBeCloseTo(52 + 750 / 111195, 5)
    expect(positions.target.latitude).toBeCloseTo(52.0135 - 750 / 111195, 5)
  })

  it('still alarms without own-ship data, with only the target end of the line', () => {
    const { monitor, raised } = setup(null)
    monitor.update('radars.nav1.targets.7', target(200, 150))
    expect(raised(0).data.cpaPositions).toEqual({ target: expect.any(Object) as unknown })
  })

  it('keeps one alarm per target, so several targets alarm at once', () => {
    const { monitor, set } = setup()
    monitor.update('radars.nav1.targets.7', target(200, 150))
    monitor.update('radars.nav1.targets.8', target(800, 600, { id: 8 }))
    monitor.update('radars.nav2.targets.7', target(300, 200))
    expect(set.mock.calls.map(([key, alert]) => [key, alert?.level])).toEqual([
      ['radar:nav1:7', 'alarm'],
      ['radar:nav1:8', 'warn'],
      ['radar:nav2:7', 'alarm']
    ])
  })

  it('does not alarm for a distant target or one without a CPA yet', () => {
    const { monitor, set } = setup()
    monitor.update('radars.nav1.targets.7', target(5000, 150))
    monitor.update('radars.nav1.targets.8', target(0, 0, { danger: undefined }))
    monitor.update('radars.nav1.targets.9', target(200, 150, { motion: undefined }))
    expect(set).not.toHaveBeenCalled()
  })

  it('clears the alarm when the target leaves the zone', () => {
    const { monitor, set } = setup()
    monitor.update('radars.nav1.targets.7', target(200, 150))
    monitor.update('radars.nav1.targets.7', target(3000, 150))
    expect(set).toHaveBeenLastCalledWith('radar:nav1:7', undefined)
  })

  it('clears the alarm when mayara reports the target lost or deleted', () => {
    const lost = setup()
    lost.monitor.update('radars.nav1.targets.7', target(200, 150))
    lost.monitor.update('radars.nav1.targets.7', target(200, 150, { status: 'lost' }))
    expect(lost.set).toHaveBeenLastCalledWith('radar:nav1:7', undefined)

    const deleted = setup()
    deleted.monitor.update('radars.nav1.targets.7', target(200, 150))
    deleted.monitor.update('radars.nav1.targets.7', null)
    expect(deleted.set).toHaveBeenLastCalledWith('radar:nav1:7', undefined)
  })

  it('clears the alarm of a target mayara stopped reporting', () => {
    const { monitor, set, advanceClock } = setup()
    monitor.update('radars.nav1.targets.7', target(200, 150))
    advanceClock(20_000)
    monitor.expire()
    expect(set).toHaveBeenCalledOnce()
    advanceClock(15_000)
    monitor.expire()
    expect(set).toHaveBeenLastCalledWith('radar:nav1:7', undefined)
  })

  it('ignores everything on the stream that is not an ARPA target', () => {
    const { monitor, set } = setup()
    monitor.update('radars.nav1.controls.gain', target(200, 150))
    monitor.update('notifications.radar.nav1.guardZone.1', target(200, 150))
    expect(set).not.toHaveBeenCalled()
  })

  it('clears every alarm on stop', () => {
    const { monitor, clearAll } = setup()
    monitor.update('radars.nav1.targets.7', target(200, 150))
    monitor.stop()
    expect(clearAll).toHaveBeenCalledOnce()
  })
})

describe('ownShipFrom', () => {
  const at = (iso: string) => Date.parse(iso)
  const fresh = '2026-10-03T00:00:00.000Z'
  const nav = {
    position: { value: { latitude: 52, longitude: 4 }, timestamp: fresh },
    courseOverGroundTrue: { value: 1, timestamp: fresh },
    speedOverGround: { value: 3, timestamp: fresh }
  }

  it('reads position, course and speed', () => {
    expect(ownShipFrom(nav, at(fresh), 30_000)).toEqual({
      position: { latitude: 52, longitude: 4 },
      course: 1,
      speed: 3
    })
  })

  it('treats a ship below steerage speed as stationary even without a course', () => {
    expect(
      ownShipFrom(
        { ...nav, speedOverGround: { value: 0, timestamp: fresh }, courseOverGroundTrue: {} },
        at(fresh),
        30_000
      )
    ).toEqual({ position: { latitude: 52, longitude: 4 }, course: 0, speed: 0 })
  })

  it('returns null for missing or stale data', () => {
    expect(ownShipFrom(undefined, at(fresh), 30_000)).toBeNull()
    expect(ownShipFrom(nav, at(fresh) + 31_000, 30_000)).toBeNull()
  })
})

describe('advance', () => {
  it('wraps longitude across the antimeridian', () => {
    const p = advance(
      { position: { latitude: 0, longitude: 179.99 }, course: Math.PI / 2, speed: 10 },
      1000
    )
    expect(p.longitude).toBeLessThan(-179)
  })
})
