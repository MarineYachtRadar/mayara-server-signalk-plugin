#!/usr/bin/env node
/**
 * Full-stack end-to-end check for @marineyachtradar/signalk-plugin.
 *
 *   signalk-server (real, built from source)
 *     └─ this plugin (real, packed and installed)
 *          └─ HTTP/WS ──> mayara-server (real container)
 *                              └──> real radar hardware
 *
 * Nothing here is mocked. The point is to catch the failures the unit tests
 * structurally cannot: the plugin failing to *load* under ESM, the Radar API
 * provider not registering with the server, the GUI reverse proxy mis-routing,
 * and the federated config panel not being served.
 *
 * This is deliberately NOT part of `npm test` or CI: it needs a mayara-server
 * and, for the radar assertions, actual hardware. Run it by hand:
 *
 *   node test/e2e/run-e2e.mjs
 *
 * Env overrides:
 *   MAYARA_URL   default http://127.0.0.1:6502
 *   SK_REPO      default ~/dev/xxx_signalk-server
 *   SK_PORT      default 3999   (avoid clashing with a real server on 3000)
 *   KEEP         set to keep the throwaway config dir for inspection
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const MAYARA_URL = process.env.MAYARA_URL ?? 'http://127.0.0.1:6502'
const SK_REPO = process.env.SK_REPO ?? join(homedir(), 'dev/xxx_signalk-server')
const SK_PORT = Number(process.env.SK_PORT ?? 3999)
const PLUGIN_ID = 'mayara-server-signalk-plugin'
const PLUGIN_PKG = '@marineyachtradar/signalk-plugin'
const SK = `http://127.0.0.1:${SK_PORT}`
const RADAR_API = `${SK}/signalk/v2/api/vessels/self/radars`

const results = []
let server = null
let configDir = null

const pass = (name, detail = '') => {
  results.push({ ok: true, name, detail })
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}
const fail = (name, detail = '') => {
  results.push({ ok: false, name, detail })
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
}
const step = (msg) => console.log(`\n▶ ${msg}`)

async function check(name, fn) {
  try {
    const detail = await fn()
    pass(name, detail ?? '')
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err))
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

/** Every request gets a hard timeout so a wedged server stalls one check, not the run. */
const HTTP_TIMEOUT_MS = 10000
const withTimeout = (init) => ({ signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), ...init })

async function getJson(url, init) {
  const res = await fetch(url, withTimeout(init))
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, ok: res.ok, body, headers: res.headers }
}

/** Poll until `fn()` resolves truthy, or throw after `timeoutMs`. */
async function waitFor(label, fn, timeoutMs = 60000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`)
}

function cleanup() {
  // `.killed` only records that a signal was *sent* — it stays false after a
  // natural exit — so it cannot answer "is this still running?". Use the exit
  // state, or we signal a pid the OS may since have recycled.
  const running = server && server.exitCode === null && server.signalCode === null
  if (running) {
    try {
      process.kill(-server.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  if (configDir && !process.env.KEEP) {
    try {
      rmSync(configDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  } else if (configDir) {
    console.log(`\nconfig dir kept: ${configDir}`)
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})
// Without this a `kill` of the harness leaves the detached signalk-server
// running and the temp config dir behind.
process.on('SIGTERM', () => {
  cleanup()
  process.exit(143)
})

// ---------------------------------------------------------------------------

step('Preflight')

await check('mayara-server reachable', async () => {
  const r = await getJson(`${MAYARA_URL}/signalk/v2/api/vessels/self/radars`)
  assert(r.ok, `GET /radars -> ${r.status}`)
  const radars = r.body?.radars ?? r.body
  const ids = Object.keys(radars ?? {})
  assert(ids.length > 0, 'mayara reports no radars')
  return `${ids.length} radar(s): ${ids.join(', ')}`
})

await check('signalk-server is built', async () => {
  const entry = join(SK_REPO, 'bin/signalk-server')
  assert(existsSync(entry), `${entry} missing — is SK_REPO right?`)
  assert(
    existsSync(join(SK_REPO, 'dist')),
    `${SK_REPO}/dist missing — run \`npm run build\` in the server repo`
  )
  return SK_REPO
})

// ---------------------------------------------------------------------------

step('Provision a throwaway Signal K config dir')

configDir = mkdtempSync(join(tmpdir(), 'mayara-e2e-'))
mkdirSync(join(configDir, 'node_modules'), { recursive: true })

await check('pack + install the plugin into the config dir', async () => {
  const repo = process.cwd()
  // Build first: `npm pack` does NOT run prepublishOnly, so without this the
  // harness would happily test a stale plugin/ and public/ from a previous run.
  execFileSync('npm', ['run', 'build'], { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
  const tgz = execFileSync('npm', ['pack', '--silent'], { cwd: repo, encoding: 'utf8' }).trim()
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', join(repo, tgz)], {
    cwd: configDir,
    encoding: 'utf8',
    stdio: 'pipe'
  })
  rmSync(join(repo, tgz), { force: true })
  const installed = join(configDir, 'node_modules', PLUGIN_PKG, 'package.json')
  assert(existsSync(installed), 'plugin not present in config dir node_modules')
  const pkg = JSON.parse(execFileSync('cat', [installed], { encoding: 'utf8' }))
  assert(pkg.type === 'module', `expected ESM package, got type=${pkg.type ?? '(none)'}`)
  return `${pkg.name}@${pkg.version} (type=module)`
})

// Enable the plugin, pointed at the external mayara (no container management).
const mayara = new URL(MAYARA_URL)
mkdirSync(join(configDir, 'plugin-config-data'), { recursive: true })
writeFileSync(
  join(configDir, 'plugin-config-data', `${PLUGIN_ID}.json`),
  JSON.stringify(
    {
      enabled: true,
      configuration: {
        managedContainer: false,
        host: mayara.hostname,
        port: Number(mayara.port || (mayara.protocol === 'https:' ? 443 : 80)),
        secure: mayara.protocol === 'https:',
        requestSignalkToken: false,
        discoveryPollInterval: 5,
        reconnectInterval: 5
      }
    },
    null,
    2
  )
)
writeFileSync(
  join(configDir, 'settings.json'),
  JSON.stringify({ port: SK_PORT, interfaces: {}, pipedProviders: [] }, null, 2)
)

// ---------------------------------------------------------------------------

step('Boot signalk-server with the plugin')

const logPath = join(configDir, 'server.log')
const logFd = (await import('node:fs')).openSync(logPath, 'a')
server = spawn(process.execPath, [join(SK_REPO, 'bin/signalk-server'), '-c', configDir], {
  cwd: SK_REPO,
  stdio: ['ignore', logFd, logFd],
  detached: true,
  env: { ...process.env, PORT: String(SK_PORT) }
})

await check('server answers /signalk', async () => {
  await waitFor('signalk endpoint', async () => (await getJson(`${SK}/signalk`)).ok, 90000)
  return SK
})

await check('plugin loaded (appears in /plugins)', async () => {
  const r = await waitFor(
    'plugin list',
    async () => {
      const res = await getJson(`${SK}/plugins`)
      if (!res.ok || !Array.isArray(res.body)) return null
      const found = res.body.find((p) => p.id === PLUGIN_ID)
      return found ?? null
    },
    60000
  )
  assert(r.enabled !== false, 'plugin present but not enabled')
  return `${r.id} v${r.version ?? '?'} enabled=${r.enabled}`
})

// ---------------------------------------------------------------------------

step('Plugin HTTP surface')

await check('GET /status reports connected', async () => {
  const r = await waitFor(
    'plugin /status connected',
    async () => {
      const res = await getJson(`${SK}/plugins/${PLUGIN_ID}/status`)
      return res.ok && res.body?.connected ? res.body : null
    },
    60000
  )
  return `connected, ${r.radars.length} radar(s): ${r.radars.join(', ')}`
})

await check('GET /api/gui-url', async () => {
  const r = await getJson(`${SK}/plugins/${PLUGIN_ID}/api/gui-url`)
  assert(r.ok, `status ${r.status}`)
  return JSON.stringify(r.body).slice(0, 120)
})

// ---------------------------------------------------------------------------

step('Radar API — the provider registration that unit tests cannot prove')

let radarIds = []

await check('GET /radars returns the {version,radars} envelope', async () => {
  const r = await waitFor(
    'radar discovery',
    async () => {
      const res = await getJson(RADAR_API)
      return res.ok && Object.keys(res.body?.radars ?? {}).length ? res.body : null
    },
    60000
  )
  assert(typeof r.version === 'string', 'missing version field')
  radarIds = Object.keys(r.radars)
  return `version=${r.version}, radars=${radarIds.join(', ')}`
})

await check('RadarInfo is the lean v3.4.0 shape', async () => {
  const r = await getJson(RADAR_API)
  const info = r.body.radars[radarIds[0]]
  const keys = Object.keys(info).sort()
  assert(typeof info.name === 'string', 'name missing')
  assert(typeof info.brand === 'string', 'brand missing')
  assert(typeof info.radarIpAddress === 'string', 'radarIpAddress missing')
  // The lean type deliberately drops live state and stream URLs.
  for (const gone of ['status', 'controls', 'range', 'spokesPerRevolution', 'maxSpokeLen']) {
    assert(!(gone in info), `lean RadarInfo should not carry '${gone}'`)
  }
  return keys.join(',')
})

await check('GET /radars/:id', async () => {
  const r = await getJson(`${RADAR_API}/${radarIds[0]}`)
  assert(r.ok, `status ${r.status}`)
  return `${radarIds[0]} -> ${r.body?.name ?? '?'}`
})

await check('GET /radars/:id/state returns live state', async () => {
  const r = await getJson(`${RADAR_API}/${radarIds[0]}/state`)
  assert(r.ok, `status ${r.status}`)
  assert(r.body && typeof r.body === 'object', 'no state body')
  const status = r.body.status ?? r.body.state?.status
  return `status=${status ?? '?'}, controls=${Object.keys(r.body.controls ?? {}).length}`
})

await check('GET /radars/:id/capabilities', async () => {
  const r = await getJson(`${RADAR_API}/${radarIds[0]}/capabilities`)
  assert(r.ok, `status ${r.status}`)
  const n = Object.keys(r.body?.controls ?? r.body ?? {}).length
  return `${n} capability field(s)`
})

await check('GET /radars/_providers lists this plugin', async () => {
  const r = await getJson(`${RADAR_API}/_providers`)
  assert(r.ok, `status ${r.status}`)
  const s = JSON.stringify(r.body)
  assert(s.includes(PLUGIN_ID) || s.includes('MaYaRa'), `plugin not listed: ${s.slice(0, 160)}`)
  return s.slice(0, 120)
})

// ---------------------------------------------------------------------------

step('Spoke stream (binary radar data through the plugin forwarder)')

await check('spoke WebSocket delivers binary frames', async () => {
  // Only a transmitting radar emits spokes. In standby the socket should still
  // open — that alone proves SpokeForwarder registered the stream with the
  // server's binaryStreamManager — but no frames will arrive, so treat a
  // frameless open as a pass and say so.
  const { default: WebSocket } = await import('ws')
  const url = `ws://127.0.0.1:${SK_PORT}/signalk/v2/api/vessels/self/radars/${radarIds[0]}/spokes`
  const ws = new WebSocket(url)
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ opened: ws.readyState === 1, frames: 0 }), 6000)
    let frames = 0
    let bytes = 0
    let textFrames = 0
    ws.on('message', (data, isBinary) => {
      // Spokes are binary. A text frame here means the stream is carrying
      // something other than radar data, which should fail rather than count.
      if (!isBinary) {
        textFrames += 1
        clearTimeout(timer)
        resolve({ opened: true, frames, bytes, textFrames })
        return
      }
      frames += 1
      bytes += data.length ?? 0
      if (frames >= 3) {
        clearTimeout(timer)
        resolve({ opened: true, frames, bytes, textFrames })
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      resolve({ opened: false, error: err.message })
    })
  })
  ws.close()
  assert(outcome.opened, `socket did not open: ${outcome.error ?? 'unknown'}`)
  assert(
    !outcome.textFrames,
    `spoke stream sent ${outcome.textFrames} text frame(s), expected binary`
  )
  return outcome.frames > 0
    ? `${outcome.frames} frame(s), ${outcome.bytes} bytes`
    : 'socket open, no frames (radar in standby — expected)'
})

// ---------------------------------------------------------------------------

step('GUI reverse proxy (the SSL-only regression area)')

await check('GET /gui/ proxies mayara assets', async () => {
  const res = await fetch(`${SK}/plugins/${PLUGIN_ID}/gui/`, withTimeout({ redirect: 'manual' }))
  // 2xx or a redirect only. A 404 here means the proxy mounted but routed
  // nowhere, which is exactly the regression this check exists to catch.
  assert(res.status < 400, `status ${res.status}`)
  return `status ${res.status}`
})

await check('/gui passthrough reaches mayara /signalk', async () => {
  const r = await getJson(`${SK}/plugins/${PLUGIN_ID}/gui/signalk`)
  assert(r.ok, `status ${r.status}`)
  return typeof r.body === 'object' ? Object.keys(r.body).join(',') : String(r.body).slice(0, 80)
})

// ---------------------------------------------------------------------------

step('Config panel (federated remote served by the plugin)')

await check('remoteEntry.js is served and is an ES module', async () => {
  const res = await fetch(`${SK}/${PLUGIN_PKG}/remoteEntry.js`, withTimeout())
  assert(res.ok, `status ${res.status}`)
  const body = await res.text()
  assert(/\bexport\s*\{/.test(body), 'remoteEntry is not an ES module (no export statement)')
  assert(/\bas get\b/.test(body) && /\bas init\b/.test(body), 'missing get/init exports')
  return `${body.length} bytes, exports get+init`
})

await check('webapp index.html is served', async () => {
  const res = await fetch(`${SK}/${PLUGIN_PKG}/`, withTimeout())
  assert(res.ok, `status ${res.status}`)
  const html = await res.text()
  return `${html.length} bytes`
})

// ---------------------------------------------------------------------------

step('Shutdown')

await check('plugin stops cleanly (no unhandled errors in log)', async () => {
  const child = server
  // If the server already died (crash on boot, port clash) there will never be
  // another 'exit' event, so check that first rather than waiting on one.
  const alreadyGone = child.exitCode !== null || child.signalCode !== null
  const exited = alreadyGone
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve))
  if (!alreadyGone) process.kill(-child.pid, 'SIGTERM')
  // Wait for the process to actually go away rather than assuming a delay is
  // enough; fall back to SIGKILL so a hung server can't wedge the run.
  const timedOut = alreadyGone
    ? false
    : await Promise.race([
        exited.then(() => false),
        new Promise((r) => setTimeout(() => r(true), 15000))
      ])
  if (timedOut) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    await exited
  }
  // Cleared so the exit handler does not signal a recycled pid.
  server = null
  assert(!timedOut, 'server did not exit within 15s of SIGTERM')
  assert(
    !alreadyGone,
    `server had already exited before shutdown (code=${child.exitCode}, signal=${child.signalCode})`
  )
  const log = execFileSync('cat', [logPath], { encoding: 'utf8' })
  const bad = log
    .split('\n')
    .filter((l) => /UnhandledPromiseRejection|ERR_MODULE_NOT_FOUND|Cannot find module/.test(l))
  assert(bad.length === 0, `${bad.length} module/rejection error(s): ${bad[0]?.slice(0, 160)}`)
  return 'clean'
})

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok)
console.log(`\n${'='.repeat(60)}`)
console.log(`E2E: ${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('\nFailures:')
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`)
  console.log(`\nServer log: ${logPath}`)
}
console.log('='.repeat(60))
process.exit(failed.length ? 1 : 0)
