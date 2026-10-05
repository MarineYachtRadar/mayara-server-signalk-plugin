import type { Context, Delta, Path, PathValue } from '@signalk/server-api'
import type { PresetName } from './zones.js'

// mayara numbers its ARPA targets, so the last `-` of a target id always
// separates the radar id from the target number.
const TARGET_PATH = /^radars\.([^.]+)\.targets\.(\d+)$/

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * The `targets.*` context of an ARPA target. Joining with `-` keeps it clear
 * of `radar:<radarId>:<n>`, the key this plugin's own radar alarms use, so a
 * collision alarm plugin keying its alarms by context never writes the same
 * notification.
 */
export function targetContext(radarId: string, id: string): string {
  return `targets.radar:${radarId}-${id}`
}

/**
 * The values a mayara ARPA target is published with, or null when it is lost
 * or has no geographic position yet. No CPA is needed: consumers only need to
 * know where the target is and how it moves.
 */
export function targetValues(value: unknown): PathValue[] | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const t = value as {
    status?: unknown
    position?: { latitude?: unknown; longitude?: unknown }
    motion?: { course?: unknown; speed?: unknown }
  }
  const { latitude, longitude } = t.position ?? {}
  if (t.status === 'lost' || !isNumber(latitude) || !isNumber(longitude)) {
    return null
  }
  const { course, speed } = t.motion ?? {}
  return [
    { path: 'navigation.position' as Path, value: { latitude, longitude } },
    ...(isNumber(course)
      ? [{ path: 'navigation.courseOverGroundTrue' as Path, value: course }]
      : []),
    ...(isNumber(speed) ? [{ path: 'navigation.speedOverGround' as Path, value: speed }] : [])
  ]
}

/**
 * Publishes mayara's ARPA targets as `targets.radar:<radarId>-<n>` contexts,
 * where chart plotters, collision alarms and a fusion plugin that links them
 * to their AIS vessels find them like any other Signal K data.
 *
 * Updates carry no timestamp, so the server stamps them on its own clock: a
 * standalone mayara's clock need not match it. For the same reason targets
 * are timed out on the local clock.
 */
export class RadarTargetPublisher {
  private readonly lastSeen = new Map<string, number>()
  private readonly now: () => number

  constructor(
    private readonly publish: (delta: Delta) => void,
    private readonly options: { maxAge: number; now?: () => number }
  ) {
    this.now = options.now ?? Date.now
  }

  /** Feed one value from mayara's stream; anything but an ARPA target is ignored. */
  update(path: string, value: unknown): void {
    const match = TARGET_PATH.exec(path)
    if (!match) {
      return
    }
    const [, radarId, id] = match
    const context = targetContext(radarId, id)
    const values = targetValues(value)
    if (!values) {
      this.lose(context)
      return
    }
    this.send(context, values)
    this.lastSeen.set(context, this.now())
  }

  /** Lose targets mayara stopped reporting (radar off, mayara unreachable). */
  expire(): void {
    const cutoff = this.now() - this.options.maxAge
    for (const [context, seen] of this.lastSeen) {
      if (seen < cutoff) {
        this.lose(context)
      }
    }
  }

  stop(): void {
    for (const context of [...this.lastSeen.keys()]) {
      this.lose(context)
    }
  }

  /** A null position tells consumers the track is gone. */
  private lose(context: string): void {
    if (this.lastSeen.delete(context)) {
      this.send(context, [{ path: 'navigation.position' as Path, value: null }])
    }
  }

  private send(context: string, values: PathValue[]): void {
    this.publish({ context: context as Context, updates: [{ values }] })
  }
}

/**
 * The preset this plugin raises radar alarms with. The collision alerts
 * plugin takes them over only when the user says so, since it may not be
 * installed and a missing alarm is worse than a duplicate one.
 */
export function radarAlarmPreset(
  setting: PresetName | 'off' | 'collision-alerts-plugin'
): PresetName | 'off' {
  return setting === 'collision-alerts-plugin' ? 'off' : setting
}
