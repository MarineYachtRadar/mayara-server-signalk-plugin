import { Plugin } from '@signalk/server-api'
import { Request, Response, IRouter } from 'express'
import * as path from 'path'
import { MayaraClient } from './mayara-client'
import { createRadarProvider } from './radar-provider'
import { SpokeForwarder } from './spoke-forwarder'
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
  hasCachedToken,
  readCachedToken,
  tokenFilePath,
  writeCachedToken
} from './signalk-token'

const MAYARA_IMAGE = 'ghcr.io/marineyachtradar/mayara-server'
const CONTAINER_NAME = 'mayara-server'
const PLUGIN_ID = 'mayara-server-signalk-plugin'
const SAFE_TAG = /^[a-zA-Z0-9._-]+$/
// Where mayara reads the token file inside its container. The plugin
// bind-mounts its plugin-config-data directory (containing the
// `signalk-token` file) at TOKEN_DIR_IN_CONTAINER; the file then
// appears at TOKEN_DIR_IN_CONTAINER + the relative subpath returned
// by `containers.resolveHostPath()`.
const TOKEN_DIR_IN_CONTAINER = '/run/mayara'

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
  let discoveryInterval: ReturnType<typeof setInterval> | null = null
  // Set true on stop() so the in-flight token poller exits its loop.
  let tokenPollerCancelled = false
  let reconnectInterval: ReturnType<typeof setInterval> | null = null
  let isConnected = false
  const knownRadars = new Set<string>()

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

      isConnected = false
      app.setPluginStatus('Stopped')
    },

    registerWithRouter(router: IRouter) {
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
            await containers.ensureRunning(
              CONTAINER_NAME,
              await buildContainerConfig(containers, tag)
            )
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
        const host = currentSettings?.host ?? 'localhost'
        const port = currentSettings?.port ?? 6502
        const proto = currentSettings?.secure ? 'https' : 'http'
        res.json({ url: `${proto}://${host}:${port}/gui/` })
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
   * the resulting `command`/`volumes` changes and recreates the
   * container transparently.
   *
   * Default nav-address is the upstream Signal K server itself:
   *   - `ws:127.0.0.1:${SK_PORT}` plus `--signalk-token-file` when a
   *     cached device token exists (full WS path → AIS REST seeding
   *     works inside the container).
   *   - `tcp:127.0.0.1:${TCPSTREAMPORT}` otherwise (legacy delta
   *     stream; AIS overlay still works but only fills from live
   *     deltas, not the initial REST snapshot).
   *
   * Either way, `mayaraArgs` may override `-n` entirely, in which case
   * we don't inject our default or `--signalk-token-file`.
   */
  async function buildContainerConfig(
    containers: ContainerManagerApi,
    tag: string
  ): Promise<ContainerConfig> {
    const userArgs = currentSettings?.mayaraArgs ?? []
    const userOverridesNav = userArgs.some((a) => a === '-n' || a === '--navigation-address')

    const skPort = Number(process.env.PORT) || 3000
    const tcpPort = Number(process.env.TCPSTREAMPORT) || 8375
    const dataDir = app.getDataDirPath()
    const haveToken = hasCachedToken(dataDir)

    const injected: string[] = []
    const volumes: Record<string, string> = {}

    if (!userOverridesNav) {
      if (haveToken) {
        // Translate the in-SK absolute token path into the host-side
        // (source, subPath) pair signalk-container's bind mount can
        // actually reach. Critical when SK runs inside a container —
        // `app.getDataDirPath()` returns a path inside that container,
        // not on the host where podman/docker actually lives. On
        // bare-metal SK the resolver returns the path unchanged.
        const tokenAbsPath = tokenFilePath(dataDir)
        const resolved = await containers.resolveHostPath(tokenAbsPath)
        if (resolved !== null) {
          // Mount the resolved source (typically the plugin's own
          // data dir, since SK gives each plugin a private subtree)
          // and tell mayara where to find the token file inside it.
          // `subPath` is relative to `source`; when source already
          // equals tokenAbsPath, subPath is "" (file mount).
          const tokenPathInContainer = path.posix.join(TOKEN_DIR_IN_CONTAINER, resolved.subPath)
          injected.push(
            '-n',
            `ws:127.0.0.1:${skPort}`,
            '--signalk-token-file',
            tokenPathInContainer
          )
          volumes[TOKEN_DIR_IN_CONTAINER] = resolved.source
        } else {
          // SK is containerized and no host mount covers the token
          // path. Fall back to TCP rather than fail startup; surface
          // the gap so the operator knows AIS REST seeding won't
          // happen until they fix the mount.
          app.setPluginError(
            'Signal K token cached but the data directory is not bind-mounted ' +
              'from the host — managed mayara container cannot read it. ' +
              'Falling back to anonymous TCP transport (AIS overlay fills ' +
              'from live deltas only). Bind-mount your SK data directory ' +
              'into the SK container to enable WS+token mode.'
          )
          injected.push('-n', `tcp:127.0.0.1:${tcpPort}`)
        }
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
      // mayara user runs under the subuid range, and the bind-mounted
      // signalk-token file (mode 0600 owned by the host SK user) is
      // unreadable from inside the container.
      user: { inImageUid: 1000, inImageGid: 1000 }
    }
    if (Object.keys(volumes).length > 0) {
      config.volumes = volumes
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
   * so signalk-container drift-detects the new `command`/`volumes`
   * and recreates the container.
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
        await containers.ensureRunning(CONTAINER_NAME, await buildContainerConfig(containers, tag))
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
      await containers.ensureRunning(CONTAINER_NAME, await buildContainerConfig(containers, tag))
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
    const config = await buildContainerConfig(containers, tag)

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
