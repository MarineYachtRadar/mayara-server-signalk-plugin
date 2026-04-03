import http from 'http'
import https from 'https'

export interface MayaraClientOptions {
  host: string
  port: number
  secure?: boolean
  timeout?: number
  debug?: (msg: string) => void
}

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
    const data = (await this.request('GET', '/signalk/v2/api/vessels/self/radars')) as Record<
      string,
      unknown
    >
    if (data.radars && typeof data.radars === 'object') {
      return data.radars as Record<string, unknown>
    }
    return data
  }

  private unwrapRadar(data: unknown, radarId: string, field: string): unknown {
    const obj = data as Record<string, unknown>
    const radars = obj.radars as Record<string, Record<string, unknown>> | undefined
    if (radars?.[radarId]?.[field]) {
      return radars[radarId][field]
    }
    return data
  }

  async getCapabilities(radarId: string): Promise<unknown> {
    const data = await this.request(
      'GET',
      `/signalk/v2/api/vessels/self/radars/${radarId}/capabilities`
    )
    return this.unwrapRadar(data, radarId, 'capabilities')
  }

  async getState(radarId: string): Promise<Record<string, unknown> | null> {
    const data = await this.request(
      'GET',
      `/signalk/v2/api/vessels/self/radars/${radarId}/controls`
    )
    const controls = this.unwrapRadar(data, radarId, 'controls') as Record<string, unknown>
    const power = controls.power as Record<string, unknown> | undefined
    return {
      status: power?.value === 2 ? 'transmit' : power?.value === 1 ? 'standby' : 'off',
      controls
    }
  }

  async setControl(radarId: string, controlId: string, value: unknown): Promise<unknown> {
    return this.request(
      'PUT',
      `/signalk/v2/api/vessels/self/radars/${radarId}/controls/${controlId}`,
      { value }
    )
  }

  async setControls(radarId: string, controls: Record<string, unknown>): Promise<unknown> {
    return this.request('PUT', `/signalk/v2/api/vessels/self/radars/${radarId}/controls`, controls)
  }

  async getTargets(radarId: string): Promise<unknown> {
    return this.request('GET', `/signalk/v2/api/vessels/self/radars/${radarId}/targets`)
  }

  async acquireTarget(
    radarId: string,
    bearing: number,
    distance: number
  ): Promise<Record<string, unknown>> {
    return (await this.request('POST', `/signalk/v2/api/vessels/self/radars/${radarId}/targets`, {
      bearing,
      distance
    })) as Record<string, unknown>
  }

  async cancelTarget(radarId: string, targetId: number): Promise<unknown> {
    return this.request(
      'DELETE',
      `/signalk/v2/api/vessels/self/radars/${radarId}/targets/${targetId}`
    )
  }

  getSpokeStreamUrl(radarId: string): string {
    const wsProtocol = this.secure ? 'wss' : 'ws'
    return `${wsProtocol}://${this.host}:${this.port}/signalk/v2/api/vessels/self/radars/${radarId}/spokes`
  }

  getTargetStreamUrl(radarId: string): string {
    const wsProtocol = this.secure ? 'wss' : 'ws'
    return `${wsProtocol}://${this.host}:${this.port}/signalk/v2/api/vessels/self/radars/${radarId}/targets/stream`
  }

  close(): void {
    // No persistent connections to close for HTTP client
  }
}
