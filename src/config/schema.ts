import { Type, type Static, type TSchema } from 'typebox'
import { Check, Clean, Clone, Convert, Default, Errors } from 'typebox/value'

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
  }),

  collisionAlerts: Type.Union(
    [
      Type.Literal('off'),
      Type.Literal('harbour'),
      Type.Literal('coastal'),
      Type.Literal('offshore'),
      Type.Literal('collision-alerts-plugin')
    ],
    {
      default: 'coastal',
      title: 'Collision alarms for radar (ARPA) targets',
      description:
        'Raise a collision alarm for each tracked radar target whose closest ' +
        'point of approach (CPA) comes too close too soon. Harbour: warn at ' +
        '100 m / 5 min, alarm at 50 m / 2 min. Coastal: warn at 0.5 NM / 12 ' +
        'min, alarm at 0.25 NM / 6 min. Offshore: warn at 1 NM / 20 min, alarm ' +
        'at 0.5 NM / 10 min. collision-alerts-plugin: leave radar alarms to ' +
        'the Signal K Collision Alerts plugin, which raises one alarm per boat ' +
        'even when it is seen on both AIS and radar. That needs a Signal K ' +
        'server with the Targets API; on older servers this falls back to ' +
        'Coastal so radar alarms are never lost.'
    }
  ),

  telemetry: Type.Boolean({
    default: true,
    title: 'Report anonymous usage stats to the mayara developers',
    description:
      'Tells mayara-server it is fine to report, at most twice per run, ' +
      'that this install works (a radar delivering data, a radar accepting ' +
      'a control change) -- never a position, serial number, or network ' +
      "address. Disable to keep mayara silent; either way, mayara-server's " +
      'own GUI never asks this question when running through the plugin.'
  })
})

export type Config = Static<typeof ConfigSchema>

/**
 * Every setting at its schema default. Signal K only uses the schema's
 * `default`s to seed the Admin UI form; an auto-enabled or never-saved
 * plugin is started with `{}`.
 */
export const SCHEMA_DEFAULTS: Config = defaultConfig()

function defaultConfig(): Config {
  const value = Default(ConfigSchema, {})
  if (!Check(ConfigSchema, value)) {
    throw new Error('ConfigSchema defaults do not satisfy the schema')
  }
  return value
}

/**
 * A stored setting the schema rejects, replaced by its default. The stored
 * value is left out on purpose: `mayaraArgs` can carry a Signal K token, and
 * these end up in the server log.
 */
export interface InvalidSetting {
  key: keyof Config
  reason: string
}

/**
 * Turn the configuration Signal K hands `start()` into a complete Config.
 * Missing settings take their defaults, a value that converts cleanly
 * (`"6502"` for a number) is converted, and any other invalid setting falls
 * back to its default on its own, so one bad field does not cost the rest.
 * Keys the schema does not define are dropped. `stored` is not modified.
 */
export function parseConfig(stored: unknown): { config: Config; invalid: InvalidSetting[] } {
  const keys = Object.keys(ConfigSchema.properties) as Array<keyof Config>
  const working = Clone<Record<string, unknown>>(isRecord(stored) ? stored : {})
  // Convert would turn a stored null into a plausible value (false for a
  // boolean, "null" for a string), so take nulls out first: Default fills
  // the gap and the loop below reports them.
  const nulls = new Set(keys.filter((key) => working[key] === null))
  for (const key of nulls) working[key] = undefined
  const candidate = Clean(
    ConfigSchema,
    Convert(ConfigSchema, Default(ConfigSchema, working))
  ) as Record<string, unknown>
  const defaults = defaultConfig()
  const invalid: InvalidSetting[] = []
  for (const key of keys) {
    const schema: TSchema = ConfigSchema.properties[key]
    if (nulls.has(key)) {
      invalid.push({ key, reason: describeProblem(schema, null) })
      continue
    }
    if (Check(schema, candidate[key])) continue
    invalid.push({ key, reason: describeProblem(schema, candidate[key]) })
    candidate[key] = defaults[key]
  }
  if (!Check(ConfigSchema, candidate)) {
    throw new Error('Reset configuration still does not satisfy the schema')
  }
  return { config: candidate, invalid }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A union of literals fails with one "must be equal to constant" per
// option; naming the options says more.
function describeProblem(schema: TSchema, value: unknown): string {
  if (Type.IsUnion(schema) && schema.anyOf.every((option) => Type.IsLiteral(option))) {
    return `must be one of ${schema.anyOf.map((option) => String(option.const)).join(', ')}`
  }
  const error = Errors(schema, value)[0]
  // An error inside an array (one of the mayaraArgs) names the entry.
  return error.instancePath === ''
    ? error.message
    : `entry ${error.instancePath.slice(1)} ${error.message}`
}
