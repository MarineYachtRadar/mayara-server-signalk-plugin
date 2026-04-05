import { Type, Static } from '@sinclair/typebox'

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
