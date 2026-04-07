import { Plugin } from '@signalk/server-api'
import { Request, Response, IRouter } from 'express'
import { MayaraClient } from './mayara-client'
import { createRadarProvider } from './radar-provider'
import { SpokeForwarder } from './spoke-forwarder'
import {
  ContainerConfig,
  ContainerManagerApi,
  ContainerResourceLimits,
  MayaraServerAPI
} from './types'
import { ConfigSchema, Config } from './config/schema'

const MAYARA_IMAGE = 'ghcr.io/marineyachtradar/mayara-server'
const CONTAINER_NAME = 'mayara-server'
const PLUGIN_ID = 'mayara-server-signalk-plugin'
const SAFE_TAG = /^[a-zA-Z0-9._-]+$/

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
  cpus: 1.5,
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
      currentSettings = config
      void asyncStart(config).catch((err: unknown) => {
        app.setPluginError(`Startup failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    },

    async stop() {
      app.debug('Stopping mayara-server-signalk-plugin')

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
            await containers.ensureRunning(CONTAINER_NAME, buildContainerConfig(tag))
          } catch (recreateErr) {
            const msg = `Container removed but recreation failed: ${errMsg(recreateErr)}. Click Update again to retry.`
            app.setPluginError(msg)
            res.status(500).json({ error: msg })
            return
          }

          // Persist the new tag so a plugin restart doesn't roll back.
          // Note: signalk-container's centralized update service will pick
          // up the new currentTag() value on the next scheduled check.
          if (currentSettings) {
            currentSettings.mayaraVersion = tag
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
   * given tag. Used both at startup and when applying updates so the
   * two paths can never drift on ports/volumes/env/resources.
   */
  function buildContainerConfig(tag: string): ContainerConfig {
    const userArgs = currentSettings?.mayaraArgs ?? []
    const tcpPort = Number(process.env.TCPSTREAMPORT) || 8375
    const navArg = userArgs.some((a) => a === '-n' || a === '--navigation-address')
      ? []
      : ['-n', `tcp:127.0.0.1:${tcpPort}`]
    const command = ['mayara-server', ...navArg, ...userArgs]

    return {
      image: MAYARA_IMAGE,
      tag,
      networkMode: 'host',
      command,
      restart: 'unless-stopped',
      resources: DEFAULT_RESOURCES
    }
  }

  /**
   * Wait up to 30 seconds for signalk-container to finish runtime
   * detection. Returns the container manager handle, or undefined
   * if it never became ready (in which case the caller should set
   * a plugin error).
   */
  async function waitForContainerManager(
    timeoutMs = 30000
  ): Promise<ContainerManagerApi | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const containers = getContainerManager()
      if (containers?.getRuntime()) return containers
      app.setPluginStatus('Waiting for container runtime detection...')
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
    }
    return undefined
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

    // signalk-container handles its own config-change detection: when
    // ensureRunning sees a config that differs from what it created the
    // container with, it recreates. We no longer maintain a local hash
    // file. Tag changes specifically are handled by the update service.
    await containers.ensureRunning(CONTAINER_NAME, config)

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
