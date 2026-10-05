import { describe, it, expect, afterEach } from 'vitest'
import http from 'http'
import { gzipSync } from 'zlib'
import { WebSocketServer, WebSocket } from 'ws'
import { createGuiProxy, type GuiProxyOptions, type ProxiedRequest } from '../src/gui-proxy.js'

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections()
          s.close(() => {
            resolve()
          })
        })
    )
  )
})

function listen(server: http.Server, host = '127.0.0.1'): Promise<number> {
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      resolve((server.address() as { port: number }).port)
    })
  })
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** An upstream that records each request and answers with `respond`. */
async function upstream(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
    res.end('ok')
  },
  host = '127.0.0.1'
): Promise<{ origin: string; seen: Seen[]; server: http.Server }> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      respond(req, res)
    })
  })
  const port = await listen(server, host)
  const authority = host.includes(':') ? `[${host}]` : host
  return { origin: `http://${authority}:${port}`, seen, server }
}

/**
 * The proxy's own server, standing in for Signal K: `parseJson` drains the
 * request into `req.body` first, the way Signal K's `express.json()` does.
 */
async function front(options: GuiProxyOptions, parseJson = false): Promise<number> {
  const proxy = createGuiProxy(options)
  const server = http.createServer((req: ProxiedRequest, res) => {
    if (!parseJson || !req.headers['content-type']?.includes('json')) {
      proxy.web(req, res)
      return
    }
    void readBody(req).then((raw) => {
      req.body = JSON.parse(raw) as unknown
      proxy.web(req, res)
    })
  })
  server.on('upgrade', (req: http.IncomingMessage, socket, head: Buffer) => {
    proxy.upgrade(req, socket as import('net').Socket, head)
  })
  return listen(server)
}

function request(
  port: number,
  path: string,
  init: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        })
      }
    )
    req.setTimeout(2000, () => {
      req.destroy(new Error(`no response for ${path}`))
    })
    req.on('error', reject)
    req.end(init.body)
  })
}

async function canListen(host: string): Promise<boolean> {
  const server = http.createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, host, resolve)
    })
    server.close()
    return true
  } catch {
    return false
  }
}

const ipv6 = await canListen('::1')

describe('createGuiProxy', () => {
  it('serves GUI assets from /gui and passes API paths through', async () => {
    const up = await upstream()
    const port = await front({ target: () => up.origin })

    await request(port, '/viewer.js')
    await request(port, '/signalk/v2/api/vessels/self/radars')
    await request(port, '/v2/recordings?x=1')

    expect(up.seen.map((s) => s.url)).toEqual([
      '/gui/viewer.js',
      '/signalk/v2/api/vessels/self/radars',
      '/v2/recordings?x=1'
    ])
  })

  it('routes each request to the target chosen for its path', async () => {
    const sk = await upstream((_req, res) => res.end('sk'))
    const mayara = await upstream((_req, res) => res.end('mayara'))
    const port = await front({
      target: (path) => (path.startsWith('/signalk/') ? sk.origin : mayara.origin)
    })

    expect((await request(port, '/signalk/v2/api/x')).body.toString()).toBe('sk')
    expect((await request(port, '/index.html')).body.toString()).toBe('mayara')
  })

  it('sets the Host header to the target and adds X-Forwarded headers', async () => {
    const up = await upstream()
    const port = await front({ target: () => up.origin })

    await request(port, '/x', { headers: { host: 'boat.local:3000' } })

    expect(up.seen[0].headers.host).toBe(new URL(up.origin).host)
    expect(up.seen[0].headers['x-forwarded-host']).toBe('boat.local:3000')
    expect(up.seen[0].headers['x-forwarded-proto']).toBe('http')
  })

  it('streams a response through unchanged, compression included', async () => {
    const zipped = gzipSync('console.log("radar")')
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-encoding': 'gzip' })
      res.end(zipped)
    })
    const port = await front({ target: () => up.origin })

    const reply = await request(port, '/viewer.js', { headers: { 'accept-encoding': 'gzip' } })

    expect(reply.headers['content-encoding']).toBe('gzip')
    expect(reply.body.equals(zipped)).toBe(true)
  })

  it('re-sends a JSON body that a body parser already read', async () => {
    // Without the re-send, mayara gets the Content-Length but no bytes and
    // the control PUT hangs until the browser gives up.
    const up = await upstream()
    const port = await front({ target: () => up.origin }, true)
    const body = JSON.stringify({ value: 'transmit' })

    const reply = await request(port, '/signalk/v2/api/vessels/self/radars/r1/controls/power', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      body
    })

    expect(reply.status).toBe(200)
    expect(up.seen[0].body).toBe(body)
    expect(up.seen[0].headers['content-length']).toBe(String(Buffer.byteLength(body)))
  })

  it('pipes a request body nobody read straight through', async () => {
    const up = await upstream()
    const port = await front({ target: () => up.origin }, true)

    await request(port, '/v2/recordings/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'raw recording bytes'
    })

    expect(up.seen[0].body).toBe('raw recording bytes')
  })

  it('answers 504 when the target is unreachable', async () => {
    const dead = await upstream()
    const origin = dead.origin
    await new Promise<void>((resolve) =>
      dead.server.close(() => {
        resolve()
      })
    )
    const port = await front({ target: () => origin })

    const reply = await request(port, '/viewer.js')

    expect(reply.status).toBe(504)
  })

  it('answers 502 when the target is not a URL', async () => {
    const port = await front({ target: () => 'http://fd00::1:6502' })

    const reply = await request(port, '/viewer.js')

    expect(reply.status).toBe(502)
  })

  it.runIf(ipv6)('connects to a bracketed IPv6 target', async () => {
    const up = await upstream(undefined, '::1')
    const port = await front({ target: () => up.origin })

    const reply = await request(port, '/viewer.js')

    expect(reply.status).toBe(200)
    expect(up.seen[0].url).toBe('/gui/viewer.js')
  })

  describe('WebSocket upgrades', () => {
    async function wsUpstream(): Promise<{ origin: string; paths: string[] }> {
      const paths: string[] = []
      const server = http.createServer()
      const wss = new WebSocketServer({ server })
      wss.on('connection', (ws, req) => {
        paths.push(req.url ?? '')
        ws.on('message', (data, isBinary) => {
          ws.send(data, { binary: isBinary })
        })
      })
      server.on('close', () => {
        wss.close()
      })
      const port = await listen(server)
      return { origin: `http://127.0.0.1:${port}`, paths }
    }

    function open(url: string): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url)
        ws.once('open', () => {
          resolve(ws)
        })
        ws.once('error', reject)
      })
    }

    it('carries binary frames both ways on the unchanged API path', async () => {
      const up = await wsUpstream()
      const port = await front({ target: () => up.origin })
      const ws = await open(`ws://127.0.0.1:${port}/signalk/v2/api/vessels/self/radars/r1/spokes`)

      const echoed = new Promise<{ data: Buffer; isBinary: boolean }>((resolve) => {
        ws.once('message', (data: Buffer, isBinary) => {
          resolve({ data, isBinary })
        })
      })
      ws.send(Buffer.from([1, 2, 3, 250]))
      const { data, isBinary } = await echoed
      ws.close()

      expect(up.paths).toEqual(['/signalk/v2/api/vessels/self/radars/r1/spokes'])
      expect(isBinary).toBe(true)
      expect([...data]).toEqual([1, 2, 3, 250])
    })

    it('drops the client socket when the target is unreachable', async () => {
      const dead = await upstream()
      const origin = dead.origin
      await new Promise<void>((resolve) =>
        dead.server.close(() => {
          resolve()
        })
      )
      const port = await front({ target: () => origin })

      await expect(open(`ws://127.0.0.1:${port}/signalk/v2/api/x`)).rejects.toThrow()
    })
  })
})
