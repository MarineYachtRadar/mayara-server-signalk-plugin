import { describe, it, expect, vi, afterEach } from 'vitest'
import { NotificationForwarder } from '../src/notification-forwarder'
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

function makeApp() {
  return {
    handleMessage: vi.fn(),
    debug: vi.fn()
  }
}

describe('NotificationForwarder', () => {
  it('subscribes to notifications.* on connect', async () => {
    const port = await createWsServer()
    const app = makeApp()

    const subscriptionReceived = new Promise<string>((resolve) => {
      wss?.on('connection', (ws: WebSocket) => {
        ws.on('message', (data: WebSocket.RawData) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          resolve(buf.toString('utf8'))
        })
      })
    })

    const forwarder = new NotificationForwarder(app, {
      pluginId: 'test-plugin',
      url: `ws://localhost:${port}`,
      reconnectInterval: 100
    })
    forwarder.start()

    const msg = await subscriptionReceived
    const parsed = JSON.parse(msg) as { subscribe: Array<{ path: string; policy: string }> }
    expect(parsed.subscribe).toEqual([{ path: 'notifications.*', policy: 'instant' }])

    forwarder.stop()
  })

  it('forwards notification deltas via handleMessage', async () => {
    const port = await createWsServer()
    const app = makeApp()

    const clientConnected = new Promise<WebSocket>((resolve) => {
      wss?.on('connection', resolve)
    })

    const forwarder = new NotificationForwarder(app, {
      pluginId: 'test-plugin',
      url: `ws://localhost:${port}`,
      reconnectInterval: 100
    })
    forwarder.start()

    const ws = await clientConnected
    // Drain the subscription send.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const delta = {
      updates: [
        {
          $source: 'mayara',
          timestamp: '2026-05-26T00:00:00Z',
          values: [
            {
              path: 'notifications.radar.fur6424A.guardZone.1',
              value: {
                state: 'alert',
                method: ['visual', 'sound'],
                message: 'Radar fur6424A guard zone 1: target acquired'
              }
            }
          ]
        }
      ]
    }
    ws.send(JSON.stringify(delta))

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(app.handleMessage).toHaveBeenCalledTimes(1)
    const [pluginId, forwarded] = app.handleMessage.mock.calls[0] as [string, typeof delta]
    expect(pluginId).toBe('test-plugin')
    expect(forwarded.updates).toHaveLength(1)
    expect(forwarded.updates[0].values).toHaveLength(1)
    expect(forwarded.updates[0].values[0].path).toBe('notifications.radar.fur6424A.guardZone.1')

    forwarder.stop()
  })

  it('drops non-notification paths within a delta', async () => {
    const port = await createWsServer()
    const app = makeApp()

    const clientConnected = new Promise<WebSocket>((resolve) => {
      wss?.on('connection', resolve)
    })

    const forwarder = new NotificationForwarder(app, {
      pluginId: 'test-plugin',
      url: `ws://localhost:${port}`,
      reconnectInterval: 100
    })
    forwarder.start()

    const ws = await clientConnected
    await new Promise((resolve) => setTimeout(resolve, 20))

    // A mixed-path delta — only the notification value should survive.
    ws.send(
      JSON.stringify({
        updates: [
          {
            values: [
              { path: 'navigation.headingTrue', value: 1.2 },
              {
                path: 'notifications.radar.r1.guardZone.1',
                value: { state: 'alert', method: ['visual'], message: 'x' }
              }
            ]
          }
        ]
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(app.handleMessage).toHaveBeenCalledTimes(1)
    const forwarded = app.handleMessage.mock.calls[0][1] as {
      updates: { values: { path: string }[] }[]
    }
    expect(forwarded.updates[0].values).toHaveLength(1)
    expect(forwarded.updates[0].values[0].path).toBe('notifications.radar.r1.guardZone.1')
  })

  it('ignores deltas that carry no notification paths', async () => {
    const port = await createWsServer()
    const app = makeApp()

    const clientConnected = new Promise<WebSocket>((resolve) => {
      wss?.on('connection', resolve)
    })

    const forwarder = new NotificationForwarder(app, {
      pluginId: 'test-plugin',
      url: `ws://localhost:${port}`,
      reconnectInterval: 100
    })
    forwarder.start()

    const ws = await clientConnected
    await new Promise((resolve) => setTimeout(resolve, 20))

    ws.send(
      JSON.stringify({
        updates: [{ values: [{ path: 'navigation.headingTrue', value: 1.2 }] }]
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(app.handleMessage).not.toHaveBeenCalled()

    forwarder.stop()
  })

  it('ignores hello / non-delta messages', async () => {
    const port = await createWsServer()
    const app = makeApp()

    const clientConnected = new Promise<WebSocket>((resolve) => {
      wss?.on('connection', resolve)
    })

    const forwarder = new NotificationForwarder(app, {
      pluginId: 'test-plugin',
      url: `ws://localhost:${port}`,
      reconnectInterval: 100
    })
    forwarder.start()

    const ws = await clientConnected
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Mayara's hello frame and stray garbage must not throw.
    ws.send(JSON.stringify({ name: 'mayara', version: '3.5.3' }))
    ws.send('not json at all')

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(app.handleMessage).not.toHaveBeenCalled()

    forwarder.stop()
  })

  it('stop prevents reconnection', async () => {
    vi.useFakeTimers()
    try {
      const app = makeApp()
      const forwarder = new NotificationForwarder(app, {
        pluginId: 'test-plugin',
        url: 'ws://localhost:1',
        reconnectInterval: 50
      })

      forwarder.start()
      forwarder.stop()

      expect(forwarder.isConnected()).toBe(false)

      // Advance well past the reconnect window to prove stop() cleared
      // the scheduled timer and the forwarder didn't reopen.
      await vi.advanceTimersByTimeAsync(200)
      expect(forwarder.isConnected()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports connected status', async () => {
    const port = await createWsServer()
    const app = makeApp()

    const clientConnected = new Promise<void>((resolve) => {
      wss?.on('connection', () => {
        resolve()
      })
    })

    const forwarder = new NotificationForwarder(app, {
      pluginId: 'test-plugin',
      url: `ws://localhost:${port}`
    })
    expect(forwarder.isConnected()).toBe(false)

    forwarder.start()
    await clientConnected
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(forwarder.isConnected()).toBe(true)

    forwarder.stop()
    expect(forwarder.isConnected()).toBe(false)
  })
})
