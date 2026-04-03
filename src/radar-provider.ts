import { radar } from '@signalk/server-api'
import { MayaraClient } from './mayara-client'
import { MayaraServerAPI } from './types'

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
        const state = await client.getState(radarId)
        if (!state) return null

        const radars = await client.getRadars()
        const radarEntry = radars[radarId] as Record<string, unknown> | undefined

        const capabilities = (await client.getCapabilities(radarId)) as Record<string, unknown>

        const controls = (state.controls ?? {}) as Record<string, unknown>
        const rangeCtrl = controls.range as Record<string, unknown> | undefined
        const make = typeof radarEntry?.brand === 'string' ? radarEntry.brand : ''
        const model = typeof radarEntry?.model === 'string' ? radarEntry.model : ''
        const name = typeof radarEntry?.name === 'string' ? radarEntry.name : radarId

        return {
          id: radarId,
          name: name || (model ? `${make} ${model}`.trim() : radarId),
          brand: make || 'Unknown',
          status: (typeof state.status === 'string'
            ? state.status
            : 'standby') as radar.RadarStatus,
          spokesPerRevolution: Number(capabilities.spokesPerRevolution || 2048),
          maxSpokeLen: Number(capabilities.maxSpokeLength || 512),
          range: Number(rangeCtrl?.value ?? 1852),
          controls: {
            gain: (controls.gain as radar.RadarControlValue | undefined) ?? {
              auto: true,
              value: 50
            }
          }
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
        return (await client.getState(radarId)) as radar.RadarState | null
      } catch (err) {
        debug(`getState error for ${radarId}: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },

    async getControl(radarId: string, controlId: string): Promise<unknown> {
      try {
        const state = await client.getState(radarId)
        const controls = state?.controls as Record<string, unknown> | undefined
        return controls?.[controlId] ?? null
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
        await client.setControls(radarId, controls as Record<string, unknown>)
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
