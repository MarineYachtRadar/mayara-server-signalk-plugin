import { Plugin } from '@signalk/server-api'
import { Request, Response, IRouter } from 'express'
import { MayaraClient } from './mayara-client'
import { createRadarProvider } from './radar-provider'
import { SpokeForwarder } from './spoke-forwarder'
import { MayaraServerAPI, PluginSettings } from './types'

module.exports = function (app: MayaraServerAPI): Plugin {
  let client: MayaraClient | null = null
  const spokeForwarders = new Map<string, SpokeForwarder>()
  let discoveryInterval: ReturnType<typeof setInterval> | null = null
  let reconnectInterval: ReturnType<typeof setInterval> | null = null
  let isConnected = false
  const knownRadars = new Set<string>()

  const plugin: Plugin = {
    id: 'mayara-server-signalk-plugin',
    name: 'MaYaRa Radar (Server)',
    description: 'Connect SignalK to mayara-server for multi-brand marine radar integration',
    enabledByDefault: true,

    schema: () => ({
      type: 'object',
      title: 'MaYaRa Server Connection',
      required: ['host', 'port'],
      properties: {
        host: {
          type: 'string',
          title: 'mayara-server Host',
          description: 'IP address or hostname of mayara-server',
          default: 'localhost'
        },
        port: {
          type: 'number',
          title: 'mayara-server Port',
          description: 'HTTP port of mayara-server REST API',
          default: 6502,
          minimum: 1,
          maximum: 65535
        },
        secure: {
          type: 'boolean',
          title: 'Use HTTPS/WSS',
          description: 'Use secure connections (requires TLS on mayara-server)',
          default: false
        },
        discoveryPollInterval: {
          type: 'number',
          title: 'Discovery Poll Interval (seconds)',
          description: 'How often to poll for new/disconnected radars',
          default: 10,
          minimum: 5,
          maximum: 60
        },
        reconnectInterval: {
          type: 'number',
          title: 'Reconnect Interval (seconds)',
          description: 'How often to retry connection when mayara-server is unreachable',
          default: 5,
          minimum: 1,
          maximum: 30
        }
      }
    }),

    start(config: object) {
      app.debug('Starting mayara-server-signalk-plugin')

      const settings = config as PluginSettings

      client = new MayaraClient({
        host: settings.host || 'localhost',
        port: settings.port || 6502,
        secure: settings.secure || false,
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

      void connectAndDiscover(settings)
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
      router.get('/status', (req: Request, res: Response) => {
        res.json({
          connected: isConnected,
          radars: Array.from(knownRadars),
          spokeForwarders: Array.from(spokeForwarders.keys()).map((id) => ({
            radarId: id,
            connected: spokeForwarders.get(id)?.isConnected() ?? false
          }))
        })
      })
    }
  }

  async function connectAndDiscover(settings: PluginSettings): Promise<void> {
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

  async function attemptReconnect(settings: PluginSettings): Promise<void> {
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

  function updateRadars(radarIds: string[], settings: PluginSettings): void {
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

  async function pollForRadarChanges(settings: PluginSettings): Promise<void> {
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
