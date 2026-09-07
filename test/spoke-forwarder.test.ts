import { describe, it, expect, vi, afterEach } from 'vitest'
import { SpokeForwarder } from '../src/spoke-forwarder.js'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'

let server: http.Server | null = null
let wss: WebSocketServer | null = null

afterEach(() => {
  wss?.close()
  server?.close()
  wss = null
  server = null
})

function createWsServer(): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer()
    wss = new WebSocketServer({ server })
    const s = server
    s.listen(0, () => {
      resolve((s.address() as { port: number }).port)
    })
  })
}

describe('SpokeForwarder', () => {
  it('forwards binary data to binaryStreamManager', async () => {
    const port = await createWsServer()
    const emitData = vi.fn()

    const forwarder = new SpokeForwarder({
      radarId: 'radar-0',
      url: `ws://localhost:${port}`,
      binaryStreamManager: { emitData },
      reconnectInterval: 100
    })

    const clientConnected = new Promise<WebSocket>((resolve) => {
      const w = wss
      if (w) w.on('connection', resolve)
    })

    forwarder.start()
    const ws = await clientConnected

    const testData = Buffer.from([0x01, 0x02, 0x03, 0x04])
    ws.send(testData)

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(emitData).toHaveBeenCalledTimes(1)
    expect(emitData).toHaveBeenCalledWith('radars/radar-0', expect.any(Buffer))
    expect(Buffer.from(emitData.mock.calls[0][1] as Buffer)).toEqual(testData)

    forwarder.stop()
  })

  it('stop prevents reconnection', async () => {
    const emitData = vi.fn()

    const forwarder = new SpokeForwarder({
      radarId: 'radar-0',
      url: 'ws://localhost:1',
      binaryStreamManager: { emitData },
      reconnectInterval: 50
    })

    forwarder.start()
    forwarder.stop()

    expect(forwarder.isConnected()).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(forwarder.isConnected()).toBe(false)
  })

  it('reports connected status', async () => {
    const port = await createWsServer()
    const emitData = vi.fn()

    const forwarder = new SpokeForwarder({
      radarId: 'radar-0',
      url: `ws://localhost:${port}`,
      binaryStreamManager: { emitData }
    })

    expect(forwarder.isConnected()).toBe(false)

    const clientConnected = new Promise<void>((resolve) => {
      wss?.on('connection', () => {
        resolve()
      })
    })

    forwarder.start()
    await clientConnected
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(forwarder.isConnected()).toBe(true)

    forwarder.stop()
    expect(forwarder.isConnected()).toBe(false)
  })

  // mayara keeps a radar transmitting for every spoke subscriber, so the
  // upstream stream must exist only while a Signal K client is subscribed.
  describe('with a server that counts stream clients', () => {
    it('connects on the first subscriber and closes after the last one', async () => {
      const port = await createWsServer()
      let clients = 0
      const manager = { emitData: vi.fn(), getClientCount: () => clients }
      const upstream: WebSocket[] = []
      wss?.on('connection', (ws) => upstream.push(ws))

      const forwarder = new SpokeForwarder({
        radarId: 'radar-0',
        url: `ws://localhost:${port}`,
        binaryStreamManager: manager,
        watchInterval: 20,
        reconnectInterval: 20
      })

      forwarder.start()
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(upstream).toHaveLength(0)
      expect(forwarder.isConnected()).toBe(false)

      clients = 1
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(upstream).toHaveLength(1)
      expect(forwarder.isConnected()).toBe(true)

      const closed = new Promise<void>((resolve) =>
        upstream[0].on('close', () => {
          resolve()
        })
      )
      clients = 0
      await closed
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(forwarder.isConnected()).toBe(false)
      expect(upstream).toHaveLength(1)

      forwarder.stop()
    })

    it('reconnects after an upstream drop only while still subscribed', async () => {
      const port = await createWsServer()
      let clients = 1
      const manager = { emitData: vi.fn(), getClientCount: () => clients }
      const upstream: WebSocket[] = []
      wss?.on('connection', (ws) => upstream.push(ws))

      const forwarder = new SpokeForwarder({
        radarId: 'radar-0',
        url: `ws://localhost:${port}`,
        binaryStreamManager: manager,
        watchInterval: 20,
        reconnectInterval: 20
      })

      forwarder.start()
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(upstream).toHaveLength(1)

      upstream[0].close()
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(upstream).toHaveLength(2)

      clients = 0
      upstream[1].close()
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(upstream).toHaveLength(2)

      forwarder.stop()
    })
  })
})
