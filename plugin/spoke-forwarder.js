"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpokeForwarder = void 0;
const ws_1 = __importDefault(require("ws"));
class SpokeForwarder {
    radarId;
    url;
    binaryStreamManager;
    debug;
    reconnectMs;
    ws = null;
    reconnectTimer = null;
    closed = false;
    connected = false;
    streamId;
    constructor(options) {
        this.radarId = options.radarId;
        this.url = options.url;
        this.binaryStreamManager = options.binaryStreamManager;
        this.debug = options.debug ?? (() => { });
        this.reconnectMs = options.reconnectInterval ?? 5000;
        this.streamId = `radars/${options.radarId}`;
    }
    start() {
        if (this.closed)
            return;
        this.connect();
    }
    connect() {
        if (this.closed)
            return;
        this.debug(`Connecting to spoke stream: ${this.url}`);
        try {
            this.ws = new ws_1.default(this.url);
            this.ws.on('open', () => {
                this.connected = true;
                this.debug(`Connected to spoke stream for ${this.radarId}`);
            });
            this.ws.on('message', (data) => {
                let buf;
                if (Buffer.isBuffer(data)) {
                    buf = data;
                }
                else if (data instanceof ArrayBuffer) {
                    buf = Buffer.from(data);
                }
                else if (Array.isArray(data)) {
                    buf = Buffer.concat(data);
                }
                else {
                    return;
                }
                if (buf.length > 0) {
                    this.binaryStreamManager.emitData(this.streamId, buf);
                }
            });
            this.ws.on('error', (err) => {
                this.connected = false;
                this.debug(`Spoke stream error for ${this.radarId}: ${err.message}`);
            });
            this.ws.on('close', (code) => {
                this.connected = false;
                this.debug(`Spoke stream closed for ${this.radarId}: ${code}`);
                if (!this.closed) {
                    this.scheduleReconnect();
                }
            });
        }
        catch (err) {
            this.debug(`Failed to connect to spoke stream for ${this.radarId}: ${err instanceof Error ? err.message : String(err)}`);
            this.scheduleReconnect();
        }
    }
    scheduleReconnect() {
        if (this.closed || this.reconnectTimer)
            return;
        this.debug(`Scheduling reconnect for ${this.radarId} in ${this.reconnectMs}ms`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.closed) {
                this.connect();
            }
        }, this.reconnectMs);
    }
    isConnected() {
        return this.connected;
    }
    stop() {
        this.closed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.close();
            }
            catch {
                // Ignore close errors
            }
            this.ws = null;
        }
        this.connected = false;
        this.debug(`Stopped spoke forwarder for ${this.radarId}`);
    }
}
exports.SpokeForwarder = SpokeForwarder;
//# sourceMappingURL=spoke-forwarder.js.map