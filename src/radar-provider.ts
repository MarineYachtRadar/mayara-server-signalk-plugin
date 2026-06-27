import { radar } from '@signalk/server-api'
import { MayaraClient } from './mayara-client'
import { MayaraServerAPI } from './types'

// mayara serves its color legend inside /capabilities as `legend.pixels`, an array indexed by pixel
// value where each entry is `{ color, type }`. Map it to the Radar API `LegendEntry[]` so consumers can
// color spoke samples; the array index is the sample value, so each entry bounds itself to that value.
function mapLegend(capabilities: Record<string, unknown>): radar.LegendEntry[] | undefined {
  const legend = capabilities.legend as { pixels?: unknown } | undefined
  const pixels = legend ? legend.pixels : undefined
  if (!Array.isArray(pixels)) return undefined
  const entries: radar.LegendEntry[] = []
  pixels.forEach((pixel, index) => {
    if (typeof pixel !== 'object' || pixel === null) return
    const color = (pixel as { color?: unknown }).color
    if (typeof color !== 'string') return
    const type = (pixel as { type?: unknown }).type
    entries.push({
      color,
      label: typeof type === 'string' ? type : `level ${index}`,
      minValue: index,
      maxValue: index
    })
  })
  return entries.length > 0 ? entries : undefined
}

// The controls the Radar API types as auto-capable (RadarControlValue, a required boolean auto), as
// opposed to value-only controls like rain. gain and sea must always carry a boolean auto.
const AUTO_CAPABLE_CONTROLS = new Set(['gain', 'sea'])

// Forward every control mayara reports (gain, sea, rain, range, mode, ...) rather than only gain, so the
// discovery RadarInfo carries the full current control state mayara already returned. The auto flag is
// preserved where the radar reports one, and defaulted to false for the auto-capable controls (gain,
// sea) when mayara omits it, so their required RadarControlValue shape always holds.
function mapControls(controls: Record<string, unknown>): radar.RadarControls {
  const out: Record<string, radar.RadarControlValue | { value: number }> = {}
  for (const [id, entry] of Object.entries(controls)) {
    if (typeof entry !== 'object' || entry === null) continue
    const value = (entry as { value?: unknown }).value
    if (typeof value !== 'number') continue
    const auto = (entry as { auto?: unknown }).auto
    if (typeof auto === 'boolean') out[id] = { auto, value }
    else if (AUTO_CAPABLE_CONTROLS.has(id)) out[id] = { auto: false, value }
    else out[id] = { value }
  }
  // A radar that reports no gain still gets a sane default, as before.
  if (!('gain' in out)) out.gain = { auto: true, value: 50 }
  return out as radar.RadarControls
}

export function createRadarProvider(
  client: MayaraClient,
  app: MayaraServerAPI
): radar.RadarProviderMethods {
  const debug = app.debug.bind(app)

  return {
    async getRadars(): Promise<string[]> {
      try {
        const radars = await client.getRadars()
        return Object.keys(radars)
      } catch (err) {
        debug(`getRadars error: ${err instanceof Error ? err.message : String(err)}`)
        return []
      }
    },

    async getRadarInfo(radarId: string): Promise<radar.RadarInfo | null> {
      try {
        const radars = await client.getRadars()
        const radarEntry = radars[radarId] as Record<string, unknown> | undefined
        if (!radarEntry) return null

        const controls = await client.getControls(radarId)
        const capabilities = (await client.getCapabilities(radarId)) as Record<string, unknown>

        const powerCtrl = controls.power as Record<string, unknown> | undefined
        const rangeCtrl = controls.range as Record<string, unknown> | undefined
        const status =
          powerCtrl?.value === 2 ? 'transmit' : powerCtrl?.value === 1 ? 'standby' : 'off'

        const legend = mapLegend(capabilities)

        return {
          id: radarId,
          name:
            typeof radarEntry.name === 'string'
              ? radarEntry.name
              : typeof radarEntry.model === 'string'
                ? `${typeof radarEntry.brand === 'string' ? radarEntry.brand : ''} ${radarEntry.model}`.trim()
                : radarId,
          brand: typeof radarEntry.brand === 'string' ? radarEntry.brand : 'Unknown',
          status: status as radar.RadarStatus,
          spokesPerRevolution: Number(capabilities.spokesPerRevolution || 2048),
          maxSpokeLen: Number(capabilities.maxSpokeLength || 512),
          range: Number(rangeCtrl?.value ?? 1852),
          controls: mapControls(controls),
          ...(legend ? { legend } : {})
        }
      } catch (err) {
        debug(
          `getRadarInfo error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`
        )
        return null
      }
    },

    async getCapabilities(radarId: string): Promise<radar.CapabilityManifest | null> {
      try {
        return (await client.getCapabilities(radarId)) as radar.CapabilityManifest | null
      } catch (err) {
        debug(
          `getCapabilities error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`
        )
        return null
      }
    },

    async getState(radarId: string): Promise<radar.RadarState | null> {
      try {
        const controls = await client.getControls(radarId)
        const powerCtrl = controls.power as Record<string, unknown> | undefined
        const status =
          powerCtrl?.value === 2 ? 'transmit' : powerCtrl?.value === 1 ? 'standby' : 'off'

        return {
          id: radarId,
          timestamp: new Date().toISOString(),
          status: status as radar.RadarStatus,
          controls: controls
        }
      } catch (err) {
        debug(`getState error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },

    async getControl(radarId: string, controlId: string): Promise<unknown> {
      try {
        const controls = await client.getControls(radarId)
        return controls[controlId] ?? null
      } catch (err) {
        debug(
          `getControl error for ${radarId}/${controlId}: ${err instanceof Error ? err.message : String(err)}`
        )
        return null
      }
    },

    async setPower(radarId: string, state: radar.RadarStatus): Promise<boolean> {
      try {
        await client.setControl(radarId, 'power', state)
        return true
      } catch (err) {
        debug(`setPower error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    },

    async setRange(radarId: string, range: number): Promise<boolean> {
      try {
        await client.setControl(radarId, 'range', range)
        return true
      } catch (err) {
        debug(`setRange error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    },

    async setGain(radarId: string, gain: { auto: boolean; value?: number }): Promise<boolean> {
      try {
        const value = { mode: gain.auto ? 'auto' : 'manual', value: gain.value ?? 50 }
        await client.setControl(radarId, 'gain', value)
        return true
      } catch (err) {
        debug(`setGain error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    },

    async setSea(radarId: string, sea: { auto: boolean; value?: number }): Promise<boolean> {
      try {
        const value = { mode: sea.auto ? 'auto' : 'manual', value: sea.value ?? 50 }
        await client.setControl(radarId, 'sea', value)
        return true
      } catch (err) {
        debug(`setSea error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    },

    async setRain(radarId: string, rain: { auto: boolean; value?: number }): Promise<boolean> {
      try {
        const value = { mode: rain.auto ? 'auto' : 'manual', value: rain.value ?? 0 }
        await client.setControl(radarId, 'rain', value)
        return true
      } catch (err) {
        debug(`setRain error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    },

    async setControl(
      radarId: string,
      controlId: string,
      value: unknown
    ): Promise<{ success: boolean; error?: string }> {
      try {
        await client.setControl(radarId, controlId, value)
        return { success: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        debug(`setControl error for ${radarId}/${controlId}: ${message}`)
        return { success: false, error: message }
      }
    },

    async setControls(radarId: string, controls: Partial<radar.RadarControls>): Promise<boolean> {
      try {
        await client.setControls(radarId, controls)
        return true
      } catch (err) {
        debug(
          `setControls error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`
        )
        return false
      }
    },

    async getTargets(radarId: string): Promise<radar.TargetListResponse | null> {
      try {
        return (await client.getTargets(radarId)) as radar.TargetListResponse | null
      } catch (err) {
        debug(
          `getTargets error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`
        )
        return null
      }
    },

    async acquireTarget(
      radarId: string,
      bearing: number,
      distance: number
    ): Promise<{ success: boolean; targetId?: number; error?: string }> {
      try {
        const result = await client.acquireTarget(radarId, bearing, distance)
        return { success: true, targetId: result.targetId as number }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        debug(`acquireTarget error for ${radarId}: ${message}`)
        return { success: false, error: message }
      }
    },

    async cancelTarget(radarId: string, targetId: number): Promise<boolean> {
      try {
        await client.cancelTarget(radarId, targetId)
        return true
      } catch (err) {
        debug(
          `cancelTarget error for ${radarId}/${targetId}: ${err instanceof Error ? err.message : String(err)}`
        )
        return false
      }
    }
  }
}
