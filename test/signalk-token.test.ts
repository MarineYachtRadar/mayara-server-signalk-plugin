import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import type { RequestOptions } from 'https'

// The module imports `request` from 'https' for its TLS path. ESM
// namespace exports aren't spy-able, so mock the module and drive the
// exported mock per test via `httpsRequestMock`. `vi.hoisted` makes the
// mock fn available inside the hoisted `vi.mock` factory.
const { httpsRequestMock } = vi.hoisted(() => ({ httpsRequestMock: vi.fn() }))
vi.mock('https', () => ({ request: httpsRequestMock }))

import {
  awaitApproval,
  beginTokenRequest,
  readCachedToken,
  writeCachedToken
} from '../src/signalk-token'

let dataDir: string
let originalFetch: typeof globalThis.fetch

/**
 * Program the mocked `https.request` to capture the URL + options and
 * replay `status`/`body`. Returns the captured args for assertions. The
 * module calls it as `request(url, options, callback)`.
 */
function stubHttpsRequest(status: number, body: unknown) {
  const captured: { url?: string; options?: RequestOptions } = {}
  httpsRequestMock.mockImplementation(
    (url: string, options: RequestOptions, cb: (res: EventEmitter) => void) => {
      captured.url = url
      captured.options = options
      const res = new EventEmitter() as EventEmitter & { statusCode: number }
      res.statusCode = status
      // Defer so the caller can attach .on('data'/'end') first.
      queueMicrotask(() => {
        res.emit('data', Buffer.from(JSON.stringify(body)))
        res.emit('end')
      })
      const req = new EventEmitter() as EventEmitter & {
        write: () => void
        end: () => void
      }
      req.write = () => {}
      req.end = () => {}
      cb(res)
      return req
    }
  )
  return captured
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mayara-token-test-'))
  originalFetch = globalThis.fetch
  httpsRequestMock.mockReset()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  rmSync(dataDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeFetchResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('signalk-token: cache helpers', () => {
  it('readCachedToken returns undefined when file missing', () => {
    expect(readCachedToken(dataDir)).toBeUndefined()
  })

  it('readCachedToken trims and returns the token', () => {
    writeFileSync(join(dataDir, 'signalk-token'), '  eyJabc.def\n')
    expect(readCachedToken(dataDir)).toBe('eyJabc.def')
  })

  it('readCachedToken treats an empty file as absent', () => {
    writeFileSync(join(dataDir, 'signalk-token'), '   \n')
    expect(readCachedToken(dataDir)).toBeUndefined()
  })

  it('writeCachedToken persists with mode 0600', () => {
    writeCachedToken(dataDir, 'eyJabc.def')
    const path = join(dataDir, 'signalk-token')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('eyJabc.def')
    // Skip the mode assertion on Windows where chmod is a no-op.
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })
})

describe('signalk-token: beginTokenRequest', () => {
  it('returns kind=cached when a token is already on disk', async () => {
    writeFileSync(join(dataDir, 'signalk-token'), 'cached-tok')
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: 'test',
      description: 'test'
    })
    expect(result).toEqual({ kind: 'cached', token: 'cached-tok' })
  })

  it('returns kind=no-security on HTTP 404', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(makeFetchResponse(404, { message: 'security off' }))
    )
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: 'test',
      description: 'test'
    })
    expect(result).toEqual({ kind: 'no-security' })
  })

  it('returns kind=requests-disabled on HTTP 403', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(makeFetchResponse(403, {})))
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: 'test',
      description: 'test'
    })
    expect(result).toEqual({ kind: 'requests-disabled' })
  })

  it('returns kind=pending with the href when SK accepts the request', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        makeFetchResponse(202, {
          state: 'PENDING',
          requestId: 'req-123',
          statusCode: 202,
          href: '/signalk/v1/requests/req-123'
        })
      )
    )
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: 'test',
      description: 'test'
    })
    expect(result).toEqual({
      kind: 'pending',
      requestId: 'req-123',
      href: '/signalk/v1/requests/req-123'
    })
  })

  it('caches the token and returns kind=cached when SK already has approval on file', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        makeFetchResponse(200, {
          state: 'COMPLETED',
          requestId: 'req-abc',
          statusCode: 200,
          accessRequest: { permission: 'APPROVED', token: 'instant-tok' }
        })
      )
    )
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: 'test',
      description: 'test'
    })
    expect(result).toEqual({ kind: 'cached', token: 'instant-tok' })
    expect(readCachedToken(dataDir)).toBe('instant-tok')
  })

  it('returns kind=error on network failure', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')))
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: 'test',
      description: 'test'
    })
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.message).toContain('ECONNREFUSED')
    }
  })

  it('uses the POST endpoint with the clientId and permissions', async () => {
    const captured: { url?: string; init?: RequestInit } = {}
    globalThis.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      // url is one of string|URL|Request — stringify safely (URL has its
      // own toString; Request exposes .url).
      captured.url = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      captured.init = init
      return Promise.resolve(
        makeFetchResponse(202, {
          state: 'PENDING',
          requestId: 'r',
          statusCode: 202,
          href: '/x'
        })
      )
    })
    await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: 'mayara-test',
      description: 'Mayara Radar test',
      permissions: 'readonly'
    })
    expect(captured.url).toBe('http://127.0.0.1:3000/signalk/v1/access/requests')
    expect(captured.init?.method).toBe('POST')
    const body = JSON.parse(captured.init?.body as string) as Record<string, string>
    expect(body.clientId).toBe('mayara-test')
    expect(body.permissions).toBe('readonly')
  })

  it('posts over https with verification disabled when ssl is true', async () => {
    // A TLS-enabled SK serves the access-request API only over https
    // (plain HTTP 302-redirects and drops the POST body). The cert is
    // self-signed with no 127.0.0.1 SAN, so verification must be off.
    const captured = stubHttpsRequest(202, {
      state: 'PENDING',
      requestId: 'req-tls',
      statusCode: 202,
      href: '/signalk/v1/requests/req-tls'
    })
    // Fail loudly if it wrongly takes the plain-fetch path.
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('fetch should not be used for ssl')))

    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3443,
      ssl: true,
      clientId: 'mayara-test',
      description: 'Mayara Radar test',
      permissions: 'readwrite'
    })

    expect(result).toEqual({
      kind: 'pending',
      requestId: 'req-tls',
      href: '/signalk/v1/requests/req-tls'
    })
    expect(captured.url).toBe('https://127.0.0.1:3443/signalk/v1/access/requests')
    expect(captured.options?.rejectUnauthorized).toBe(false)
  })

  it('stays on http (global fetch) when ssl is omitted', async () => {
    // Regression guard: the default path must not touch https.request.
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(makeFetchResponse(202, { state: 'PENDING', requestId: 'r', href: '/x' }))
    )
    await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: 'mayara-test',
      description: 'x'
    })
    expect(httpsRequestMock).not.toHaveBeenCalled()
  })
})

describe('signalk-token: awaitApproval', () => {
  it('returns the token when the request transitions to COMPLETED with a token', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(() => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve(makeFetchResponse(200, { state: 'PENDING', requestId: 'r' }))
      }
      return Promise.resolve(
        makeFetchResponse(200, {
          state: 'COMPLETED',
          requestId: 'r',
          accessRequest: { permission: 'APPROVED', token: 'approved-tok' }
        })
      )
    })
    const token = await awaitApproval(
      '/signalk/v1/requests/r',
      3000,
      () => false,
      () => {},
      5
    )
    expect(token).toBe('approved-tok')
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('returns undefined when the admin denies (COMPLETED without a token)', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        makeFetchResponse(200, {
          state: 'COMPLETED',
          requestId: 'r',
          accessRequest: { permission: 'DENIED' }
        })
      )
    )
    const token = await awaitApproval(
      '/signalk/v1/requests/r',
      3000,
      () => false,
      () => {},
      5
    )
    expect(token).toBeUndefined()
  })

  it('returns undefined when isCancelled becomes true mid-poll', async () => {
    let cancelled = false
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(makeFetchResponse(200, { state: 'PENDING', requestId: 'r' }))
    )
    setTimeout(() => {
      cancelled = true
    }, 20)
    const token = await awaitApproval(
      '/signalk/v1/requests/r',
      3000,
      () => cancelled,
      () => {},
      5
    )
    expect(token).toBeUndefined()
  })

  it('resolves a relative href against http://127.0.0.1:port', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      urls.push(typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url)
      return Promise.resolve(
        makeFetchResponse(200, {
          state: 'COMPLETED',
          requestId: 'r',
          accessRequest: { token: 't' }
        })
      )
    })
    await awaitApproval(
      '/signalk/v1/requests/r',
      4321,
      () => false,
      () => {},
      5
    )
    expect(urls[0]).toBe('http://127.0.0.1:4321/signalk/v1/requests/r')
  })

  it('resolves a relative href against https with verification off when ssl is true', async () => {
    const captured = stubHttpsRequest(200, {
      state: 'COMPLETED',
      requestId: 'r',
      accessRequest: { token: 'tls-token' }
    })
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('fetch should not be used for ssl')))

    const token = await awaitApproval(
      '/signalk/v1/requests/r',
      3443,
      () => false,
      () => {},
      5,
      true
    )
    expect(token).toBe('tls-token')
    expect(captured.url).toBe('https://127.0.0.1:3443/signalk/v1/requests/r')
    expect(captured.options?.rejectUnauthorized).toBe(false)
  })
})
