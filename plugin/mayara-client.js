/**
 * HTTP client for mayara-server REST API
 *
 * Provides methods to communicate with mayara-server's /v2/api/radars/* endpoints.
 */

const http = require('http')
const https = require('https')

class MayaraClient {
  constructor({ host, port, secure = false, timeout = 10000, debug = () => {} }) {
    this.host = host
    this.port = port
    this.secure = secure
    this.timeout = timeout
    this.debug = debug
    this.baseUrl = `${secure ? 'https' : 'http'}://${host}:${port}`
  }

  /**
   * Make an HTTP request to mayara-server
   * @param {string} method - HTTP method (GET, PUT, POST, DELETE)
   * @param {string} path - API path (e.g., /v2/api/radars)
   * @param {object|null} body - Request body (for PUT/POST)
   * @returns {Promise<any>} - Parsed JSON response
   */
  async request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path: path,
        method: method,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: this.timeout
      }

      const transport = this.secure ? https : http

      const req = transport.request(options, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : null)
            } catch (e) {
              resolve(data)
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`))
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Request timeout'))
      })

      if (body) {
        req.write(JSON.stringify(body))
      }
      req.end()
    })
  }

  // ============================================
  // Radar Discovery
  // ============================================

  /**
   * Get list of all radars
   * @returns {Promise<object>} - Object keyed by radar ID
   */
  async getRadars() {
    return this.request('GET', '/v2/api/radars')
  }

  // ============================================
  // Capabilities & State
  // ============================================

  /**
   * Get capability manifest for a radar
   * @param {string} radarId - The radar ID
   * @returns {Promise<object>} - CapabilityManifest
   */
  async getCapabilities(radarId) {
    return this.request('GET', `/v2/api/radars/${radarId}/capabilities`)
  }

  /**
   * Get current state for a radar
   * @param {string} radarId - The radar ID
   * @returns {Promise<object>} - RadarState
   */
  async getState(radarId) {
    return this.request('GET', `/v2/api/radars/${radarId}/state`)
  }

  // ============================================
  // Controls
  // ============================================

  /**
   * Set a single control value
   * @param {string} radarId - The radar ID
   * @param {string} controlId - The control ID (e.g., "power", "gain")
   * @param {any} value - The value to set
   * @returns {Promise<object>} - Result
   */
  async setControl(radarId, controlId, value) {
    return this.request('PUT', `/v2/api/radars/${radarId}/controls/${controlId}`, { value })
  }

  /**
   * Set multiple controls at once
   * @param {string} radarId - The radar ID
   * @param {object} controls - Object with controlId: value pairs
   * @returns {Promise<object>} - Result
   */
  async setControls(radarId, controls) {
    return this.request('PUT', `/v2/api/radars/${radarId}/controls`, controls)
  }

  // ============================================
  // ARPA Targets
  // ============================================

  /**
   * Get all tracked ARPA targets
   * @param {string} radarId - The radar ID
   * @returns {Promise<object>} - TargetListResponse
   */
  async getTargets(radarId) {
    return this.request('GET', `/v2/api/radars/${radarId}/targets`)
  }

  /**
   * Manually acquire a target at bearing/distance
   * @param {string} radarId - The radar ID
   * @param {number} bearing - Bearing in degrees (0-360)
   * @param {number} distance - Distance in meters
   * @returns {Promise<object>} - Result with targetId
   */
  async acquireTarget(radarId, bearing, distance) {
    return this.request('POST', `/v2/api/radars/${radarId}/targets`, { bearing, distance })
  }

  /**
   * Cancel tracking of a target
   * @param {string} radarId - The radar ID
   * @param {number} targetId - The target ID to cancel
   * @returns {Promise<object>} - Result
   */
  async cancelTarget(radarId, targetId) {
    return this.request('DELETE', `/v2/api/radars/${radarId}/targets/${targetId}`)
  }

  // ============================================
  // WebSocket URLs
  // ============================================

  /**
   * Get WebSocket URL for spoke streaming
   * @param {string} radarId - The radar ID
   * @returns {string} - WebSocket URL
   */
  getSpokeStreamUrl(radarId) {
    const wsProtocol = this.secure ? 'wss' : 'ws'
    return `${wsProtocol}://${this.host}:${this.port}/v2/api/radars/${radarId}/spokes`
  }

  /**
   * Get WebSocket URL for target streaming
   * @param {string} radarId - The radar ID
   * @returns {string} - WebSocket URL
   */
  getTargetStreamUrl(radarId) {
    const wsProtocol = this.secure ? 'wss' : 'ws'
    return `${wsProtocol}://${this.host}:${this.port}/v2/api/radars/${radarId}/targets/stream`
  }

  /**
   * Close any persistent connections (none for HTTP client)
   */
  close() {
    // No persistent connections to close for HTTP client
  }
}

module.exports = MayaraClient
