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
                const radars = await client.getRadars();
                const radarEntry = radars[radarId];
                if (!radarEntry)
                    return null;
                // Lean discovery object per radar_api.md: identify the radar only. Live
                // state (status, controls) is served by getState/getControls, and static
                // parameters (spokesPerRevolution, maxSpokeLength, legend) by
                // getCapabilities — so nothing is lost, it just moves off the list.
                const brand = typeof radarEntry.brand === 'string' ? radarEntry.brand : 'Unknown';
                const model = typeof radarEntry.model === 'string' ? radarEntry.model : undefined;
                const info = {
                    name: typeof radarEntry.name === 'string'
                        ? radarEntry.name
                        : model
                            ? `${brand === 'Unknown' ? '' : brand} ${model}`.trim()
                            : radarId,
                    brand,
                    radarIpAddress: typeof radarEntry.radarIpAddress === 'string' ? radarEntry.radarIpAddress : ''
                };
                if (model)
                    info.model = model;
                // spokeDataUrl / streamUrl are intentionally omitted so clients use
                // signalk-server's own endpoints (…/radars/{id}/spokes and
                // /signalk/v1/stream), which reach the radar through this plugin even
                // when mayara runs on another host or container.
                return info;
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
                const controls = await client.getControls(radarId);
                const powerCtrl = controls.power;
                const status = powerCtrl?.value === 2 ? 'transmit' : powerCtrl?.value === 1 ? 'standby' : 'off';
                return {
                    id: radarId,
                    timestamp: new Date().toISOString(),
                    status: status,
                    // Forward mayara's controls verbatim. mayara already reports each
                    // control the way the Radar API expects — auto-capable controls
                    // (gain/sea/…) always carry a boolean `auto`, enum/list controls carry
                    // their label string — so no normalisation is needed here, and /state
                    // and /controls stay byte-identical to mayara's own responses.
                    controls: controls
                };
            }
            catch (err) {
                debug(`getState error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        },
        async getControl(radarId, controlId) {
            try {
                const controls = await client.getControls(radarId);
                return controls[controlId] ?? null;
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