import { describe, it, expect, afterEach } from 'vitest'
import http from 'http'
import { MayaraClient } from '../src/mayara-client'

let server: http.Server | undefined
let serverPort: number

function createTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer(handler)
    server.listen(0, () => {
      resolve((server.address() as { port: number }).port)
    })
  })
}

afterEach(() => {
  server?.close()
})

describe('MayaraClient', () => {
  it('makes GET requests and parses JSON', async () => {
    serverPort = await createTestServer((req, res) => {
      expect(req.method).toBe('GET')
      expect(req.url).toBe('/signalk/v2/api/vessels/self/radars')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ radars: { 'radar-0': { id: 'radar-0' } } }))
    })

    const client = new MayaraClient({ host: 'localhost', port: serverPort })
    const result = await client.getRadars()
    expect(result).toEqual({ 'radar-0': { id: 'radar-0' } })
  })

  it('makes PUT requests with body', async () => {
    let receivedBody = ''
    serverPort = await createTestServer((req, res) => {
      expect(req.method).toBe('PUT')
      expect(req.url).toBe('/signalk/v2/api/vessels/self/radars/radar-0/controls/power')
      req.on('data', (chunk: string) => (receivedBody += chunk))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
      })
    })

    const client = new MayaraClient({ host: 'localhost', port: serverPort })
    await client.setControl('radar-0', 'power', 'transmit')
    expect(JSON.parse(receivedBody)).toEqual({ value: 'transmit' })
  })

  it('rejects on HTTP error status', async () => {
    serverPort = await createTestServer((req, res) => {
      res.writeHead(404)
      res.end('Not found')
    })

    const client = new MayaraClient({ host: 'localhost', port: serverPort })
    await expect(client.getRadars()).rejects.toThrow('HTTP 404')
  })

  it('rejects on connection error', async () => {
    const client = new MayaraClient({ host: 'localhost', port: 1, timeout: 1000 })
    await expect(client.getRadars()).rejects.toThrow()
  })

  it('constructs spoke stream URL correctly', () => {
    const client = new MayaraClient({ host: '192.168.1.10', port: 6502 })
    expect(client.getSpokeStreamUrl('radar-0')).toBe(
      'ws://192.168.1.10:6502/signalk/v2/api/vessels/self/radars/radar-0/spokes'
    )
  })

  it('uses wss for secure connections', () => {
    const client = new MayaraClient({ host: '192.168.1.10', port: 6502, secure: true })
    expect(client.getSpokeStreamUrl('radar-0')).toBe(
      'wss://192.168.1.10:6502/signalk/v2/api/vessels/self/radars/radar-0/spokes'
    )
  })

  it('constructs target stream URL correctly', () => {
    const client = new MayaraClient({ host: 'localhost', port: 6502 })
    expect(client.getTargetStreamUrl('radar-0')).toBe(
      'ws://localhost:6502/signalk/v2/api/vessels/self/radars/radar-0/targets/stream'
    )
  })
})
