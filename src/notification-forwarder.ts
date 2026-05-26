import WebSocket from 'ws'
import type { Delta } from '@signalk/server-api'

/**
 * Subset of the Signal K app surface this forwarder needs. We pin to the
 * minimum so the unit tests can pass a stub without dragging in the full
 * server-api types.
 */
export interface NotificationForwarderApp {
  handleMessage(id: string, msg: Partial<Delta>): void
  debug?(msg: string): void
}

export interface NotificationForwarderOptions {
  /**
   * Plugin id used when calling `app.handleMessage`. Signal K stamps
   * the republished delta's `$source` from this; passing the same id
   * the plugin registers with keeps all forwarded data attributed to
   * one provider in the SK admin UI.
   */
  pluginId: string
  /** ws:// URL of mayara-server's `/signalk/v1/stream` endpoint. */
  url: string
  /** Optional logger; defaults to a no-op. */
  debug?: (msg: string) => void
  reconnectInterval?: number
  /**
   * Constructor override used by tests; in production this is just the
   * `ws` package's `WebSocket` class. Typed minimally to avoid pulling
   * the full ws.d.ts surface into the public API.
   */
  webSocketFactory?: (url: string) => WebSocketLike
}

/**
 * Bridges `notifications.*` deltas from mayara-server's Signal K v1
 * stream into the host Signal K server via `app.handleMessage`. Mayara
 * emits e.g. `notifications.radar.<key>.guardZone.<n>` on its own
 * stream; without this forwarder, those alarms reach mayara's built-in
 * GUI but not the SK admin notifications panel, the chart plotter, or
 * any other SK consumer.
 *
 * On connect we send a `notifications.*` subscription so mayara filters
 * appropriately. Each incoming delta is forwarded as-is — mayara has
 * already shaped it to the SK spec (state / method / message), and the
 * SK server stamps `$source` from `pluginId` on republish.
 */
export class NotificationForwarder {
  private readonly pluginId: string
  private readonly url: string
  private readonly debug: (msg: string) => void
  private readonly reconnectMs: number
  private readonly webSocketFactory: (url: string) => WebSocketLike

  private ws: WebSocketLike | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private connected = false
  private readonly app: NotificationForwarderApp

  constructor(app: NotificationForwarderApp, options: NotificationForwarderOptions) {
    this.app = app
    this.pluginId = options.pluginId
    this.url = options.url
    this.debug = options.debug ?? (() => {})
    this.reconnectMs = options.reconnectInterval ?? 5000
    this.webSocketFactory =
      options.webSocketFactory ?? ((url: string): WebSocketLike => new WebSocket(url))
  }

  start(): void {
    if (this.closed) return
    this.connect()
  }

  private connect(): void {
    if (this.closed) return

    this.debug(`Connecting to notification stream: ${this.url}`)

    try {
      const ws = this.webSocketFactory(this.url)
      this.ws = ws

      ws.on('open', () => {
        this.connected = true
        this.debug('Connected to mayara notification stream')

        // Tell mayara we only care about notification deltas. Using a
        // wildcard means we pick up every radar's guard-zone alarms (and
        // any future per-radar notification types mayara adds) without
        // having to know radar ids up front.
        const subscription = JSON.stringify({
          subscribe: [{ path: 'notifications.*', policy: 'instant' }]
        })
        try {
          ws.send(subscription)
        } catch (err) {
          this.debug(
            `Failed to send notification subscription: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      })

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data)
      })

      ws.on('error', (err: Error) => {
        this.connected = false
        this.debug(`Notification stream error: ${err.message}`)
      })

      ws.on('close', (code: number) => {
        this.connected = false
        this.debug(`Notification stream closed: ${code}`)
        if (!this.closed) {
          this.scheduleReconnect()
        }
      })
    } catch (err) {
      this.debug(
        `Failed to connect to notification stream: ${err instanceof Error ? err.message : String(err)}`
      )
      this.scheduleReconnect()
    }
  }

  /**
   * Parse one inbound text frame and forward every notification-pathed
   * value entry to the host SK server. Non-text frames, non-JSON
   * payloads, deltas with no notification entries, and the upstream
   * "hello" handshake are all silently dropped.
   *
   * Exposed `protected` so the tests can inject frames without going
   * through the real WebSocket.
   */
  protected handleMessage(data: WebSocket.RawData): void {
    let text: string
    if (typeof data === 'string') {
      text = data
    } else if (Buffer.isBuffer(data)) {
      text = data.toString('utf8')
    } else {
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }

    const delta = this.extractNotificationDelta(parsed)
    if (!delta) return

    try {
      this.app.handleMessage(this.pluginId, delta)
    } catch (err) {
      this.debug(
        `Failed to forward notification delta: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Returns a copy of `parsed` containing only the notification values.
   * Returns null if `parsed` isn't a Signal K delta, has no `updates`,
   * or carries no `notifications.*` paths after filtering.
   */
  private extractNotificationDelta(parsed: unknown): Partial<Delta> | null {
    if (!parsed || typeof parsed !== 'object') return null
    const root = parsed as { updates?: unknown[] }
    if (!Array.isArray(root.updates)) return null

    const filteredUpdates: unknown[] = []
    for (const update of root.updates) {
      if (!update || typeof update !== 'object') continue
      const values = (update as { values?: unknown[] }).values
      if (!Array.isArray(values)) continue

      const notificationValues = values.filter((v) => {
        if (!v || typeof v !== 'object') return false
        const path = (v as { path?: unknown }).path
        return typeof path === 'string' && path.startsWith('notifications.')
      })

      if (notificationValues.length > 0) {
        // Preserve $source / timestamp from upstream; the SK server
        // will overlay `$source = <pluginId>` on its own, but the
        // upstream timestamp is the moment the alarm fired and is
        // worth keeping.
        filteredUpdates.push({
          ...update,
          values: notificationValues
        })
      }
    }

    if (filteredUpdates.length === 0) return null
    return { updates: filteredUpdates as Delta['updates'] }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return

    this.debug(`Scheduling notification stream reconnect in ${this.reconnectMs}ms`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closed) {
        this.connect()
      }
    }, this.reconnectMs)
  }

  isConnected(): boolean {
    return this.connected
  }

  stop(): void {
    this.closed = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // Ignore close errors
      }
      this.ws = null
    }

    this.connected = false
    this.debug('Stopped notification forwarder')
  }
}

/**
 * Minimum WebSocket surface this module touches. Lets tests inject a
 * stub without importing the full `ws` type tree.
 */
export interface WebSocketLike {
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: WebSocket.RawData) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'close', listener: (code: number) => void): void
  send(data: string): void
  close(): void
}
