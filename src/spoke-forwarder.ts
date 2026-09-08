import WebSocket from 'ws'
import type { BinaryStreamManager } from './types.js'

export interface SpokeForwarderOptions {
  radarId: string
  url: string
  binaryStreamManager: BinaryStreamManager
  debug?: (msg: string) => void
  reconnectInterval?: number
  /** How often to check whether anyone is subscribed downstream. */
  watchInterval?: number
}

const DEFAULT_WATCH_INTERVAL_MS = 1000

export class SpokeForwarder {
  private radarId: string
  private url: string
  private binaryStreamManager: BinaryStreamManager
  private debug: (msg: string) => void
  private reconnectMs: number

  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private watchTimer: ReturnType<typeof setInterval> | null = null
  private watchMs: number
  private closed = false
  private connected = false
  private streamId: string

  constructor(options: SpokeForwarderOptions) {
    this.radarId = options.radarId
    this.url = options.url
    this.binaryStreamManager = options.binaryStreamManager
    this.debug = options.debug ?? (() => {})
    this.reconnectMs = options.reconnectInterval ?? 5000
    this.watchMs = options.watchInterval ?? DEFAULT_WATCH_INTERVAL_MS
    this.streamId = `radars/${options.radarId}`
  }

  // mayara counts every spoke subscriber as someone watching the radar and
  // keeps it transmitting for them, so the upstream stream is only held
  // while a Signal K client is actually subscribed to ours.
  start(): void {
    if (this.closed) return
    if (!this.binaryStreamManager.getClientCount) {
      this.connect()
      return
    }
    this.watch()
    this.watchTimer = setInterval(() => {
      this.watch()
    }, this.watchMs)
  }

  private watched(): boolean {
    return (this.binaryStreamManager.getClientCount?.(this.streamId) ?? 1) > 0
  }

  private watch(): void {
    if (this.closed) return
    if (this.watched()) {
      // A pending reconnect keeps its backoff; the watch only opens the
      // stream for a new first subscriber.
      if (!this.ws && !this.reconnectTimer) this.connect()
    } else if (this.ws || this.reconnectTimer) {
      this.debug(`No subscribers for ${this.radarId}, closing spoke stream`)
      this.disconnect()
    }
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      try {
        ws.close()
      } catch {
        // Closing a socket that never finished connecting is the only way
        // this throws, and there is nothing left to release then.
      }
    }
    this.connected = false
  }

  private connect(): void {
    if (this.closed || this.ws) return

    this.debug(`Connecting to spoke stream: ${this.url}`)

    try {
      const ws = new WebSocket(this.url)
      this.ws = ws

      ws.on('open', () => {
        this.connected = true
        this.debug(`Connected to spoke stream for ${this.radarId}`)
      })

      ws.on('message', (data: WebSocket.RawData) => {
        let buf: Buffer
        if (Buffer.isBuffer(data)) {
          buf = data
        } else if (data instanceof ArrayBuffer) {
          buf = Buffer.from(data)
        } else if (Array.isArray(data)) {
          buf = Buffer.concat(data)
        } else {
          return
        }
        if (buf.length > 0) {
          this.binaryStreamManager.emitData(this.streamId, buf)
        }
      })

      ws.on('error', (err: Error) => {
        this.connected = false
        this.debug(`Spoke stream error for ${this.radarId}: ${err.message}`)
      })

      ws.on('close', (code: number) => {
        this.debug(`Spoke stream closed for ${this.radarId}: ${code}`)

        // A close we asked for has already let go of this socket; only an
        // upstream drop while still watched is worth retrying.
        if (this.ws !== ws) return
        this.ws = null
        this.connected = false
        if (!this.closed && this.watched()) this.scheduleReconnect()
      })
    } catch (err) {
      this.debug(
        `Failed to connect to spoke stream for ${this.radarId}: ${err instanceof Error ? err.message : String(err)}`
      )
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return

    this.debug(`Scheduling reconnect for ${this.radarId} in ${this.reconnectMs}ms`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closed && this.watched()) {
        this.connect()
      }
    }, this.reconnectMs)
  }

  isConnected(): boolean {
    return this.connected
  }

  stop(): void {
    this.closed = true

    if (this.watchTimer) {
      clearInterval(this.watchTimer)
      this.watchTimer = null
    }
    this.disconnect()
    this.debug(`Stopped spoke forwarder for ${this.radarId}`)
  }
}
