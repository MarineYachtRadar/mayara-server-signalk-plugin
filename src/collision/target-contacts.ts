import type {
  Context,
  Delta,
  Path,
  PathValue,
  PropertyValue,
  PropertyValuesEmitter
} from '@signalk/server-api'
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

const LOST_VALUES: PathValue[] = [
  { path: 'navigation.position' as Path, value: null },
  { path: 'navigation.courseOverGroundTrue' as Path, value: null },
  { path: 'navigation.speedOverGround' as Path, value: null }
]

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

  /**
   * A null position tells consumers the track is gone; course and speed are
   * cleared too, so nothing reads the motion of a track that no longer exists.
   */
  private lose(context: string): void {
    if (this.lastSeen.delete(context)) {
      this.send(context, LOST_VALUES)
    }
  }

  private send(context: string, values: PathValue[]): void {
    this.publish({ context: context as Context, updates: [{ values }] })
  }
}

export const COLLISION_ALERTS_PROPERTY = 'collisionAlerts'

// PropertyValues may be any value, functions included, so check the shape.
function evaluatesTargets(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { evaluatesTargets?: unknown }).evaluatesTargets === true
  )
}

/**
 * Whether signalk-collision-alerts is running and alarms on radar targets
 * itself. This plugin's radar alarms stand down only then: while that plugin
 * is missing or stopped, a missing alarm would be worse than a duplicate.
 */
export class CollisionAlertsWatch {
  private latest: PropertyValue | undefined
  private unsubscribe: (() => void) | undefined

  /** The history replays on subscribe, so plugin start order does not matter. */
  start(app: Pick<PropertyValuesEmitter, 'onPropertyValues'>): void {
    this.stop()
    this.unsubscribe = app.onPropertyValues(COLLISION_ALERTS_PROPERTY, (history) => {
      this.latest = history[history.length - 1]
    })
  }

  /** Forgets the announcement so a restart never inherits a stale one. */
  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.latest = undefined
  }

  running(): boolean {
    return evaluatesTargets(this.latest?.value)
  }
}

/** The preset this plugin raises radar alarms with, when it raises them at all. */
export function radarAlarmPreset(
  setting: PresetName | 'off' | 'collision-alerts-plugin'
): PresetName | 'off' {
  return setting === 'collision-alerts-plugin' ? 'off' : setting
}
