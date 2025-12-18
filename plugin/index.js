/**
 * MaYaRa Radar SignalK Plugin
 *
 * Connects to a remote mayara-server and exposes its radar(s) via SignalK's Radar API.
 * The plugin acts as a thin proxy layer - all radar logic runs on mayara-server.
 */

const MayaraClient = require('./mayara-client')
const createRadarProvider = require('./radar-provider')
const SpokeForwarder = require('./spoke-forwarder')

module.exports = function (app) {
  let client = null
  let provider = null
  let spokeForwarders = new Map() // radarId -> SpokeForwarder
  let discoveryInterval = null
  let reconnectInterval = null
  let isConnected = false
  let knownRadars = new Set()

  const plugin = {
    id: 'mayara-server-signalk-plugin',
    name: 'MaYaRa Radar (Server)',
    description: 'Connect SignalK to mayara-server for multi-brand marine radar integration',

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

    start: function (settings) {
      app.debug('Starting mayara-server-signalk-plugin')

      // Initialize client to mayara-server
      client = new MayaraClient({
        host: settings.host || 'localhost',
        port: settings.port || 6502,
        secure: settings.secure || false,
        debug: app.debug.bind(app)
      })

      // Create RadarProvider implementation
      provider = createRadarProvider(client, app)

      // Check if radar API is available
      if (!app.radarApi) {
        app.setPluginError('SignalK Radar API not available (requires SignalK >= 2.0.0)')
        return
      }

      // Register with SignalK Radar API
      try {
        app.radarApi.register(plugin.id, {
          name: plugin.name,
          methods: provider
        })
        app.debug('Registered as radar provider')
      } catch (err) {
        app.setPluginError(`Failed to register radar provider: ${err.message}`)
        return
      }

      // Start connection and discovery
      connectAndDiscover(settings)
    },

    stop: function () {
      app.debug('Stopping mayara-server-signalk-plugin')

      // Unregister from radar API
      if (app.radarApi) {
        try {
          app.radarApi.unRegister(plugin.id)
        } catch (err) {
          app.debug(`Error unregistering: ${err.message}`)
        }
      }

      // Clear intervals
      if (discoveryInterval) {
        clearInterval(discoveryInterval)
        discoveryInterval = null
      }
      if (reconnectInterval) {
        clearInterval(reconnectInterval)
        reconnectInterval = null
      }

      // Stop all spoke forwarders
      for (const forwarder of spokeForwarders.values()) {
        forwarder.stop()
      }
      spokeForwarders.clear()
      knownRadars.clear()

      // Close client
      if (client) {
        client.close()
        client = null
      }

      isConnected = false
      app.setPluginStatus('Stopped')
    },

    registerWithRouter: function (router) {
      // Health check endpoint
      router.get('/status', (req, res) => {
        res.json({
          connected: isConnected,
          radars: Array.from(knownRadars),
          spokeForwarders: Array.from(spokeForwarders.keys()).map(id => ({
            radarId: id,
            connected: spokeForwarders.get(id)?.isConnected() || false
          }))
        })
      })
    }
  }

  async function connectAndDiscover(settings) {
    try {
      // Try to connect to mayara-server
      const radars = await client.getRadars()
      isConnected = true

      const radarIds = Object.keys(radars)
      app.setPluginStatus(`Connected - ${radarIds.length} radar(s) found`)

      // Update known radars and start spoke forwarders
      await updateRadars(radarIds, settings)

      // Start discovery polling
      const pollMs = (settings.discoveryPollInterval || 10) * 1000
      discoveryInterval = setInterval(() => {
        pollForRadarChanges(settings)
      }, pollMs)

    } catch (err) {
      isConnected = false
      app.setPluginError(`Cannot connect to mayara-server: ${err.message}`)

      // Schedule reconnect
      const reconnectMs = (settings.reconnectInterval || 5) * 1000
      reconnectInterval = setInterval(async () => {
        try {
          const radars = await client.getRadars()
          isConnected = true

          const radarIds = Object.keys(radars)
          app.setPluginStatus(`Connected - ${radarIds.length} radar(s) found`)

          // Clear reconnect timer
          clearInterval(reconnectInterval)
          reconnectInterval = null

          // Update radars
          await updateRadars(radarIds, settings)

          // Start discovery polling
          const pollMs = (settings.discoveryPollInterval || 10) * 1000
          discoveryInterval = setInterval(() => {
            pollForRadarChanges(settings)
          }, pollMs)

        } catch (e) {
          // Still disconnected, keep trying
          app.debug(`Reconnect failed: ${e.message}`)
        }
      }, reconnectMs)
    }
  }

  async function updateRadars(radarIds, settings) {
    const currentIds = new Set(radarIds)

    // Add new radars
    for (const radarId of currentIds) {
      if (!knownRadars.has(radarId)) {
        app.debug(`New radar discovered: ${radarId}`)
        knownRadars.add(radarId)

        // Start spoke forwarder for this radar
        if (app.binaryStreamManager) {
          const forwarder = new SpokeForwarder({
            radarId: radarId,
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

    // Remove disconnected radars
    for (const radarId of knownRadars) {
      if (!currentIds.has(radarId)) {
        app.debug(`Radar disconnected: ${radarId}`)
        knownRadars.delete(radarId)

        // Stop spoke forwarder
        const forwarder = spokeForwarders.get(radarId)
        if (forwarder) {
          forwarder.stop()
          spokeForwarders.delete(radarId)
        }
      }
    }
  }

  async function pollForRadarChanges(settings) {
    try {
      const radars = await client.getRadars()
      const radarIds = Object.keys(radars)

      await updateRadars(radarIds, settings)

      app.setPluginStatus(`Connected - ${radarIds.length} radar(s)`)

    } catch (err) {
      // Lost connection
      isConnected = false
      app.setPluginError(`Lost connection: ${err.message}`)

      // Stop discovery polling
      if (discoveryInterval) {
        clearInterval(discoveryInterval)
        discoveryInterval = null
      }

      // Start reconnect timer
      const reconnectMs = (settings.reconnectInterval || 5) * 1000
      reconnectInterval = setInterval(async () => {
        try {
          const radars = await client.getRadars()
          isConnected = true

          const radarIds = Object.keys(radars)
          app.setPluginStatus(`Connected - ${radarIds.length} radar(s) found`)

          // Clear reconnect timer
          clearInterval(reconnectInterval)
          reconnectInterval = null

          // Update radars
          await updateRadars(radarIds, settings)

          // Restart discovery polling
          const pollMs = (settings.discoveryPollInterval || 10) * 1000
          discoveryInterval = setInterval(() => {
            pollForRadarChanges(settings)
          }, pollMs)

        } catch (e) {
          // Still disconnected
        }
      }, reconnectMs)
    }
  }

  return plugin
}
