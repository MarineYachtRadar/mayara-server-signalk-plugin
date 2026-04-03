"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRadarProvider = createRadarProvider;
function createRadarProvider(client, app) {
    const debug = app.debug.bind(app);
    return {
        async getRadars() {
            try {
                const radars = await client.getRadars();
                return Object.keys(radars);
            }
            catch (err) {
                debug(`getRadars error: ${err instanceof Error ? err.message : String(err)}`);
                return [];
            }
        },
        async getRadarInfo(radarId) {
            try {
                const state = await client.getState(radarId);
                if (!state)
                    return null;
                const radars = await client.getRadars();
                const radarEntry = radars[radarId];
                const capabilities = (await client.getCapabilities(radarId));
                const controls = (state.controls ?? {});
                const rangeCtrl = controls.range;
                const make = typeof radarEntry?.brand === 'string' ? radarEntry.brand : '';
                const model = typeof radarEntry?.model === 'string' ? radarEntry.model : '';
                const name = typeof radarEntry?.name === 'string' ? radarEntry.name : radarId;
                return {
                    id: radarId,
                    name: name || (model ? `${make} ${model}`.trim() : radarId),
                    brand: make || 'Unknown',
                    status: (typeof state.status === 'string'
                        ? state.status
                        : 'standby'),
                    spokesPerRevolution: Number(capabilities.spokesPerRevolution || 2048),
                    maxSpokeLen: Number(capabilities.maxSpokeLength || 512),
                    range: Number(rangeCtrl?.value ?? 1852),
                    controls: {
                        gain: controls.gain ?? {
                            auto: true,
                            value: 50
                        }
                    }
                };
            }
            catch (err) {
                debug(`getRadarInfo error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        },
        async getCapabilities(radarId) {
            try {
                return (await client.getCapabilities(radarId));
            }
            catch (err) {
                debug(`getCapabilities error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        },
        async getState(radarId) {
            try {
                return (await client.getState(radarId));
            }
            catch (err) {
                debug(`getState error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        },
        async getControl(radarId, controlId) {
            try {
                const state = await client.getState(radarId);
                const controls = state?.controls;
                return controls?.[controlId] ?? null;
            }
            catch (err) {
                debug(`getControl error for ${radarId}/${controlId}: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        },
        async setPower(radarId, state) {
            try {
                await client.setControl(radarId, 'power', state);
                return true;
            }
            catch (err) {
                debug(`setPower error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        },
        async setRange(radarId, range) {
            try {
                await client.setControl(radarId, 'range', range);
                return true;
            }
            catch (err) {
                debug(`setRange error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        },
        async setGain(radarId, gain) {
            try {
                const value = { mode: gain.auto ? 'auto' : 'manual', value: gain.value ?? 50 };
                await client.setControl(radarId, 'gain', value);
                return true;
            }
            catch (err) {
                debug(`setGain error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        },
        async setSea(radarId, sea) {
            try {
                const value = { mode: sea.auto ? 'auto' : 'manual', value: sea.value ?? 50 };
                await client.setControl(radarId, 'sea', value);
                return true;
            }
            catch (err) {
                debug(`setSea error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        },
        async setRain(radarId, rain) {
            try {
                const value = { mode: rain.auto ? 'auto' : 'manual', value: rain.value ?? 0 };
                await client.setControl(radarId, 'rain', value);
                return true;
            }
            catch (err) {
                debug(`setRain error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        },
        async setControl(radarId, controlId, value) {
            try {
                await client.setControl(radarId, controlId, value);
                return { success: true };
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                debug(`setControl error for ${radarId}/${controlId}: ${message}`);
                return { success: false, error: message };
            }
        },
        async setControls(radarId, controls) {
            try {
                await client.setControls(radarId, controls);
                return true;
            }
            catch (err) {
                debug(`setControls error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        },
        async getTargets(radarId) {
            try {
                return (await client.getTargets(radarId));
            }
            catch (err) {
                debug(`getTargets error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        },
        async acquireTarget(radarId, bearing, distance) {
            try {
                const result = await client.acquireTarget(radarId, bearing, distance);
                return { success: true, targetId: result.targetId };
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                debug(`acquireTarget error for ${radarId}: ${message}`);
                return { success: false, error: message };
            }
        },
        async cancelTarget(radarId, targetId) {
            try {
                await client.cancelTarget(radarId, targetId);
                return true;
            }
            catch (err) {
                debug(`cancelTarget error for ${radarId}/${targetId}: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        }
    };
}
//# sourceMappingURL=radar-provider.js.map