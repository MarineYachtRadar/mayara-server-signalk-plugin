"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRadarProvider = createRadarProvider;
// The controls the Radar API types as auto-capable (RadarControlValue, a required boolean auto), as
// opposed to value-only controls like rain. gain and sea must always carry a boolean auto.
const AUTO_CAPABLE_CONTROLS = new Set(['gain', 'sea']);
// Forward every control mayara reports (gain, sea, rain, range, mode, targetTrails, ...) rather than only
// gain, so the discovery RadarInfo carries the full current control state mayara already returned. Values
// pass through as-is: numbers for level controls, but also strings for enum/list controls (mayara serves
// these as their label, e.g. targetTrails "Medium") and booleans for on/off controls. The auto flag is
// preserved where the radar reports one, and defaulted to false for the auto-capable controls (gain, sea)
// when mayara omits it — but only when their value is numeric, so a string-valued control never gets a
// spurious auto stapled on. The SK RadarControls index signature has no slot for non-numeric values, so
// the accumulator is widened and the final cast bridges to the API type.
function mapControls(controls) {
    const out = {};
    for (const [id, entry] of Object.entries(controls)) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        if (!('value' in entry))
            continue;
        const value = entry.value;
        const auto = entry.auto;
        if (typeof value === 'number' && typeof auto === 'boolean')
            out[id] = { auto, value };
        else if (typeof value === 'number' && AUTO_CAPABLE_CONTROLS.has(id))
            out[id] = { auto: false, value };
        else
            out[id] = { value };
    }
    // A radar that reports no gain still gets a sane default, as before.
    if (!('gain' in out))
        out.gain = { auto: true, value: 50 };
    return out;
}
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
                    // Normalise mayara's controls the way the discovery list used to
                    // (auto flags on gain/sea, gain default) — now that the lean
                    // RadarInfo carries no controls, /state and /controls are where
                    // clients read them.
                    controls: mapControls(controls)
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