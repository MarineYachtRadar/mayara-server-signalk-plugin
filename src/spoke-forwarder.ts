import WebSocket from 'ws'

interface BinaryStreamManager {
  emitData(streamId: string, data: Buffer): void
}

export interface SpokeForwarderOptions {
  radarId: string
  url: string
  binaryStreamManager: BinaryStreamManager
  debug?: (msg: string) => void
  reconnectInterval?: number
}

export class SpokeForwarder {
  private radarId: string
  private url: string
  private binaryStreamManager: BinaryStreamManager
  private debug: (msg: string) => void
  private reconnectMs: number

  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private connected = false
  private streamId: string

  constructor(options: SpokeForwarderOptions) {
    this.radarId = options.radarId
    this.url = options.url
    this.binaryStreamManager = options.binaryStreamManager
    this.debug = options.debug ?? (() => {})
    this.reconnectMs = options.reconnectInterval ?? 5000
    this.streamId = `radars/${options.radarId}`
  }

  start(): void {
    if (this.closed) return
    this.connect()
  }

  private connect(): void {
    if (this.closed) return

    this.debug(`Connecting to spoke stream: ${this.url}`)

    try {
      this.ws = new WebSocket(this.url)

      this.ws.on('open', () => {
        this.connected = true
        this.debug(`Connected to spoke stream for ${this.radarId}`)
      })

      this.ws.on('message', (data: WebSocket.RawData) => {
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

      this.ws.on('error', (err: Error) => {
        this.connected = false
        this.debug(`Spoke stream error for ${this.radarId}: ${err.message}`)
      })

      this.ws.on('close', (code: number) => {
        this.connected = false
        this.debug(`Spoke stream closed for ${this.radarId}: ${code}`)

        if (!this.closed) {
          this.scheduleReconnect()
        }
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
    this.debug(`Stopped spoke forwarder for ${this.radarId}`)
  }
}
