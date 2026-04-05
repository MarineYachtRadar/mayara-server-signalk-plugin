"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigSchema = void 0;
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
//# sourceMappingURL=schema.js.map