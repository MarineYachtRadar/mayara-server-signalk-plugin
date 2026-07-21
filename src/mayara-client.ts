import http from 'http'
import https from 'https'

export interface MayaraClientOptions {
  host: string
  port: number
  secure?: boolean
  timeout?: number
  debug?: (msg: string) => void
}

const API_BASE = '/signalk/v2/api/vessels/self/radars'

export class MayaraClient {
  private host: string
  private port: number
  private secure: boolean
  private timeout: number
  private debug: (msg: string) => void

  constructor(options: MayaraClientOptions) {
    this.host = options.host
    this.port = options.port
    this.secure = options.secure ?? false
    this.timeout = options.timeout ?? 10000
    this.debug = options.debug ?? (() => {})
  }

  async request(method: string, path: string, body: unknown = null): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: this.timeout
      }

      const transport = this.secure ? https : http

      const req = transport.request(options, (res) => {
        let data = ''
        res.on('data', (chunk: string) => (data += chunk))
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? (JSON.parse(data) as unknown) : null)
            } catch {
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

  async getRadars(): Promise<Record<string, unknown>> {
    const response = (await this.request('GET', API_BASE)) as Record<string, unknown>
    // mayara returns the `{ version, radars }` envelope; unwrap to the bare
    // `{ id: RadarInfo }` map so callers can key by radar id (and `Object.keys`
    // yields radar ids, not `version`/`radars`). Tolerate an older bare response.
    const radars = response.radars
    return (radars && typeof radars === 'object' ? radars : response) as Record<string, unknown>
  }

  async getCapabilities(radarId: string): Promise<unknown> {
    return this.request('GET', `${API_BASE}/${radarId}/capabilities`)
  }

  async getControls(radarId: string): Promise<Record<string, unknown>> {
    return (await this.request('GET', `${API_BASE}/${radarId}/controls`)) as Record<string, unknown>
  }

  async setControl(radarId: string, controlId: string, value: unknown): Promise<unknown> {
    return this.request('PUT', `${API_BASE}/${radarId}/controls/${controlId}`, { value })
  }

  async setControls(radarId: string, controls: Record<string, unknown>): Promise<unknown> {
    return this.request('PUT', `${API_BASE}/${radarId}/controls`, controls)
  }

  async getTargets(radarId: string): Promise<unknown> {
    return this.request('GET', `${API_BASE}/${radarId}/targets`)
  }

  async acquireTarget(
    radarId: string,
    bearing: number,
    distance: number
  ): Promise<Record<string, unknown>> {
    return (await this.request('POST', `${API_BASE}/${radarId}/targets/acquire`, {
      bearing,
      distance
    })) as Record<string, unknown>
  }

  async cancelTarget(radarId: string, targetId: number): Promise<unknown> {
    return this.request('DELETE', `${API_BASE}/${radarId}/targets/${targetId}`)
  }

  getSpokeStreamUrl(radarId: string): string {
    const wsProtocol = this.secure ? 'wss' : 'ws'
    return `${wsProtocol}://${this.host}:${this.port}${API_BASE}/${radarId}/spokes`
  }

  getTargetStreamUrl(radarId: string): string {
    const wsProtocol = this.secure ? 'wss' : 'ws'
    return `${wsProtocol}://${this.host}:${this.port}${API_BASE}/${radarId}/targets/stream`
  }

  /**
   * mayara's Signal K v1 stream. Used by NotificationForwarder to relay
   * `notifications.*` and `radars.*` deltas upstream.
   *
   * `?subscribe=none` is deliberate: under Signal K's subscription model the
   * default (`self`) streams own-ship `navigation.*` too, but the plugin must
   * NOT forward nav — mayara only has it because it received it from Signal K
   * in the first place, so re-publishing it would loop it back. Starting from
   * `none` and letting the forwarder subscribe to exactly `radars.*` /
   * `notifications.*` keeps nav (and AIS) out, and stays correct whether mayara
   * treats a later subscribe as additive (SK-compliant) or narrowing.
   */
  getStateStreamUrl(): string {
    const wsProtocol = this.secure ? 'wss' : 'ws'
    return `${wsProtocol}://${this.host}:${this.port}/signalk/v1/stream?subscribe=none`
  }

  close(): void {
    // No persistent connections to close for HTTP client
  }
}
