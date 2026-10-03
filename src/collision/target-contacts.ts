import type { PresetName } from './zones.js'

/**
 * The contact a sensor plugin reports to the Signal K Targets API
 * (`app.updateTargetContact`). Mirrored here because the API is newer than the
 * `@signalk/server-api` this plugin builds against; servers without it simply
 * lack the methods.
 */
export interface TargetContact {
  id: string
  type: string
  position: { latitude: number; longitude: number }
  courseOverGroundTrue?: number
  speedOverGround?: number
  ref?: string
}

/** The Targets API surface on `app`, absent on servers that predate it. */
export interface TargetsApiHost {
  updateTargetContact?: (contact: TargetContact) => void
  removeTargetContact?: (id: string) => void
  getTargets?: () => unknown[]
}

const TARGET_PATH = /^radars\.([^.]+)\.targets\.([^.]+)$/

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * A mayara ARPA target as a Targets API contact, or null when it is lost or
 * has no geographic position yet. Unlike a collision alarm, a contact does not
 * need a CPA: the server only needs to know where the target is.
 */
export function toContact(
  radarId: string,
  id: string,
  value: unknown,
  selfContext: string
): TargetContact | null {
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
  return {
    id: `${radarId}:${id}`,
    type: 'radar',
    position: { latitude, longitude },
    ...(isNumber(course) && { courseOverGroundTrue: course }),
    ...(isNumber(speed) && { speedOverGround: speed }),
    ref: `${selfContext}.radars.${radarId}.targets.${id}`
  }
}

/**
 * Reports mayara's ARPA targets to the server's Targets API, which links each
 * one to the AIS vessel it is (if any) so a collision alarm plugin sees one
 * boat once.
 *
 * Targets are timed out on the local clock, like the radar collision alarms,
 * because a standalone mayara's clock need not match this server's.
 */
export class TargetContactReporter {
  private readonly lastSeen = new Map<string, number>()
  private readonly now: () => number

  constructor(
    private readonly host: Required<
      Pick<TargetsApiHost, 'updateTargetContact' | 'removeTargetContact'>
    >,
    private readonly options: { selfContext: string; maxAge: number; now?: () => number }
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
    const contact = toContact(radarId, id, value, this.options.selfContext)
    if (!contact) {
      this.remove(`${radarId}:${id}`)
      return
    }
    this.host.updateTargetContact(contact)
    this.lastSeen.set(contact.id, this.now())
  }

  /** Withdraw targets mayara stopped reporting (radar off, mayara unreachable). */
  expire(): void {
    const cutoff = this.now() - this.options.maxAge
    for (const [id, seen] of this.lastSeen) {
      if (seen < cutoff) {
        this.remove(id)
      }
    }
  }

  stop(): void {
    for (const id of [...this.lastSeen.keys()]) {
      this.remove(id)
    }
  }

  private remove(id: string): void {
    if (this.lastSeen.delete(id)) {
      this.host.removeTargetContact(id)
    }
  }
}

/**
 * The preset this plugin raises radar alarms with. The collision alerts
 * plugin takes them over only when the user says so, since it may not be
 * installed; on a server without the Targets API it cannot see radar targets,
 * so they stay here at the default preset rather than reaching no one.
 */
export function radarAlarmPreset(
  setting: PresetName | 'off' | 'collision-alerts-plugin',
  hasTargetsApi: boolean
): PresetName | 'off' {
  if (setting !== 'collision-alerts-plugin') {
    return setting
  }
  return hasTargetsApi ? 'off' : 'coastal'
}

/** The host's Targets API when the server has one. */
export function targetsApiOf(
  app: TargetsApiHost
): Required<Pick<TargetsApiHost, 'updateTargetContact' | 'removeTargetContact'>> | null {
  const { updateTargetContact, removeTargetContact } = app
  return updateTargetContact && removeTargetContact
    ? { updateTargetContact, removeTargetContact }
    : null
}
