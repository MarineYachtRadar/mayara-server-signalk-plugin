import type {
  ALARM_STATE,
  Context,
  Delta,
  NotificationId,
  Path,
  ServerAPI,
  Value
} from '@signalk/server-api'
import type { AlertLevel } from './zones.js'

/**
 * What every collision source publishes for one target, so radar, camera and
 * AIS alerts look the same to consumers (signalk-collision-alerts raises the
 * AIS ones). `targetRef` is the Signal K path of the target: for a radar
 * target `vessels.<self>.radars.<radarId>.targets.<id>`.
 */
export interface CollisionAlertData {
  targetRef: string
  source: string
  cpa: number
  tcpa: number
  range: number
  cpaPositions: Value
  [key: string]: Value
}

export interface CollisionAlert {
  level: AlertLevel
  message: string
  data: CollisionAlertData
}

export interface AlarmSink {
  /** Raise, update or (with `undefined`) clear the alert for one target. */
  set(targetId: string, alert: CollisionAlert | undefined): void
  clearAll(): void
}

// ALARM_STATE is a string enum whose values are exactly these level names.
// Its runtime object lives in @signalk/server-api, which this plugin uses
// for types only, so the level is narrowed to the enum type here instead.
function toAlarmState(level: AlertLevel): ALARM_STATE {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
  return level as ALARM_STATE
}

/** The notification value written directly into the data model. */
interface NotificationDeltaValue {
  state: AlertLevel | 'normal'
  method: Array<'visual' | 'sound'>
  message: string
  data?: CollisionAlertData
  createdAt?: string
}

export function notificationPath(targetId: string): Path {
  return `navigation.closestApproach.${targetId}` as Path
}

// Repeating identical data every evaluation would put a delta on the wire
// per target per tick; the numbers only need refreshing this often.
const DATA_REFRESH_MS = 10_000

/** Alerts through the server's Notifications API, so ack/silence/clear work everywhere. */
export class ManagedAlarmSink implements AlarmSink {
  private readonly active = new Map<
    string,
    { id: NotificationId; level: AlertLevel; sentAt: number }
  >()

  constructor(
    private readonly app: ServerAPI,
    private readonly now: () => number = Date.now
  ) {}

  set(targetId: string, alert: CollisionAlert | undefined): void {
    const existing = this.active.get(targetId)
    if (!alert) {
      if (existing) {
        this.active.delete(targetId)
        this.tryClear(existing.id)
      }
      return
    }
    const options = {
      state: toAlarmState(alert.level),
      message: alert.message,
      data: alert.data
    }
    const now = this.now()
    if (existing) {
      if (existing.level === alert.level && now - existing.sentAt < DATA_REFRESH_MS) {
        return
      }
      try {
        this.app.notifications.update(existing.id, options)
        this.active.set(targetId, { id: existing.id, level: alert.level, sentAt: now })
        return
      } catch {
        // Raising again while the old notification still stands would leave
        // two alarms for one target; keep it and retry the update next time.
        if (this.app.notifications.getId(existing.id)) {
          return
        }
        // The notification was removed behind our back (cleared and
        // cleaned up by the server); the risk still exists, so raise anew.
      }
    }
    const id = this.app.notifications.raise({
      ...options,
      path: notificationPath(targetId),
      includeCreatedAt: true
    })
    this.active.set(targetId, { id, level: alert.level, sentAt: now })
  }

  clearAll(): void {
    for (const { id } of this.active.values()) {
      this.tryClear(id)
    }
    this.active.clear()
  }

  private tryClear(id: NotificationId): void {
    try {
      this.app.notifications.clear(id)
    } catch {
      // Already cleared by the user or the server.
    }
  }
}

/** Alerts as plain notification deltas, for servers without core notification management. */
export class DeltaAlarmSink implements AlarmSink {
  private readonly active = new Map<string, { level: AlertLevel; sentAt: number }>()

  constructor(
    private readonly app: ServerAPI,
    private readonly pluginId: string,
    private readonly now: () => number = Date.now
  ) {}

  set(targetId: string, alert: CollisionAlert | undefined): void {
    const existing = this.active.get(targetId)
    const now = this.now()
    if (!alert) {
      if (existing) {
        this.active.delete(targetId)
        this.emit(targetId, { state: 'normal', method: [], message: '' })
      }
      return
    }
    if (existing && existing.level === alert.level && now - existing.sentAt < DATA_REFRESH_MS) {
      return
    }
    this.active.set(targetId, { level: alert.level, sentAt: now })
    this.emit(targetId, {
      state: alert.level,
      method: ['visual', 'sound'],
      message: alert.message,
      data: alert.data,
      createdAt: new Date(now).toISOString()
    })
  }

  clearAll(): void {
    for (const targetId of this.active.keys()) {
      this.emit(targetId, { state: 'normal', method: [], message: '' })
    }
    this.active.clear()
  }

  private emit(targetId: string, value: NotificationDeltaValue): void {
    const delta: Delta = {
      context: 'vessels.self' as Context,
      updates: [
        { values: [{ path: `notifications.${notificationPath(targetId)}` as Path, value }] }
      ]
    }
    this.app.handleMessage(this.pluginId, delta)
  }
}
