import { ServerResponse, type ClientRequest, type IncomingMessage } from 'node:http'
import { type Socket } from 'node:net'
import { stringify as stringifyQuery, type ParsedUrlQueryInput } from 'node:querystring'
import { createProxyServer, type ProxyServerOptions, type ProxyTargetDetailed } from 'httpxy'
import { rewriteGuiProxyPath } from './gui-proxy-path.js'

/** An incoming request, possibly already read into `body` by Signal K's body parsers. */
export type ProxiedRequest = IncomingMessage & { body?: unknown }

export interface GuiProxyOptions {
  /**
   * Origin (`http://host:port`) to forward a request to, resolved per
   * request from its path as the `/gui` mount hands it over: the
   * `/plugins/<id>/gui` prefix stripped, before `rewriteGuiProxyPath`.
   */
  target: (path: string) => string
}

export interface GuiProxy {
  web(req: ProxiedRequest, res: ServerResponse): void
  upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void
}

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT'])

/**
 * Same-origin reverse proxy for mayara's GUI, its API and its WebSocket
 * streams, so the browser only ever talks to the Signal K port.
 */
export function createGuiProxy(options: GuiProxyOptions): GuiProxy {
  const proxy = createProxyServer({})

  proxy.on('proxyReq', (proxyReq, req) => {
    resendParsedBody(proxyReq, req)
  })
  // With a listener attached, httpxy reports failures here instead of
  // rejecting the web()/ws() promise.
  proxy.on('error', (err, _req, res) => {
    fail(err, res)
  })

  const forwardOptions = (path: string): ProxyServerOptions => ({
    target: proxyTarget(options.target(path)),
    changeOrigin: true,
    // Accept the Signal K loopback's self-signed cert when SK runs on https.
    secure: false,
    xfwd: true
  })

  return {
    web(req, res) {
      const path = req.url ?? '/'
      let opts: ProxyServerOptions
      try {
        opts = forwardOptions(path)
      } catch (err) {
        fail(err, res)
        return
      }
      req.url = rewriteGuiProxyPath(path)
      proxy.web(req, res, opts).catch((err: unknown) => {
        fail(err, res)
      })
    },

    upgrade(req, socket, head) {
      const path = req.url ?? '/'
      let opts: ProxyServerOptions
      try {
        opts = forwardOptions(path)
      } catch (err) {
        fail(err, socket)
        return
      }
      req.url = rewriteGuiProxyPath(path)
      proxy.ws(req, socket, opts, head).catch((err: unknown) => {
        fail(err, socket)
      })
    }
  }
}

/**
 * httpxy hands a URL's bracketed IPv6 hostname (`[fd00::1]`) to DNS instead
 * of connecting to the address, so pass the host without brackets.
 */
function proxyTarget(origin: string): ProxyTargetDetailed {
  const url = new URL(origin)
  return {
    protocol: url.protocol,
    hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port
  }
}

/**
 * Signal K mounts `express.json()` ahead of plugin routers, so a PUT/POST
 * reaches the proxy with its stream already read into `req.body`. httpxy
 * would then forward the original Content-Length with no bytes behind it,
 * and mayara would wait for a body that never comes. Write the parsed body
 * out again; httpxy's pipe of the spent stream then ends the request.
 */
function resendParsedBody(proxyReq: ClientRequest, req: ProxiedRequest): void {
  // A stream nobody read still carries its body, and httpxy pipes it as is.
  if (!req.readableEnded || req.body === undefined) return
  const type = req.headers['content-type'] ?? ''
  let data: string
  if (type.includes('application/json') || type.includes('+json')) {
    data = JSON.stringify(req.body)
  } else if (type.includes('application/x-www-form-urlencoded')) {
    data = stringifyQuery(req.body as ParsedUrlQueryInput)
  } else if (type.includes('text/plain') && typeof req.body === 'string') {
    data = req.body
  } else {
    return
  }
  // The body parser has already decoded any compression.
  proxyReq.removeHeader('content-encoding')
  proxyReq.removeHeader('transfer-encoding')
  proxyReq.setHeader('content-length', Buffer.byteLength(data))
  proxyReq.write(data)
}

function fail(err: unknown, res: ServerResponse | Socket | undefined): void {
  if (!res) return
  if (!(res instanceof ServerResponse)) {
    res.destroy()
    return
  }
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  res.writeHead(code && UNREACHABLE_CODES.has(code) ? 504 : 502, {
    'content-type': 'text/plain; charset=utf-8'
  })
  res.end(`mayara GUI proxy: ${code ?? (err instanceof Error ? err.message : String(err))}`)
}
