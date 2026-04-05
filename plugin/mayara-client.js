"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MayaraClient = void 0;
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const API_BASE = '/signalk/v2/api/vessels/self/radars';
class MayaraClient {
    host;
    port;
    secure;
    timeout;
    debug;
    constructor(options) {
        this.host = options.host;
        this.port = options.port;
        this.secure = options.secure ?? false;
        this.timeout = options.timeout ?? 10000;
        this.debug = options.debug ?? (() => { });
    }
    async request(method, path, body = null) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.host,
                port: this.port,
                path,
                method,
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                },
                timeout: this.timeout
            };
            const transport = this.secure ? https_1.default : http_1.default;
            const req = transport.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(data ? JSON.parse(data) : null);
                        }
                        catch {
                            resolve(data);
                        }
                    }
                    else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    }
    async getRadars() {
        return (await this.request('GET', API_BASE));
    }
    async getCapabilities(radarId) {
        return this.request('GET', `${API_BASE}/${radarId}/capabilities`);
    }
    async getControls(radarId) {
        return (await this.request('GET', `${API_BASE}/${radarId}/controls`));
    }
    async setControl(radarId, controlId, value) {
        return this.request('PUT', `${API_BASE}/${radarId}/controls/${controlId}`, { value });
    }
    async setControls(radarId, controls) {
        return this.request('PUT', `${API_BASE}/${radarId}/controls`, controls);
    }
    async getTargets(radarId) {
        return this.request('GET', `${API_BASE}/${radarId}/targets`);
    }
    async acquireTarget(radarId, bearing, distance) {
        return (await this.request('POST', `${API_BASE}/${radarId}/targets/acquire`, {
            bearing,
            distance
        }));
    }
    async cancelTarget(radarId, targetId) {
        return this.request('DELETE', `${API_BASE}/${radarId}/targets/${targetId}`);
    }
    getSpokeStreamUrl(radarId) {
        const wsProtocol = this.secure ? 'wss' : 'ws';
        return `${wsProtocol}://${this.host}:${this.port}${API_BASE}/${radarId}/spokes`;
    }
    getTargetStreamUrl(radarId) {
        const wsProtocol = this.secure ? 'wss' : 'ws';
        return `${wsProtocol}://${this.host}:${this.port}${API_BASE}/${radarId}/targets/stream`;
    }
    close() {
        // No persistent connections to close for HTTP client
    }
}
exports.MayaraClient = MayaraClient;
//# sourceMappingURL=mayara-client.js.map