import type { AlarmSink, CollisionAlert } from './alarms.js'
import { assess, type AlertLevel, type Zone } from './zones.js'

export interface LatLon {
  latitude: number
  longitude: number
}

/** A ship at constant course and speed. Course in radians true, speed in m/s. */
export interface Motion {
  position: LatLon
  course: number
  speed: number
}

/** The fields of a Signal K data-model leaf (`{ value, timestamp }`) that we read. */
interface Leaf<T> {
  value?: T | null
  timestamp?: string
}

/** The own-ship fields of `vessels.self.navigation` that we read. */
export interface OwnNavigation {
  // Values come from the network as-is, so their shape is checked, not assumed.
  position?: Leaf<{ latitude?: unknown; longitude?: unknown }>
  courseOverGroundTrue?: Leaf<unknown>
  speedOverGround?: Leaf<unknown>
}

export interface RadarCollisionOptions {
  zones: Zone[]
  /** A target not reported for this long (ms) is treated as gone. */
  maxAge: number
  /** `app.selfContext`, so `targetRef` is an absolute Signal K path. */
  selfContext: string
  /** Own ship now, or null when its position, course or speed is unknown. */
  ownShip: () => Motion | null
  now?: () => number
}

interface TrackedTarget {
  radarId: string
  id: string
  cpa: number
  tcpa: number
  range: number
  motion: Motion
  receivedAt: number
}

const TARGET_PATH = /^radars\.([^.]+)\.targets\.([^.]+)$/
const EARTH_RADIUS = 6371008.8
const DEG = Math.PI / 180
// Below this speed COG is noise, so own ship is treated as stationary.
const STATIONARY_SPEED = 0.1

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isFresh(leaf: Leaf<unknown> | undefined, nowMs: number, maxAge: number): boolean {
  const t = leaf?.timestamp ? Date.parse(leaf.timestamp) : NaN
  return Number.isFinite(t) && nowMs - t <= maxAge
}

/** Own ship from `vessels.self.navigation`, or null when any part is missing or stale. */
export function ownShipFrom(
  nav: OwnNavigation | undefined,
  nowMs: number,
  maxAge: number
): Motion | null {
  const latitude = nav?.position?.value?.latitude
  const longitude = nav?.position?.value?.longitude
  const speed = nav?.speedOverGround?.value
  if (
    !isNumber(latitude) ||
    !isNumber(longitude) ||
    !isNumber(speed) ||
    !isFresh(nav?.position, nowMs, maxAge) ||
    !isFresh(nav?.speedOverGround, nowMs, maxAge)
  ) {
    return null
  }
  const position = { latitude, longitude }
  if (speed < STATIONARY_SPEED) {
    return { position, course: 0, speed: 0 }
  }
  const course = nav?.courseOverGroundTrue?.value
  if (!isNumber(course) || !isFresh(nav?.courseOverGroundTrue, nowMs, maxAge)) {
    return null
  }
  return { position, course, speed }
}

/** Where a ship at constant course and speed will be after `seconds`. */
export function advance(motion: Motion, seconds: number): LatLon {
  const distance = motion.speed * seconds
  const lat = motion.position.latitude * DEG
  const dNorth = distance * Math.cos(motion.course)
  const dEast = distance * Math.sin(motion.course)
  const longitude = motion.position.longitude + dEast / (EARTH_RADIUS * Math.cos(lat)) / DEG
  return {
    latitude: motion.position.latitude + dNorth / EARTH_RADIUS / DEG,
    longitude: ((((longitude + 180) % 360) + 360) % 360) - 180
  }
}

/**
 * The parts of a mayara ARPA target (`radars.<id>.targets.<n>`) a collision
 * alarm needs, or null when the target is gone or cannot be assessed: lost,
 * no geographic position, or no CPA yet (mayara omits `danger` until it knows
 * both its own and the target's motion).
 */
function parseTarget(value: unknown): Omit<TrackedTarget, 'radarId' | 'id' | 'receivedAt'> | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const t = value as {
    status?: unknown
    position?: { distance?: unknown; latitude?: unknown; longitude?: unknown }
    motion?: { course?: unknown; speed?: unknown }
    danger?: { cpa?: unknown; tcpa?: unknown }
  }
  const { distance, latitude, longitude } = t.position ?? {}
  const { course, speed } = t.motion ?? {}
  const { cpa, tcpa } = t.danger ?? {}
  if (
    t.status === 'lost' ||
    !isNumber(distance) ||
    !isNumber(latitude) ||
    !isNumber(longitude) ||
    !isNumber(course) ||
    !isNumber(speed) ||
    !isNumber(cpa) ||
    !isNumber(tcpa)
  ) {
    return null
  }
  return {
    cpa,
    tcpa,
    range: distance,
    motion: { position: { latitude, longitude }, course, speed }
  }
}

export function formatMessage(target: Pick<TrackedTarget, 'radarId' | 'id' | 'cpa' | 'tcpa'>) {
  const nm = (target.cpa / 1852).toFixed(2)
  const minutes = Math.max(0, Math.round(target.tcpa / 60))
  return `Collision risk: radar target ${target.id} (${target.radarId}), CPA ${nm} NM in ${minutes} min`
}

/**
 * Raises one collision alarm per mayara ARPA target whose CPA/TCPA enters a
 * zone, in the same shape signalk-collision-alerts uses for AIS targets.
 *
 * CPA and TCPA are mayara's own (computed from its Kalman-smoothed track, so
 * the alarm agrees with the radar display); own ship from Signal K only places
 * the line's end points. Targets are fed as they arrive on mayara's stream and
 * timed out on the local clock, because a standalone mayara's clock need not
 * match this server's.
 */
export class RadarCollisionMonitor {
  private readonly targets = new Map<string, TrackedTarget>()
  private readonly levels = new Map<string, AlertLevel>()
  private readonly now: () => number

  constructor(
    private readonly options: RadarCollisionOptions,
    private readonly sink: AlarmSink
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
    const key = `radar:${radarId}:${id}`
    const parsed = parseTarget(value)
    if (!parsed) {
      this.targets.delete(key)
      this.release(key)
      return
    }
    const target = { ...parsed, radarId, id, receivedAt: this.now() }
    this.targets.set(key, target)
    this.assess(key, target)
  }

  /** Drop targets mayara stopped reporting (radar off, mayara unreachable). */
  expire(): void {
    const cutoff = this.now() - this.options.maxAge
    for (const [key, target] of this.targets) {
      if (target.receivedAt < cutoff) {
        this.targets.delete(key)
        this.release(key)
      }
    }
  }

  stop(): void {
    this.targets.clear()
    this.levels.clear()
    this.sink.clearAll()
  }

  private assess(key: string, target: TrackedTarget): void {
    const level = assess(this.options.zones, target.cpa, target.tcpa, this.levels.get(key))
    if (!level) {
      this.release(key)
      return
    }
    this.levels.set(key, level)
    this.sink.set(key, this.alert(target, level))
  }

  private release(key: string): void {
    if (this.levels.delete(key)) {
      this.sink.set(key, undefined)
    }
  }

  private alert(target: TrackedTarget, level: AlertLevel): CollisionAlert {
    const own = this.options.ownShip()
    const targetAtCpa = advance(target.motion, target.tcpa)
    return {
      level,
      message: formatMessage(target),
      data: {
        targetRef: `${this.options.selfContext}.radars.${target.radarId}.targets.${target.id}`,
        source: 'radar',
        cpa: target.cpa,
        tcpa: target.tcpa,
        range: target.range,
        cpaPositions: own
          ? { self: advance(own, target.tcpa), target: targetAtCpa }
          : { target: targetAtCpa }
      }
    }
  }
}
