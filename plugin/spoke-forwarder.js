/**
 * SpokeForwarder - WebSocket client that forwards spoke data to SignalK's binaryStreamManager
 *
 * Connects to mayara-server's spoke WebSocket endpoint and forwards binary data
 * to SignalK's built-in binary stream infrastructure.
 *
 * SignalK clients connect to /signalk/v2/api/vessels/self/radars/{id}/stream
 * and receive the forwarded data automatically.
 */

const WebSocket = require('ws')

class SpokeForwarder {
  /**
   * Create a SpokeForwarder
   * @param {object} options - Configuration options
   * @param {string} options.radarId - The radar ID
   * @param {string} options.url - WebSocket URL for mayara-server spoke stream
   * @param {object} options.binaryStreamManager - SignalK's binaryStreamManager
   * @param {function} options.debug - Debug logging function
   * @param {number} options.reconnectInterval - Reconnect interval in ms (default: 5000)
   */
  constructor({ radarId, url, binaryStreamManager, debug, reconnectInterval = 5000 }) {
    this.radarId = radarId
    this.url = url
    this.binaryStreamManager = binaryStreamManager
    this.debug = debug || (() => {})
    this.reconnectInterval = reconnectInterval

    this.ws = null
    this.reconnectTimer = null
    this.closed = false
    this.connected = false

    // Stream ID for binaryStreamManager (matches SignalK radar stream pattern)
    this.streamId = `radars/${radarId}`
  }

  /**
   * Start the forwarder - connect to mayara-server
   */
  start() {
    if (this.closed) return
    this.connect()
  }

  /**
   * Connect to mayara-server spoke WebSocket
   */
  connect() {
    if (this.closed) return

    this.debug(`Connecting to spoke stream: ${this.url}`)

    try {
      this.ws = new WebSocket(this.url)
      this.ws.binaryType = 'arraybuffer'

      this.ws.on('open', () => {
        this.connected = true
        this.debug(`Connected to spoke stream for ${this.radarId}`)
      })

      this.ws.on('message', (data) => {
        // Forward binary spoke data to SignalK's binaryStreamManager
        if (this.binaryStreamManager && data instanceof ArrayBuffer) {
          const buffer = Buffer.from(data)
          this.binaryStreamManager.emitData(this.streamId, buffer)
        } else if (this.binaryStreamManager && Buffer.isBuffer(data)) {
          this.binaryStreamManager.emitData(this.streamId, data)
        }
      })

      this.ws.on('error', (err) => {
        this.debug(`Spoke stream error for ${this.radarId}: ${err.message}`)
      })

      this.ws.on('close', (code, reason) => {
        this.connected = false
        this.debug(`Spoke stream closed for ${this.radarId}: ${code} ${reason}`)

        if (!this.closed) {
          this.scheduleReconnect()
        }
      })
    } catch (err) {
      this.debug(`Failed to connect to spoke stream for ${this.radarId}: ${err.message}`)
      if (!this.closed) {
        this.scheduleReconnect()
      }
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return

    this.debug(`Scheduling reconnect for ${this.radarId} in ${this.reconnectInterval}ms`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closed) {
        this.connect()
      }
    }, this.reconnectInterval)
  }

  /**
   * Check if the forwarder is connected
   * @returns {boolean}
   */
  isConnected() {
    return this.connected
  }

  /**
   * Stop the forwarder and close the WebSocket
   */
  stop() {
    this.closed = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      try {
        this.ws.close()
      } catch (err) {
        // Ignore close errors
      }
      this.ws = null
    }

    this.connected = false
    this.debug(`Stopped spoke forwarder for ${this.radarId}`)
  }
}

module.exports = SpokeForwarder
