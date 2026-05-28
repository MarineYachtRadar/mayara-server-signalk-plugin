import { Plugin } from '@signalk/server-api'
import { Request, Response, IRouter } from 'express'
import { type IncomingMessage } from 'http'
import { Server as NetServer, type Socket } from 'net'
import {
  createProxyMiddleware,
  responseInterceptor,
  type RequestHandler
} from 'http-proxy-middleware'
import { MayaraClient } from './mayara-client'
import { createRadarProvider } from './radar-provider'
import { SpokeForwarder } from './spoke-forwarder'
import { NotificationForwarder } from './notification-forwarder'
import {
  ContainerConfig,
  ContainerManagerApi,
  ContainerResourceLimits,
  MayaraServerAPI
} from './types'
import { ConfigSchema, Config, SCHEMA_DEFAULTS } from './config/schema'
import {
  awaitApproval,
  beginTokenRequest,
  readCachedToken,
  writeCachedToken
} from './signalk-token'

const MAYARA_IMAGE = 'ghcr.io/marineyachtradar/mayara-server'
const CONTAINER_NAME = 'mayara-server'
const PLUGIN_ID = 'mayara-server-signalk-plugin'
const SAFE_TAG = /^[a-zA-Z0-9._-]+$/
// Same-origin path the SK server forwards to mayara-server's :6502.
// Keeps the browser on the SK port (3000 / 443), so HTTPS works and
// only one firewall port needs to be open.
const GUI_PROXY_PATH = `/plugins/${PLUGIN_ID}/gui`

/**
 * Sensible default resource limits for the mayara-server container.
 * Tested on a Pi 5 8GB with a Garmin xHD2 radar at 24 NM range.
 *
 * Users can override any field via signalk-container's plugin config
 * under "Per-container resource overrides", keyed by the unprefixed
 * container name `mayara-server`. Field-level merge — set a field to
 * `null` to remove a limit set here. See:
 *
 *   signalk-container/doc/plugin-developer-guide.md §"Resource Limits"
 */
const DEFAULT_RESOURCES: ContainerResourceLimits = {
  cpus: 2,
  memory: '512m',
  memorySwap: '512m', // = memory → swap disabled (recommended on Pi/eMMC)
  pidsLimit: 200
}

/**
 * Typed accessor for the cross-plugin container manager API. Returns
 * undefined if signalk-container has not finished start() yet, or if
 * the user has it disabled. Callers should always handle undefined.
 */
function getContainerManager(): ContainerManagerApi | undefined {
  return globalThis.__signalk_containerManager
}

module.exports = function (app: MayaraServerAPI): Plugin {
  let client: MayaraClient | null = null
  let currentSettings: Partial<Config> | null = null
  const spokeForwarders = new Map<string, SpokeForwarder>()
  // Single instance: mayara emits notifications on the server-wide v1
  // stream, not per-radar, so we only need one connection regardless of
  // how many radars are discovered.
  let notificationForwarder: NotificationForwarder | null = null
  let discoveryInterval: ReturnType<typeof setInterval> | null = null
  // Set true on stop() so the in-flight token poller exits its loop.
  let tokenPollerCancelled = false
  let reconnectInterval: ReturnType<typeof setInterval> | null = null
  let isConnected = false
  const knownRadars = new Set<string>()
  // Track the WebSocket upgrade listener so stop() can detach it.
  // The HTTP server outlives plugin restarts (disable/enable, config
  // saves), so leaving the listener registered would accumulate one
  // per restart cycle and cause duplicate proxy.upgrade() calls.
  let upgradeListener: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null = null
  let upgradeListenerServer: NetServer | null = null

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'MaYaRa Radar (Server)',
    description: 'Connect SignalK to mayara-server for multi-brand marine radar integration',

    schema: ConfigSchema,

    start(config: Partial<Config>) {
      app.debug('Starting mayara-server-signalk-plugin')
      // Signal K does not seed schema defaults into the runtime config —
      // when the plugin is auto-enabled (or enabled without saving the
      // form), `config` is `{}`. Merge defaults so callers can rely on
      // every field being present.
      const merged: Config = { ...SCHEMA_DEFAULTS, ...config }
      currentSettings = merged
      // Reset the poller cancel flag so a stop/start cycle (config
      // change, plugin disable/enable) lets the next start make a
      // fresh token request.
      tokenPollerCancelled = false
      void asyncStart(merged).catch((err: unknown) => {
        app.setPluginError(`Startup failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    },

    async stop() {
      app.debug('Stopping mayara-server-signalk-plugin')

      // Tell any in-flight token poller to exit on its next tick so
      // it doesn't keep the process alive after stop() returns.
      tokenPollerCancelled = true

      try {
        app.radarApi.unRegister(PLUGIN_ID)
      } catch (err) {
        app.debug(`Error unregistering radar provider: ${errMsg(err)}`)
      }

      if (discoveryInterval) {
        clearInterval(discoveryInterval)
        discoveryInterval = null
      }
      if (reconnectInterval) {
        clearInterval(reconnectInterval)
        reconnectInterval = null
      }

      for (const forwarder of spokeForwarders.values()) {
        forwarder.stop()
      }
      spokeForwarders.clear()
      knownRadars.clear()

      if (notificationForwarder) {
        notificationForwarder.stop()
        notificationForwarder = null
      }

      if (client) {
        client.close()
        client = null
      }

      // Clean up the managed container and the update registration so
      // we don't leave orphans behind when the user disables the plugin.
      // Requires Signal K ≥ 2.24.0 (where Plugin.stop() may be async).
      const containers = getContainerManager()
      if (containers && currentSettings?.managedContainer !== false) {
        try {
          containers.updates.unregister(PLUGIN_ID)
        } catch (err) {
          app.debug(`Error unregistering update tracker: ${errMsg(err)}`)
        }
        try {
          await containers.stop(CONTAINER_NAME)
        } catch (err) {
          app.debug(`Error stopping mayara-server container: ${errMsg(err)}`)
        }
      }

      if (upgradeListener && upgradeListenerServer) {
        upgradeListenerServer.removeListener('upgrade', upgradeListener)
        upgradeListener = null
        upgradeListenerServer = null
      }

      isConnected = false
      app.setPluginStatus('Stopped')
    },

    registerWithRouter(router: IRouter) {
      // Same-origin reverse proxy to mayara-server's :6502. The icon
      // click in the SK admin lands on the splash page (public/
      // index.html), which redirects to `${GUI_PROXY_PATH}/`. From
      // there the browser only ever talks to the SK server, so HTTPS
      // works without mixed content and only the SK port needs to be
      // open externally.
      //
      // `router` flag rewriter resolves the target on every request,
      // so changes to host/port in the plugin config take effect
      // without restarting the plugin (matches the live read in
      // /api/gui-url).
      // Rewrite the absolute `ws://host:port/...` URLs mayara puts in
      // its radar-list JSON to same-origin paths the browser can reach
      // via this proxy. control.js opens `new WebSocket(streamUrl)` on
      // the value verbatim, so without this the GUI would try to talk
      // directly to mayara's port (defeating the whole point).
      const rewriteStreamUrl = (raw: string): string => {
        try {
          const u = new URL(raw)
          // Map mayara's /signalk/... paths to /plugins/<id>/gui/signalk/...
          // (the `/gui` mount is where ws-upgrade dispatch hooks in).
          return `${GUI_PROXY_PATH}${u.pathname}${u.search}`
        } catch {
          return raw
        }
      }

      const guiProxy: RequestHandler = createProxyMiddleware({
        router: () => {
          const host = currentSettings?.host ?? 'localhost'
          const port = currentSettings?.port ?? 6502
          const proto = currentSettings?.secure ? 'https' : 'http'
          return `${proto}://${host}:${port}`
        },
        // `router.use('/gui', guiProxy)` strips the `/gui` prefix
        // before the middleware sees the request, so the proxy
        // receives paths like `/` (for the GUI root) and
        // `/signalk/v2/api/...` (for the WebSocket-emitting REST API).
        // mayara-server serves its UI at `/gui/...` but its API +
        // WebSockets at `/signalk/...`. We need both classes of
        // request to reach mayara, so prepend `/gui` ONLY for paths
        // that aren't already `/signalk/...`.
        target: 'http://localhost:6502', // overridden by `router`
        changeOrigin: true,
        // Do NOT let the middleware auto-subscribe to the server's `upgrade`
        // event. It would see the raw `/plugins/<id>/gui/signalk/...` URL,
        // which `pathRewrite` can't strip the mount prefix from (it only
        // knows `/signalk/` vs not), so the upgrade reaches mayara at a bogus
        // `/gui/...` path and 404s. The manual `upgradeListener` below strips
        // the prefix first, then calls `guiProxy.upgrade()`. With `ws: true`
        // that manual call is a no-op (it guards on `wsInternalSubscribed`),
        // so the two handlers fight and the wrong one wins. Keep this false.
        ws: false,
        xfwd: true,
        followRedirects: false,
        pathRewrite: (path) => (path.startsWith('/signalk/') ? path : `/gui${path}`),
        selfHandleResponse: true,
        on: {
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- responseInterceptor returns a function whose Promise return value is awaited by node-http-proxy internally.
          proxyRes: responseInterceptor((buffer, proxyRes, req) => {
            const ct = proxyRes.headers['content-type'] ?? ''
            // Only the radar-list JSON contains stream URLs we need
            // to rewrite. Everything else (HTML, JS, CSS, binary
            // images, other JSON) passes through untouched.
            if (
              ct.includes('application/json') &&
              req.url?.includes('/signalk/v2/api/vessels/self/radars')
            ) {
              try {
                const json = JSON.parse(buffer.toString('utf8')) as Record<
                  string,
                  { streamUrl?: string; spokeDataUrl?: string }
                >
                for (const radar of Object.values(json)) {
                  if (radar.streamUrl) radar.streamUrl = rewriteStreamUrl(radar.streamUrl)
                  if (radar.spokeDataUrl) radar.spokeDataUrl = rewriteStreamUrl(radar.spokeDataUrl)
                }
                return Promise.resolve(JSON.stringify(json))
              } catch {
                return Promise.resolve(buffer)
              }
            }
            return Promise.resolve(buffer)
          })
        }
      })

      // WebSocket upgrades fire at the Node HTTP-server level, not
      // through Express, so we need an `upgrade` listener on the
      // server itself. The server isn't exposed through the documented
      // Plugin API — but every incoming Express request reaches it via
      // `req.socket.server`, which is Node's public HTTP API. Wrap the
      // proxy with a one-shot middleware that captures the server on
      // the first request and installs a path-filtered upgrade handler.
      // Other plugins / SK itself add their own upgrade listeners for
      // their own paths; they coexist because each returns early on
      // non-matching URLs.
      // Install the WS upgrade listener as soon as any HTTP request
      // hits the plugin router. WebSocket upgrades fire at the Node
      // HTTP-server level (not through Express), and the documented
      // Plugin API doesn't expose the server. Every incoming Express
      // request reaches it via `req.socket.server` (Node's public
      // HTTP API), so we grab it on first hit and register a
      // path-filtered upgrade handler. The handler reference is
      // stored in module scope so stop() can detach it on plugin
      // restart.
      router.use((req: Request, _res: Response, next) => {
        if (!upgradeListener) {
          // Express types `req.socket` as net.Socket, but at runtime it has
          // a `.server` back-reference to the Node server. Match on
          // `net.Server` (the common base) rather than `http.Server`: with
          // SSL enabled, Signal K's listener is an `https.Server`, which
          // extends `tls.Server`/`net.Server` — NOT `http.Server` — so an
          // `instanceof http.Server` check fails and the WS upgrade listener
          // is never installed (streams hang under https). `app.server` is
          // SK-internal and flagged by the upstream plugin-CI lint, so this
          // back-reference is the only documented public path to the server.
          const wsServer = (req.socket as Socket & { server?: NetServer }).server
          if (wsServer instanceof NetServer) {
            const prefix = `${GUI_PROXY_PATH}/`
            upgradeListener = (upReq: IncomingMessage, socket: Socket, head: Buffer) => {
              if (upReq.url && upReq.url.startsWith(prefix)) {
                // Strip the `/plugins/<id>/gui` prefix so the proxy
                // sees the same path shape as for HTTP requests
                // (where Express' router.use('/gui', ...) does the
                // stripping). pathRewrite then handles the
                // `/signalk/` vs `/gui/...` split uniformly.
                const stripped = upReq.url.slice(GUI_PROXY_PATH.length) || '/'
                upReq.url = stripped
                guiProxy.upgrade(upReq, socket, head)
              }
            }
            wsServer.on('upgrade', upgradeListener)
            upgradeListenerServer = wsServer
            app.debug(`Mounted mayara GUI proxy at ${GUI_PROXY_PATH} (with WS upgrade)`)
          } else {
            app.debug(
              'HTTP server unavailable on req.socket; WS streams to mayara GUI will not be proxied'
            )
          }
        }
        next()
      })
      router.use('/gui', guiProxy)

      router.get('/status', async (_req: Request, res: Response) => {
        const containers = getContainerManager()
        let containerState: string = 'unknown'
        let containerImage = ''

        if (containers) {
          try {
            containerState = await containers.getState(CONTAINER_NAME)
          } catch (err) {
            app.debug(`status: getState failed: ${errMsg(err)}`)
          }

          if (containers.getRuntime()) {
            try {
              const list = await containers.listContainers()
              const found = list.find((c) => c.name === `sk-${CONTAINER_NAME}`)
              if (found) containerImage = found.image
            } catch (err) {
              app.debug(`status: listContainers failed: ${errMsg(err)}`)
            }
          }
        }

        if (!containerImage) {
          containerImage = `${MAYARA_IMAGE}:${currentSettings?.mayaraVersion ?? 'latest'}`
        }

        res.json({
          connected: isConnected,
          radars: Array.from(knownRadars),
          spokeForwarders: Array.from(spokeForwarders.keys()).map((id) => ({
            radarId: id,
            connected: spokeForwarders.get(id)?.isConnected() ?? false
          })),
          notificationForwarder: {
            connected: notificationForwarder?.isConnected() ?? false
          },
          container: {
            state: containerState,
            image: containerImage,
            managed: currentSettings?.managedContainer !== false
          }
        })
      })

      // Update detection: delegated to signalk-container's centralized
      // update service. Mayara no longer fetches GitHub releases or shells
      // out to `podman inspect` itself — the container manager handles all
      // of that, with offline tolerance, persistent caching, and per-tag
      // strategy auto-detection (semver vs floating-tag digest drift).
      router.get('/api/update/check', async (_req: Request, res: Response) => {
        const containers = getContainerManager()
        if (!containers) {
          res.status(503).json({ error: 'signalk-container not available' })
          return
        }
        try {
          const result = await containers.updates.checkOne(PLUGIN_ID)
          res.json(result)
        } catch (err) {
          res.status(500).json({ error: errMsg(err) })
        }
      })

      router.post('/api/update/apply', async (req: Request, res: Response) => {
        const containers = getContainerManager()
        if (!containers) {
          res.status(503).json({ error: 'signalk-container not available' })
          return
        }

        // Tag override from the request body, fallback to current setting,
        // fallback to "latest". The body is optional — POSTing with no body
        // applies whatever the user has selected in the config panel.
        const body = (req.body ?? {}) as { tag?: unknown }
        const tag =
          (typeof body.tag === 'string' ? body.tag : undefined) ??
          currentSettings?.mayaraVersion ??
          'latest'
        if (!SAFE_TAG.test(tag)) {
          res.status(400).json({ error: 'Invalid tag format' })
          return
        }

        try {
          app.setPluginStatus(`Pulling mayara-server:${tag}...`)
          await containers.pullImage(`${MAYARA_IMAGE}:${tag}`)

          app.setPluginStatus('Recreating mayara-server container...')
          await containers.remove(CONTAINER_NAME)
          // After remove(), the container is gone. If ensureRunning() fails
          // (image pull race, port conflict, podman daemon hiccup), we have
          // no way to roll back to the previous state — the old container's
          // ID and config are gone. Surface a clear error so the user knows
          // they need to retry the apply rather than seeing a generic 500.
          try {
            await containers.ensureRunning(CONTAINER_NAME, buildContainerConfig(tag))
          } catch (recreateErr) {
            const msg = `Container removed but recreation failed: ${errMsg(recreateErr)}. Click Update again to retry.`
            app.setPluginError(msg)
            res.status(500).json({ error: msg })
            return
          }

          // Persist the new tag to disk so a plugin restart doesn't roll
          // back to the previous version. We update the in-memory copy
          // first (for immediate consistency with /api/update/check) and
          // then call app.savePluginOptions() to write through to
          // ${dataDir}/plugin-config-data/mayara-server-signalk-plugin.json.
          // signalk-container's update service picks up the new
          // currentTag() value on the next scheduled check.
          if (currentSettings) {
            currentSettings.mayaraVersion = tag
            await new Promise<void>((resolve) => {
              app.savePluginOptions({ ...currentSettings }, (err: NodeJS.ErrnoException | null) => {
                if (err) {
                  // Non-fatal: the container is up with the new tag.
                  // Worst case, a plugin restart reverts to the old
                  // tag from the config file and the user has to
                  // click Update again. Log it and continue.
                  app.error(
                    `Failed to persist new tag to plugin config: ${errMsg(err)}. ` +
                      `Container is running with mayara-server:${tag} but a plugin ` +
                      `restart will revert to the previous configured tag.`
                  )
                }
                resolve()
              })
            })
          }

          app.setPluginStatus(`Updated to mayara-server:${tag}`)
          res.json({ success: true, tag })
        } catch (err) {
          app.setPluginError(`Update failed: ${errMsg(err)}`)
          res.status(500).json({ error: errMsg(err) })
        }
      })

      router.get('/api/gui-url', (_req: Request, res: Response) => {
        res.json({ url: `${GUI_PROXY_PATH}/` })
      })

      // Lists available release tags for the version dropdown in the
      // config panel. signalk-container's update service exposes "what
      // is the latest" but not "list all" — the latter belongs in the
      // plugin (it knows which repo to ask). This is the only place
      // mayara still talks to GitHub directly.
      router.get('/api/versions', async (_req: Request, res: Response) => {
        try {
          const ghRes = await fetch(
            'https://api.github.com/repos/MarineYachtRadar/mayara-server/releases?per_page=10',
            {
              headers: { Accept: 'application/vnd.github+json' },
              signal: AbortSignal.timeout(10000)
            }
          )
          if (!ghRes.ok) {
            res.status(502).json({ error: 'Failed to fetch releases' })
            return
          }
          const releases = (await ghRes.json()) as {
            tag_name: string
            prerelease: boolean
            draft: boolean
          }[]
          res.json(
            releases
              .filter((r) => !r.draft && SAFE_TAG.test(r.tag_name))
              .map((r) => ({ tag: r.tag_name, prerelease: r.prerelease }))
          )
        } catch (err) {
          res.status(500).json({ error: errMsg(err) })
        }
      })
    }
  }

  // ==========================================================================
  // Container management
  // ==========================================================================

  /**
   * Build a ContainerConfig for the mayara-server container with the
   * given tag. Used at startup, when applying updates, and after a
   * background token mint completes — signalk-container drift-detects
   * the resulting `command`/`env` changes and recreates the container
   * transparently.
   *
   * Default nav-address is the upstream Signal K server itself:
   *   - `ws:127.0.0.1:${SK_PORT}` plus `MAYARA_SIGNALK_TOKEN` env var
   *     when a cached device token exists (full WS path → AIS REST
   *     seeding works inside the container).
   *   - `tcp:127.0.0.1:${TCPSTREAMPORT}` otherwise (legacy delta
   *     stream; AIS overlay still works but only fills from live
   *     deltas, not the initial REST snapshot).
   *
   * Either way, `mayaraArgs` may override `-n` entirely, in which case
   * we don't inject our default — and we also drop the token env so
   * the operator's explicit config isn't shadowed.
   *
   * The token is delivered via env, not as a bind-mounted file, because
   * on Docker (and rootful podman) signalk-container emits `--user
   * 1000:1000` so the in-container mayara user can write its own home —
   * but that means the in-container UID (1000) differs from the host
   * caller's UID and a bind-mounted 0600 token written by the host SK
   * user would be unreadable from inside the container. Env vars cross
   * the UID boundary unconditionally. The on-disk cache file under
   * `${dataDir}/signalk-token` (mode 0600) stays as the plugin's own
   * cache so the token survives SK restarts.
   */
  function buildContainerConfig(tag: string): ContainerConfig {
    const userArgs = currentSettings?.mayaraArgs ?? []
    const userOverridesNav = userArgs.some((a) => a === '-n' || a === '--navigation-address')

    const skPort = Number(process.env.PORT) || 3000
    const tcpPort = Number(process.env.TCPSTREAMPORT) || 8375
    const dataDir = app.getDataDirPath()
    const cachedToken = userOverridesNav ? undefined : readCachedToken(dataDir)

    const injected: string[] = []
    const env: Record<string, string> = {}

    if (!userOverridesNav) {
      if (cachedToken !== undefined) {
        injected.push('-n', `ws:127.0.0.1:${skPort}`)
        env.MAYARA_SIGNALK_TOKEN = cachedToken
      } else {
        injected.push('-n', `tcp:127.0.0.1:${tcpPort}`)
      }
    }

    const command = ['mayara-server', ...injected, ...userArgs]

    const config: ContainerConfig = {
      image: MAYARA_IMAGE,
      tag,
      networkMode: 'host',
      command,
      restart: 'unless-stopped',
      resources: DEFAULT_RESOURCES,
      // The mayara image declares `USER mayara` with UID/GID 1000. Tell
      // signalk-container so its UID-mapping logic emits the right flag
      // (`--userns=keep-id:uid=1000,gid=1000` on rootless podman,
      // `--user 1000:1000` on docker / rootful podman). Without this
      // hint signalk-container assumes inImageUid=0, the in-image
      // mayara user runs under the subuid range, and the in-container
      // mayara process cannot write to the in-image XDG data dir.
      user: { inImageUid: 1000, inImageGid: 1000 }
    }
    if (Object.keys(env).length > 0) {
      config.env = env
    }
    return config
  }

  /**
   * Drive the Signal K device-access-request flow to obtain a token,
   * then recreate the mayara container with the WS-based config so the
   * AIS REST seeder can populate the in-radar overlay from the
   * upstream `vessels/` snapshot.
   *
   * Fast path: a cached token already exists — log it and we're done
   * (the container was already started with the correct config by
   * `buildContainerConfig`).
   *
   * Slow path: POST a request, surface "Awaiting approval" plugin
   * status, poll until admin approves (or denies, or stop() is
   * called). On approval, write the token and re-call ensureRunning
   * so signalk-container drift-detects the new `command`/`env` and
   * recreates the container.
   */
  async function ensureSignalkToken(containers: ContainerManagerApi, tag: string): Promise<void> {
    const dataDir = app.getDataDirPath()
    if (readCachedToken(dataDir)) {
      app.debug('Signal K token cached; container started with WS transport')
      return
    }

    const skPort = Number(process.env.PORT) || 3000
    // Request `readwrite` so mayara can later push deltas back into SK
    // (radar targets, MARPA tracks, heading echoes, guard-zone
    // notifications). Today the token only reads the AIS REST snapshot,
    // but Signal K admin UI doesn't let the operator widen permissions
    // post-approval — we'd have to revoke and re-request. Asking for
    // the broader scope up front avoids that migration step when the
    // writeback features land in mayara-server.
    const begin = await beginTokenRequest({
      dataDir,
      signalkPort: skPort,
      clientId: PLUGIN_ID,
      description:
        'MaYaRa Radar (Server) — AIS overlay seeding + radar/target/notification writebacks',
      permissions: 'readwrite'
    })

    switch (begin.kind) {
      case 'cached':
        // Race: token landed between the readCachedToken above and the
        // POST. Recreate to pick up WS transport.
        await containers.ensureRunning(CONTAINER_NAME, buildContainerConfig(tag))
        return
      case 'no-security':
        app.debug('Signal K security disabled; no token needed')
        // SK serves no-security WS without auth, so switch from tcp:
        // to ws: by recreating with the same buildContainerConfig
        // (which always emits ws: when haveToken is true, but here
        // haveToken is false — fall back to tcp:, which still works).
        return
      case 'requests-disabled':
        app.setPluginStatus(
          'Signal K device access requests are disabled. To enable the AIS ' +
            "overlay's initial REST snapshot, enable device access requests in " +
            'Security settings, or add `--signalk-token <token>` to mayaraArgs.'
        )
        return
      case 'error':
        app.debug(`Signal K token request error: ${begin.message}`)
        return
      case 'pending':
        // Fall through to the polling block below.
        break
    }

    app.setPluginStatus('Awaiting Signal K token approval — see Security → Access Requests')
    app.debug(
      `Awaiting approval at ${begin.href} (request ${begin.requestId}). ` +
        `Set plugin config "requestSignalkToken" to false to suppress this.`
    )

    const token = await awaitApproval(
      begin.href,
      skPort,
      () => tokenPollerCancelled,
      (msg) => {
        app.debug(msg)
      }
    )
    if (!token) {
      // Denied, expired, or plugin stopped. Either way, leave the
      // container on its existing transport; user can request again
      // by restarting the plugin.
      if (!tokenPollerCancelled) {
        app.setPluginStatus(
          'Signal K token request was denied or expired. AIS overlay will ' +
            'fill from live deltas only. Restart the plugin to request again.'
        )
      }
      return
    }

    writeCachedToken(dataDir, token)
    app.debug('Signal K token approved and cached; recreating container with WS transport')
    app.setPluginStatus('Signal K token approved — recreating container...')
    try {
      await containers.ensureRunning(CONTAINER_NAME, buildContainerConfig(tag))
      app.setPluginStatus('Running')
    } catch (err) {
      app.setPluginError(
        `Token approved but container recreate failed: ${errMsg(err)}. ` +
          `Restart the plugin to retry.`
      )
    }
  }

  /**
   * Wait up to `timeoutMs` for signalk-container to be both loaded
   * (cross-plugin global populated) and finished with runtime detection.
   * Returns the container manager handle, or undefined if either phase
   * timed out or detection failed. Caller sets a plugin error on
   * undefined.
   */
  async function waitForContainerManager(
    timeoutMs = 30000
  ): Promise<ContainerManagerApi | undefined> {
    const deadline = Date.now() + timeoutMs

    // Phase 1: poll for the cross-plugin global. signalk-container's
    // start() may not have run yet on a fresh SK boot.
    let containers = getContainerManager()
    while (!containers && Date.now() < deadline) {
      app.setPluginStatus('Waiting for signalk-container plugin to load...')
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
      containers = getContainerManager()
    }
    if (!containers) return undefined

    // Phase 2: await whenReady() with a remaining-time cap. whenReady()
    // resolves on success OR failure of runtime detection, so re-check
    // getRuntime() afterwards.
    app.setPluginStatus('Waiting for container runtime detection...')
    const remaining = Math.max(0, deadline - Date.now())
    await Promise.race([
      containers.whenReady(),
      new Promise<void>((resolve) => setTimeout(resolve, remaining))
    ])
    return containers.getRuntime() ? containers : undefined
  }

  async function startManagedContainer(settings: Partial<Config>): Promise<void> {
    const containers = await waitForContainerManager()
    if (!containers) {
      app.setPluginError(
        'signalk-container plugin required for managed mode. Install it or set managedContainer=false.'
      )
      throw new Error('Container manager not available')
    }

    app.debug('Container runtime ready, starting mayara-server')
    app.setPluginStatus('Starting mayara-server container...')

    const tag = settings.mayaraVersion ?? 'latest'
    const config = buildContainerConfig(tag)

    // signalk-container ≥1.6.0 diffs ContainerConfig against the live
    // container on every ensureRunning call and recreates transparently
    // on drift across image+tag, command, networkMode, env, volumes,
    // and ports. Resources follow the live-update path. No local hash
    // tracking needed.
    await containers.ensureRunning(CONTAINER_NAME, config)

    // Kick off Signal K device-token acquisition in the background. The
    // container is already running with whatever transport the cached
    // token (or lack thereof) selected; if we mint a new token here we
    // recreate it later to switch transports. Failure paths only flip
    // plugin status — they don't block startup.
    if (settings.requestSignalkToken !== false) {
      void ensureSignalkToken(containers, tag).catch((err: unknown) => {
        app.debug(`Signal K token acquisition failed: ${errMsg(err)}`)
      })
    }

    // Register with the centralized update service. The service auto-
    // detects whether `tag` is a semver pin (compare via GitHub releases)
    // or a floating tag like `latest`/`main` (digest drift detection).
    // Re-registers every plugin start, which is the supported pattern.
    try {
      containers.updates.register({
        pluginId: PLUGIN_ID,
        containerName: CONTAINER_NAME,
        image: MAYARA_IMAGE,
        // Function, not value: picks up live edits to the version
        // setting without requiring a re-register.
        currentTag: () => currentSettings?.mayaraVersion ?? 'latest',
        versionSource: containers.updates.sources.githubReleases('MarineYachtRadar/mayara-server')
      })
      app.debug('Registered with signalk-container update service')
    } catch (err) {
      // Non-fatal: the container is up, only the update checker is missing.
      app.debug(`Failed to register update tracker: ${errMsg(err)}`)
    }

    app.debug('mayara-server container ready')
  }

  // ==========================================================================
  // Plugin lifecycle
  // ==========================================================================

  async function asyncStart(settings: Partial<Config>): Promise<void> {
    if (settings.managedContainer) {
      await startManagedContainer(settings)
    }

    client = new MayaraClient({
      host: settings.host ?? 'localhost',
      port: settings.port ?? 6502,
      secure: settings.secure ?? false,
      debug: app.debug.bind(app)
    })

    const provider = createRadarProvider(client, app)

    try {
      app.radarApi.register(PLUGIN_ID, {
        name: plugin.name,
        methods: provider
      })
      app.debug('Registered as radar provider')
    } catch (err) {
      app.setPluginError(`Failed to register radar provider: ${errMsg(err)}`)
      return
    }

    if (settings.managedContainer) {
      app.setPluginStatus('Waiting for mayara-server to become ready...')
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        try {
          await client.getRadars()
          break
        } catch {
          await new Promise<void>((resolve) => setTimeout(resolve, 1000))
        }
      }
    }

    // Bring up the notification forwarder before discovery so the very
    // first guard-zone alarm a radar fires reaches the upstream Signal
    // K server. The forwarder owns its own reconnect loop, so failing
    // here just means it'll reach mayara on a later attempt.
    if (!notificationForwarder) {
      notificationForwarder = new NotificationForwarder(app, {
        pluginId: PLUGIN_ID,
        url: client.getStateStreamUrl(),
        debug: app.debug.bind(app),
        reconnectInterval: (settings.reconnectInterval || 5) * 1000
      })
      notificationForwarder.start()
    }

    await connectAndDiscover(settings)
  }

  async function connectAndDiscover(settings: Partial<Config>): Promise<void> {
    if (!client) return

    try {
      const radars = await client.getRadars()
      isConnected = true

      const radarIds = Object.keys(radars)
      app.setPluginStatus(`Connected - ${radarIds.length} radar(s) found`)

      updateRadars(radarIds, settings)

      const pollMs = (settings.discoveryPollInterval || 10) * 1000
      discoveryInterval = setInterval(() => {
        void pollForRadarChanges(settings)
      }, pollMs)
    } catch (err) {
      isConnected = false
      app.setPluginError(`Cannot connect to mayara-server: ${errMsg(err)}`)

      const reconnectMs = (settings.reconnectInterval || 5) * 1000
      reconnectInterval = setInterval(() => {
        void attemptReconnect(settings)
      }, reconnectMs)
    }
  }

  async function attemptReconnect(settings: Partial<Config>): Promise<void> {
    if (!client) return

    try {
      const radars = await client.getRadars()
      isConnected = true

      const radarIds = Object.keys(radars)
      app.setPluginStatus(`Connected - ${radarIds.length} radar(s) found`)

      if (reconnectInterval) {
        clearInterval(reconnectInterval)
        reconnectInterval = null
      }

      updateRadars(radarIds, settings)

      if (discoveryInterval) {
        clearInterval(discoveryInterval)
      }
      const pollMs = (settings.discoveryPollInterval || 10) * 1000
      discoveryInterval = setInterval(() => {
        void pollForRadarChanges(settings)
      }, pollMs)
    } catch (err) {
      app.debug(`Reconnect attempt failed: ${errMsg(err)}`)
    }
  }

  function updateRadars(radarIds: string[], settings: Partial<Config>): void {
    if (!client) return

    const currentIds = new Set(radarIds)

    for (const radarId of currentIds) {
      if (!knownRadars.has(radarId)) {
        app.debug(`New radar discovered: ${radarId}`)
        knownRadars.add(radarId)

        if (app.binaryStreamManager) {
          const forwarder = new SpokeForwarder({
            radarId,
            url: client.getSpokeStreamUrl(radarId),
            binaryStreamManager: app.binaryStreamManager,
            debug: app.debug.bind(app),
            reconnectInterval: (settings.reconnectInterval || 5) * 1000
          })
          spokeForwarders.set(radarId, forwarder)
          forwarder.start()
        } else {
          app.debug('binaryStreamManager not available - spoke streaming disabled')
        }
      }
    }

    for (const radarId of knownRadars) {
      if (!currentIds.has(radarId)) {
        app.debug(`Radar disconnected: ${radarId}`)
        knownRadars.delete(radarId)

        const forwarder = spokeForwarders.get(radarId)
        if (forwarder) {
          forwarder.stop()
          spokeForwarders.delete(radarId)
        }
      }
    }
  }

  async function pollForRadarChanges(settings: Partial<Config>): Promise<void> {
    if (!client) return

    try {
      const radars = await client.getRadars()
      const radarIds = Object.keys(radars)

      updateRadars(radarIds, settings)
      app.setPluginStatus(`Connected - ${radarIds.length} radar(s)`)
    } catch (err) {
      isConnected = false
      app.setPluginError(`Lost connection: ${errMsg(err)}`)

      if (discoveryInterval) {
        clearInterval(discoveryInterval)
        discoveryInterval = null
      }

      const reconnectMs = (settings.reconnectInterval || 5) * 1000
      reconnectInterval = setInterval(() => {
        void attemptReconnect(settings)
      }, reconnectMs)
    }
  }

  return plugin
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
