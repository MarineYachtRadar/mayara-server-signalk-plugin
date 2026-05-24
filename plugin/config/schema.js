"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCHEMA_DEFAULTS = exports.ConfigSchema = void 0;
const typebox_1 = require("@sinclair/typebox");
exports.ConfigSchema = typebox_1.Type.Object({
    managedContainer: typebox_1.Type.Boolean({
        default: true,
        title: 'Manage mayara-server via signalk-container',
        description: 'Disable to connect to an external mayara-server instance'
    }),
    mayaraVersion: typebox_1.Type.String({
        default: 'latest',
        title: 'Container image version'
    }),
    mayaraArgs: typebox_1.Type.Array(typebox_1.Type.String(), {
        default: [],
        title: 'mayara-server arguments',
        description: 'e.g. ["--brand", "furuno", "--interface", "eth0"]'
    }),
    requestSignalkToken: typebox_1.Type.Boolean({
        default: true,
        title: 'Auto-request a Signal K device token for the radar overlay',
        description: 'When Signal K security is enabled, the plugin requests a read/write ' +
            'token from this server (visible as a pending request in Security → ' +
            'Access Requests). Approve it once and mayara will use the WebSocket ' +
            'transport and full AIS overlay seeding. Read/write scope leaves room ' +
            'for future radar/target/notification writebacks from mayara to Signal ' +
            'K. Disable to keep mayara on the unauthenticated TCP delta stream ' +
            '(AIS overlay then fills only from live deltas).'
    }),
    host: typebox_1.Type.String({
        default: 'localhost',
        title: 'mayara-server host',
        description: 'IP address or hostname (only used when not managing container)'
    }),
    port: typebox_1.Type.Number({
        default: 6502,
        title: 'mayara-server port',
        minimum: 1,
        maximum: 65535
    }),
    secure: typebox_1.Type.Boolean({
        default: false,
        title: 'Use HTTPS/WSS'
    }),
    discoveryPollInterval: typebox_1.Type.Number({
        default: 10,
        title: 'Discovery poll interval (seconds)',
        minimum: 5,
        maximum: 60
    }),
    reconnectInterval: typebox_1.Type.Number({
        default: 5,
        title: 'Reconnect interval (seconds)',
        minimum: 1,
        maximum: 30
    })
});
// Signal K only uses the schema's `default` fields to seed the
// JSON-schema form in the Admin UI. When the plugin is enabled by
// default (signalk-plugin-enabled-by-default) or when a user enables
// it without saving the form, `start()` is called with an empty
// configuration object — the defaults above are never injected at
// runtime. Materialise them here so we have one source of truth and
// can spread them in `start()`.
exports.SCHEMA_DEFAULTS = {
    managedContainer: true,
    mayaraVersion: 'latest',
    mayaraArgs: [],
    requestSignalkToken: true,
    host: 'localhost',
    port: 6502,
    secure: false,
    discoveryPollInterval: 10,
    reconnectInterval: 5
};
//# sourceMappingURL=schema.js.map