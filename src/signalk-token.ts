import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { request as httpsRequest } from 'https'

const TOKEN_FILENAME = 'signalk-token'
const POLL_INTERVAL_MS = 5_000

/** Minimal response shape both transports below resolve to. */
interface JsonResponse {
  status: number
  ok: boolean
  json: () => Promise<unknown>
}

/**
 * Issue a JSON request to the local Signal K server and resolve the
 * parsed body lazily (matching the `fetch` Response surface this module
 * already uses: `.status`, `.ok`, `.json()`).
 *
 * Plain HTTP goes through global `fetch` unchanged. HTTPS goes through
 * `node:https` with `rejectUnauthorized: false`, because Signal K's
 * loopback TLS cert is self-signed *and* its SAN never contains
 * `127.0.0.1` (SK generates a `CN=localhost`/no-SAN cert; other SK cert
 * tooling covers only the LAN hostname/IP) — so neither plain `fetch`
 * nor CA-trust can validate a `https://127.0.0.1` connection. Skipping
 * verification is safe here: the request never leaves the loopback
 * interface, so there is no MITM surface, and it mirrors what Signal K's
 * own outbound client does for self-signed peers (`rejectUnauthorized:
 * !selfsignedcert`). `node:https` is a built-in, so this needs no extra
 * dependency and no per-request `undici` dispatcher.
 *
 * The transport is chosen by the URL scheme, not a flag: only `https:`
 * URLs (which this module builds solely for the loopback `127.0.0.1`
 * host) get the verification-disabled `node:https` path, so an absolute
 * `http://` href can never accidentally route through it.
 */
async function requestJson(
  method: 'GET' | 'POST',
  url: string,
  body: string | undefined,
  extraHeaders?: Record<string, string>
): Promise<JsonResponse> {
  const headers: Record<string, string> = { ...extraHeaders }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const hasHeaders = Object.keys(headers).length > 0

  if (!url.startsWith('https:')) {
    const res = await fetch(url, {
      method,
      headers: hasHeaders ? headers : undefined,
      body
    })
    return { status: res.status, ok: res.ok, json: () => res.json() }
  }

  return new Promise<JsonResponse>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method,
        rejectUnauthorized: false,
        headers: hasHeaders ? headers : undefined
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status,
            ok: status >= 200 && status < 300,
            json: () => Promise.resolve(text ? (JSON.parse(text) as unknown) : undefined)
          })
        })
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

export type EnsureResult =
  | { kind: 'cached'; token: string }
  | { kind: 'no-security' }
  | { kind: 'requests-disabled' }
  | { kind: 'pending'; requestId: string; href: string }
  | { kind: 'error'; message: string }

export interface EnsureOptions {
  dataDir: string
  signalkPort: number
  /**
   * True when the local Signal K server is TLS-enabled. Switches the
   * access-request POST to `https://127.0.0.1` with verification
   * disabled (see `requestJson`). Defaults to false (plain HTTP) to
   * preserve the historical path.
   */
  ssl?: boolean
  clientId: string
  description: string
  permissions?: 'readonly' | 'readwrite' | 'admin'
}

/**
 * Read a cached token from `${dataDir}/signalk-token` if present and
 * non-empty (after trim). Returns `undefined` otherwise. This is the
 * fast path — the token, once admin-approved, is stable across restarts.
 */
export function readCachedToken(dataDir: string): string | undefined {
  const path = join(dataDir, TOKEN_FILENAME)
  if (!existsSync(path)) return undefined
  const raw = readFileSync(path, 'utf8').trim()
  return raw.length > 0 ? raw : undefined
}

/**
 * The absolute host-side path of the cached token file under `dataDir`.
 * Returned regardless of whether the file currently exists — callers
 * who only want to mount it should pair this with `hasCachedToken`.
 */
export function tokenFilePath(dataDir: string): string {
  return join(dataDir, TOKEN_FILENAME)
}

/** True iff the cached token file exists on disk. Cheaper than reading. */
export function hasCachedToken(dataDir: string): boolean {
  return existsSync(join(dataDir, TOKEN_FILENAME))
}

/**
 * Persist `token` to `${dataDir}/signalk-token` with mode 0600. The
 * single file ensures the on-disk format stays simple (no JSON parsing
 * to corrupt) and the mode keeps the secret readable only to the
 * Signal K server process owner.
 */
export function writeCachedToken(dataDir: string, token: string): void {
  const path = join(dataDir, TOKEN_FILENAME)
  writeFileSync(path, token, { mode: 0o600 })
}

/** Remove the cached token (e.g. after the server revoked it). No-op if absent. */
export function deleteCachedToken(dataDir: string): void {
  rmSync(join(dataDir, TOKEN_FILENAME), { force: true })
}

export interface ValidateOptions {
  token: string
  signalkPort: number
  ssl: boolean
}

/**
 * Check whether a cached token is still accepted by the local Signal K
 * server. Returns:
 *   - `valid`   — the server accepted the bearer (HTTP 2xx)
 *   - `revoked` — the server rejected it (HTTP 401/403): the admin revoked
 *                 or it expired, so the cache should be dropped and re-requested
 *   - `unknown` — could not tell (network error, SK still starting, other
 *                 status). Treated as "keep using it" so a transient blip
 *                 doesn't throw away a good token.
 *
 * Hits `/signalk/v1/api/vessels/self` — a read every approved device token
 * may perform — over the same loopback transport the token flow uses.
 */
export async function validateCachedToken(
  opts: ValidateOptions
): Promise<'valid' | 'revoked' | 'unknown'> {
  const scheme = opts.ssl ? 'https' : 'http'
  const url = `${scheme}://127.0.0.1:${opts.signalkPort}/signalk/v1/api/vessels/self`
  try {
    const res = await requestJson('GET', url, undefined, {
      Authorization: `Bearer ${opts.token}`
    })
    if (res.status === 401 || res.status === 403) return 'revoked'
    if (res.ok) return 'valid'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

interface AccessRequestReply {
  state: 'PENDING' | 'COMPLETED'
  requestId: string
  statusCode: number
  href?: string
  message?: string
  accessRequest?: { permission?: string; token?: string }
}

/**
 * Begin a Signal K device access request and resolve when it transitions
 * out of PENDING. Returns one of:
 *   - `{ kind: 'cached', token }` when the cache was hit before this call
 *     was made (callers should usually check `readCachedToken` first; this
 *     is a safety net).
 *   - `{ kind: 'no-security' }` when SK has security disabled — no token
 *     is needed; callers should connect anonymously.
 *   - `{ kind: 'requests-disabled' }` when SK is secured but the admin has
 *     turned off device access requests; surface this so the user can
 *     either enable it or paste a token by hand.
 *   - `{ kind: 'pending', requestId, href, cancel }` once SK has accepted
 *     the request and is waiting for admin approval. The caller can:
 *       - await `awaitApproval(href, log)` to block until decision
 *       - call `cancel()` to stop the in-flight poller on plugin stop()
 *   - `{ kind: 'error', message }` on any other failure path.
 *
 * Polling is server-side via `GET /signalk/v1/requests/:id`; we don't try
 * to subscribe to SK's notification path because the access-request flow
 * is intentionally HTTP-driven.
 */
export async function beginTokenRequest(opts: EnsureOptions): Promise<EnsureResult> {
  const cached = readCachedToken(opts.dataDir)
  if (cached) return { kind: 'cached', token: cached }

  const scheme = opts.ssl ? 'https' : 'http'
  const url = `${scheme}://127.0.0.1:${opts.signalkPort}/signalk/v1/access/requests`
  let res: JsonResponse
  try {
    res = await requestJson(
      'POST',
      url,
      JSON.stringify({
        clientId: opts.clientId,
        description: opts.description,
        permissions: opts.permissions ?? 'readonly'
      })
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: 'error', message: `POST ${url} failed: ${msg}` }
  }

  if (res.status === 404) {
    // SK serves 404 here only when the dummy (no-security) strategy is
    // active. Tokens are neither minted nor needed.
    return { kind: 'no-security' }
  }
  if (res.status === 403) {
    return { kind: 'requests-disabled' }
  }
  if (res.status !== 202 && res.status !== 200) {
    return { kind: 'error', message: `Unexpected HTTP ${res.status} from access-request endpoint` }
  }

  const reply = (await res.json()) as AccessRequestReply
  if (reply.state === 'COMPLETED') {
    // Unusual but possible — approval already on file. Cache + return.
    const token = reply.accessRequest?.token
    if (token) {
      writeCachedToken(opts.dataDir, token)
      return { kind: 'cached', token }
    }
    return { kind: 'error', message: 'Access request completed without a token' }
  }
  if (!reply.href) {
    return { kind: 'error', message: 'Access request response missing href' }
  }

  // The polling loop lives in `awaitApproval` so the caller can race it
  // against its own shutdown signal (typically the plugin's stop()).
  return {
    kind: 'pending',
    requestId: reply.requestId,
    href: reply.href
  }
}

/**
 * Poll `${href}` until it transitions out of PENDING, then return the
 * issued token. Stops if `isCancelled()` returns true between polls (so
 * plugin.stop() can break the loop). Returns `undefined` if the request
 * is denied or expires server-side.
 *
 * The href returned by SK is a relative path like
 * `/signalk/v1/requests/<uuid>`; we resolve it against
 * `${scheme}://127.0.0.1:${signalkPort}` (https when `ssl`).
 *
 * `pollIntervalMs` defaults to 5s in production (an admin clicking
 * approve is a slow human action; we don't need to poll faster than
 * that). Tests override it to single-digit milliseconds.
 *
 * `ssl` is a trailing optional so the existing positional callers keep
 * working; defaults to plain HTTP.
 */
export async function awaitApproval(
  href: string,
  signalkPort: number,
  isCancelled: () => boolean,
  log: (msg: string) => void,
  pollIntervalMs: number = POLL_INTERVAL_MS,
  ssl: boolean = false
): Promise<string | undefined> {
  const scheme = ssl ? 'https' : 'http'
  const url = href.startsWith('http')
    ? href
    : `${scheme}://127.0.0.1:${signalkPort}${href.startsWith('/') ? '' : '/'}${href}`

  while (!isCancelled()) {
    await sleep(pollIntervalMs)
    if (isCancelled()) return undefined

    let res: JsonResponse
    try {
      res = await requestJson('GET', url, undefined)
    } catch (err) {
      log(
        `Token poll fetch failed (will retry): ${err instanceof Error ? err.message : String(err)}`
      )
      continue
    }
    if (!res.ok) {
      log(`Token poll: HTTP ${res.status} (will retry)`)
      continue
    }
    const reply = (await res.json()) as AccessRequestReply
    if (reply.state === 'PENDING') {
      continue
    }
    // COMPLETED. Either an approved request (has token) or a denied one.
    const token = reply.accessRequest?.token
    if (token) return token

    const perm = reply.accessRequest?.permission
    log(
      `Access request completed without a token (permission=${perm ?? 'unknown'}). ` +
        `Admin probably denied the request.`
    )
    return undefined
  }
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
