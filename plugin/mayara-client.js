import http from 'http';
import https from 'https';
const API_BASE = '/signalk/v2/api/vessels/self/radars';
export class MayaraClient {
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
            const transport = this.secure ? https : http;
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
        const response = (await this.request('GET', API_BASE));
        // mayara returns the `{ version, radars }` envelope; unwrap to the bare
        // `{ id: RadarInfo }` map so callers can key by radar id (and `Object.keys`
        // yields radar ids, not `version`/`radars`). Tolerate an older bare response.
        const radars = response.radars;
        return (radars && typeof radars === 'object' ? radars : response);
    }
    async getCapabilities(radarId) {
        return this.request('GET', `${API_BASE}/${radarId}/capabilities`);
    }
    async getControls(radarId) {
        return (await this.request('GET', `${API_BASE}/${radarId}/controls`));
    }
    async setControl(radarId, controlId, value) {
        // A scalar gets the Signal K `{ value }` envelope; a compound payload is
        // already the body mayara expects and must go through as-is. Wrapping it
        // unconditionally produced `{ value: { enabled: …, endDistance: … } }`,
        // which mayara rejects with "Cannot control 'guardZone2' to value {…}" —
        // so guard zones and no-transmit sectors could not be set at all.
        const body = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { value };
        return this.request('PUT', `${API_BASE}/${radarId}/controls/${controlId}`, body);
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
    /**
     * mayara's Signal K v1 stream. Used by DeltaForwarder to relay
     * `notifications.*` and `radars.*` deltas upstream.
     *
     * `?subscribe=none` is deliberate: under Signal K's subscription model the
     * default (`self`) streams own-ship `navigation.*` too, but the plugin must
     * NOT forward nav — mayara only has it because it received it from Signal K
     * in the first place, so re-publishing it would loop it back. Starting from
     * `none` and letting the forwarder subscribe to exactly `radars.*` /
     * `notifications.*` keeps nav (and AIS) out, and stays correct whether mayara
     * treats a later subscribe as additive (SK-compliant) or narrowing.
     */
    getStateStreamUrl() {
        const wsProtocol = this.secure ? 'wss' : 'ws';
        return `${wsProtocol}://${this.host}:${this.port}/signalk/v1/stream?subscribe=none`;
    }
    close() {
        // No persistent connections to close for HTTP client
    }
}
//# sourceMappingURL=mayara-client.js.map