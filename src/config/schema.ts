import { Type, type Static } from 'typebox'

export const ConfigSchema = Type.Object({
  managedContainer: Type.Boolean({
    default: true,
    title: 'Manage mayara-server via signalk-container',
    description: 'Disable to connect to an external mayara-server instance'
  }),
  mayaraVersion: Type.String({
    default: 'latest',
    title: 'Container image version'
  }),
  mayaraArgs: Type.Array(Type.String(), {
    default: [],
    title: 'mayara-server arguments',
    description: 'e.g. ["--brand", "furuno", "--interface", "eth0"]'
  }),
  requestSignalkToken: Type.Boolean({
    default: true,
    title: 'Auto-request a Signal K device token for the radar overlay',
    description:
      'When Signal K security is enabled, the plugin requests a read/write ' +
      'token from this server (visible as a pending request in Security → ' +
      'Access Requests). Approve it once and mayara will use the WebSocket ' +
      'transport and full AIS overlay seeding. Read/write scope leaves room ' +
      'for future radar/target/notification writebacks from mayara to Signal ' +
      'K. Disable to keep mayara on the unauthenticated TCP delta stream ' +
      '(AIS overlay then fills only from live deltas).'
  }),

  host: Type.String({
    default: 'localhost',
    title: 'mayara-server host',
    description: 'IP address or hostname (only used when not managing container)'
  }),
  port: Type.Number({
    default: 6502,
    title: 'mayara-server port',
    minimum: 1,
    maximum: 65535
  }),
  secure: Type.Boolean({
    default: false,
    title: 'Use HTTPS/WSS'
  }),

  directGuiUrl: Type.Boolean({
    default: true,
    title: 'Open the radar GUI directly on mayara-server',
    description:
      "The browser is sent straight to mayara-server's own port. The AIS " +
      'overlay is unaffected — mayara relays vessels from Signal K into its ' +
      "own store — but mayara's port must be reachable from the browser and " +
      'the transport follows the HTTPS/WSS setting below — with it off the ' +
      'radar session is unencrypted even when Signal K itself uses HTTPS. ' +
      'Disable this to reach the GUI through this plugin instead, which keeps ' +
      "the browser on the Signal K port and inherits Signal K's TLS: needed " +
      'when only that port is open, or when the radar session must be encrypted.'
  }),

  discoveryPollInterval: Type.Number({
    default: 10,
    title: 'Discovery poll interval (seconds)',
    minimum: 5,
    maximum: 60
  }),
  reconnectInterval: Type.Number({
    default: 5,
    title: 'Reconnect interval (seconds)',
    minimum: 1,
    maximum: 30
  })
})

export type Config = Static<typeof ConfigSchema>

// Signal K only uses the schema's `default` fields to seed the
// JSON-schema form in the Admin UI. When the plugin is enabled by
// default (signalk-plugin-enabled-by-default) or when a user enables
// it without saving the form, `start()` is called with an empty
// configuration object — the defaults above are never injected at
// runtime. Materialise them here so we have one source of truth and
// can spread them in `start()`.
export const SCHEMA_DEFAULTS: Config = {
  managedContainer: true,
  mayaraVersion: 'latest',
  mayaraArgs: [],
  requestSignalkToken: true,
  host: 'localhost',
  port: 6502,
  secure: false,
  directGuiUrl: true,
  discoveryPollInterval: 10,
  reconnectInterval: 5
}
