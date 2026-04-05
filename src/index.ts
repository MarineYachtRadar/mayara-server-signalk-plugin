import { exec } from 'child_process'
import { promisify } from 'util'
import { Plugin } from '@signalk/server-api'

const execAsync = promisify(exec)
import { Request, Response, IRouter } from 'express'
import { MayaraClient } from './mayara-client'
import { createRadarProvider } from './radar-provider'
import { SpokeForwarder } from './spoke-forwarder'
import { MayaraServerAPI, ContainerManagerApi } from './types'
import { ConfigSchema, Config } from './config/schema'

const MAYARA_IMAGE = 'ghcr.io/marineyachtradar/mayara-server'
const SAFE_TAG = /^[a-zA-Z0-9._-]+$/

module.exports = function (app: MayaraServerAPI): Plugin {
  let client: MayaraClient | null = null
  let currentSettings: Partial<Config> | null = null
  const spokeForwarders = new Map<string, SpokeForwarder>()
  let discoveryInterval: ReturnType<typeof setInterval> | null = null
  let reconnectInterval: ReturnType<typeof setInterval> | null = null
  let isConnected = false
  const knownRadars = new Set<string>()

  const plugin: Plugin = {
    id: 'mayara-server-signalk-plugin',
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

    stop() {
      app.debug('Stopping mayara-server-signalk-plugin')

      try {
        app.radarApi.unRegister(plugin.id)
      } catch (err) {
        app.debug(`Error unregistering: ${err instanceof Error ? err.message : String(err)}`)
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

      isConnected = false
      app.setPluginStatus('Stopped')
    },

    registerWithRouter(router: IRouter) {
      router.get('/status', async (req: Request, res: Response) => {
        let containerState = 'unknown'
        let containerImage = ''
        try {
          const containers = (globalThis as Record<string, unknown>).__signalk_containerManager as
            | ContainerManagerApi
            | undefined
          if (containers) {
            containerState = await containers.getState('mayara-server')
          }
        } catch {
          // ignore
        }
        try {
          const tag = currentSettings?.mayaraVersion ?? 'latest'
          containerImage = `${MAYARA_IMAGE}:${tag}`
        } catch {
          // ignore
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

      router.post('/api/check-update', async (req: Request, res: Response) => {
        try {
          const containers = (globalThis as Record<string, unknown>).__signalk_containerManager as
            | ContainerManagerApi
            | undefined
          if (!containers) {
            res.status(400).json({ error: 'signalk-container not available' })
            return
          }
          const runtime = containers.getRuntime()
          if (!runtime) {
            res.status(400).json({ error: 'No container runtime detected' })
            return
          }
          const rt = runtime.runtime
          const tag =
            ((req.body as Record<string, unknown>).tag as string | undefined) ??
            currentSettings?.mayaraVersion ??
            'latest'
          if (!SAFE_TAG.test(tag)) {
            res.status(400).json({ error: 'Invalid tag format' })
            return
          }
          const image = `${MAYARA_IMAGE}:${tag}`

          // Get image ID of running container
          let runningImageId = ''
          try {
            const { stdout } = await execAsync(
              `${rt} inspect sk-mayara-server --format '{{.Image}}'`
            )
            runningImageId = stdout.trim()
          } catch {
            // container not running
          }

          // Pull latest
          app.debug(`Checking for update: pulling ${image}`)
          await containers.pullImage(image)

          // Get image ID of pulled image
          let pulledImageId = ''
          try {
            const { stdout } = await execAsync(`${rt} image inspect ${image} --format '{{.Id}}'`)
            pulledImageId = stdout.trim()
          } catch {
            // image inspect failed
          }

          if (!runningImageId) {
            res.json({ updateAvailable: false, message: 'Container not running' })
          } else if (runningImageId === pulledImageId) {
            res.json({ updateAvailable: false, message: `Up to date (${tag})` })
          } else {
            res.json({ updateAvailable: true, message: `Update available for ${tag}` })
          }
        } catch (err) {
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
        }
      })

      router.post('/api/update', async (req: Request, res: Response) => {
        try {
          const containers = (globalThis as Record<string, unknown>).__signalk_containerManager as
            | ContainerManagerApi
            | undefined
          if (!containers) {
            res.status(400).json({ error: 'signalk-container not available' })
            return
          }
          const tag =
            ((req.body as Record<string, unknown>).tag as string | undefined) ??
            currentSettings?.mayaraVersion ??
            'latest'
          if (!SAFE_TAG.test(tag)) {
            res.status(400).json({ error: 'Invalid tag format' })
            return
          }
          const image = `${MAYARA_IMAGE}:${tag}`
          app.setPluginStatus(`Updating mayara-server to ${image}...`)
          await containers.pullImage(image)
          await containers.stop('mayara-server')
          await containers.remove('mayara-server')

          const args = currentSettings?.mayaraArgs ?? []
          await containers.ensureRunning('mayara-server', {
            image: MAYARA_IMAGE,
            tag,
            networkMode: 'host',
            command: args.length > 0 ? ['mayara-server', ...args] : undefined,
            restart: 'unless-stopped'
          })

          res.json({ success: true, tag })
          app.setPluginStatus(`Updated to ${tag} and running.`)
        } catch (err) {
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
        }
      })

      router.get('/api/gui-url', (req: Request, res: Response) => {
        const host = currentSettings?.host ?? 'localhost'
        const port = currentSettings?.port ?? 6502
        const proto = currentSettings?.secure ? 'https' : 'http'
        res.json({ url: `${proto}://${host}:${port}/gui/` })
      })

      router.get('/api/versions', async (req: Request, res: Response) => {
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
              .filter((r) => !r.draft)
              .map((r) => ({ tag: r.tag_name, prerelease: r.prerelease }))
          )
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : 'Unknown error'
          })
        }
      })
    }
  }

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
      app.radarApi.register(plugin.id, {
        name: plugin.name,
        methods: provider
      })
      app.debug('Registered as radar provider')
    } catch (err) {
      app.setPluginError(
        `Failed to register radar provider: ${err instanceof Error ? err.message : String(err)}`
      )
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

  async function startManagedContainer(settings: Partial<Config>): Promise<void> {
    let containers: ContainerManagerApi | undefined
    const waitDeadline = Date.now() + 30000
    while (Date.now() < waitDeadline) {
      containers = (globalThis as Record<string, unknown>).__signalk_containerManager as
        | ContainerManagerApi
        | undefined
      if (containers?.getRuntime()) break
      app.setPluginStatus('Waiting for container runtime detection...')
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
    }

    if (!containers) {
      app.setPluginError(
        'signalk-container plugin required for managed mode. Install it or set managedContainer=false.'
      )
      throw new Error('Container manager not available')
    }

    if (!containers.getRuntime()) {
      app.setPluginError('No container runtime detected. Check signalk-container plugin.')
      throw new Error('Container runtime not detected')
    }

    app.debug('Container runtime ready, starting mayara-server')
    app.setPluginStatus('Starting mayara-server container...')

    const args = settings.mayaraArgs ?? []
    await containers.ensureRunning('mayara-server', {
      image: MAYARA_IMAGE,
      tag: settings.mayaraVersion ?? 'latest',
      networkMode: 'host',
      command: args.length > 0 ? ['mayara-server', ...args] : undefined,
      restart: 'unless-stopped'
    })
    app.debug('mayara-server container ready')
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
      app.setPluginError(
        `Cannot connect to mayara-server: ${err instanceof Error ? err.message : String(err)}`
      )

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
    } catch {
      // Still disconnected, keep trying
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
      app.setPluginError(`Lost connection: ${err instanceof Error ? err.message : String(err)}`)

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
