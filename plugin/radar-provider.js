/**
 * RadarProvider implementation for SignalK Radar API
 *
 * Implements RadarProviderMethods interface by proxying calls to mayara-server.
 * See: signalk-server/packages/server-api/src/radarapi.ts
 */

/**
 * Create a RadarProvider that proxies to mayara-server
 * @param {MayaraClient} client - The mayara-server HTTP client
 * @param {object} app - SignalK app object
 * @returns {object} - RadarProviderMethods implementation
 */
function createRadarProvider(client, app) {
  const debug = app.debug.bind(app)

  return {
    // ============================================
    // Required Methods
    // ============================================

    /**
     * Get list of radar IDs this provider manages
     * @returns {Promise<string[]>} - Array of radar IDs
     */
    async getRadars() {
      try {
        const radars = await client.getRadars()
        // mayara-server returns object keyed by ID
        return Object.keys(radars)
      } catch (err) {
        debug(`getRadars error: ${err.message}`)
        return []
      }
    },

    /**
     * Get detailed info for a specific radar
     * @param {string} radarId - The radar ID
     * @returns {Promise<RadarInfo|null>} - Radar info or null
     */
    async getRadarInfo(radarId) {
      try {
        const state = await client.getState(radarId)
        if (!state) return null

        const capabilities = await client.getCapabilities(radarId)

        // Build RadarInfo from state and capabilities
        return {
          id: radarId,
          name: capabilities?.model
            ? `${capabilities.make || ''} ${capabilities.model}`.trim()
            : radarId,
          brand: capabilities?.make || 'Unknown',
          status: state.status || 'standby',
          spokesPerRevolution: capabilities?.characteristics?.spokesPerRevolution || 2048,
          maxSpokeLen: capabilities?.characteristics?.maxSpokeLength || 512,
          range: state.controls?.range || 1852,
          controls: {
            gain: state.controls?.gain || { auto: true, value: 50 },
            sea: state.controls?.sea || { auto: true, value: 50 },
            rain: state.controls?.rain || { value: 0 }
          },
          // streamUrl undefined = use SignalK's built-in stream endpoint
          streamUrl: undefined
        }
      } catch (err) {
        debug(`getRadarInfo error for ${radarId}: ${err.message}`)
        return null
      }
    },

    // ============================================
    // Capability and State Methods
    // ============================================

    /**
     * Get capability manifest for a radar
     * @param {string} radarId - The radar ID
     * @returns {Promise<CapabilityManifest|null>}
     */
    async getCapabilities(radarId) {
      try {
        return await client.getCapabilities(radarId)
      } catch (err) {
        debug(`getCapabilities error for ${radarId}: ${err.message}`)
        return null
      }
    },

    /**
     * Get current radar state
     * @param {string} radarId - The radar ID
     * @returns {Promise<RadarState|null>}
     */
    async getState(radarId) {
      try {
        return await client.getState(radarId)
      } catch (err) {
        debug(`getState error for ${radarId}: ${err.message}`)
        return null
      }
    },

    /**
     * Get a single control value
     * @param {string} radarId - The radar ID
     * @param {string} controlId - The control ID
     * @returns {Promise<any|null>}
     */
    async getControl(radarId, controlId) {
      try {
        const state = await client.getState(radarId)
        return state?.controls?.[controlId] ?? null
      } catch (err) {
        debug(`getControl error for ${radarId}/${controlId}: ${err.message}`)
        return null
      }
    },

    // ============================================
    // Control Methods
    // ============================================

    /**
     * Set radar power state
     * @param {string} radarId - The radar ID
     * @param {string} state - Power state (off, standby, transmit)
     * @returns {Promise<boolean>}
     */
    async setPower(radarId, state) {
      try {
        await client.setControl(radarId, 'power', state)
        return true
      } catch (err) {
        debug(`setPower error for ${radarId}: ${err.message}`)
        return false
      }
    },

    /**
     * Set radar range
     * @param {string} radarId - The radar ID
     * @param {number} range - Range in meters
     * @returns {Promise<boolean>}
     */
    async setRange(radarId, range) {
      try {
        await client.setControl(radarId, 'range', range)
        return true
      } catch (err) {
        debug(`setRange error for ${radarId}: ${err.message}`)
        return false
      }
    },

    /**
     * Set radar gain
     * @param {string} radarId - The radar ID
     * @param {object} gain - { auto: boolean, value?: number }
     * @returns {Promise<boolean>}
     */
    async setGain(radarId, gain) {
      try {
        const value = {
          mode: gain.auto ? 'auto' : 'manual',
          value: gain.value ?? 50
        }
        await client.setControl(radarId, 'gain', value)
        return true
      } catch (err) {
        debug(`setGain error for ${radarId}: ${err.message}`)
        return false
      }
    },

    /**
     * Set sea clutter
     * @param {string} radarId - The radar ID
     * @param {object} sea - { auto: boolean, value?: number }
     * @returns {Promise<boolean>}
     */
    async setSea(radarId, sea) {
      try {
        const value = {
          mode: sea.auto ? 'auto' : 'manual',
          value: sea.value ?? 50
        }
        await client.setControl(radarId, 'sea', value)
        return true
      } catch (err) {
        debug(`setSea error for ${radarId}: ${err.message}`)
        return false
      }
    },

    /**
     * Set rain clutter
     * @param {string} radarId - The radar ID
     * @param {object} rain - { auto: boolean, value?: number }
     * @returns {Promise<boolean>}
     */
    async setRain(radarId, rain) {
      try {
        const value = {
          mode: rain.auto ? 'auto' : 'manual',
          value: rain.value ?? 0
        }
        await client.setControl(radarId, 'rain', value)
        return true
      } catch (err) {
        debug(`setRain error for ${radarId}: ${err.message}`)
        return false
      }
    },

    /**
     * Set a single control value
     * @param {string} radarId - The radar ID
     * @param {string} controlId - The control ID
     * @param {any} value - The value to set
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async setControl(radarId, controlId, value) {
      try {
        await client.setControl(radarId, controlId, value)
        return { success: true }
      } catch (err) {
        debug(`setControl error for ${radarId}/${controlId}: ${err.message}`)
        return { success: false, error: err.message }
      }
    },

    /**
     * Set multiple controls at once
     * @param {string} radarId - The radar ID
     * @param {object} controls - Partial controls to update
     * @returns {Promise<boolean>}
     */
    async setControls(radarId, controls) {
      try {
        await client.setControls(radarId, controls)
        return true
      } catch (err) {
        debug(`setControls error for ${radarId}: ${err.message}`)
        return false
      }
    },

    // ============================================
    // ARPA Target Methods
    // ============================================

    /**
     * Get all tracked ARPA targets
     * @param {string} radarId - The radar ID
     * @returns {Promise<TargetListResponse|null>}
     */
    async getTargets(radarId) {
      try {
        return await client.getTargets(radarId)
      } catch (err) {
        debug(`getTargets error for ${radarId}: ${err.message}`)
        return null
      }
    },

    /**
     * Manually acquire a target
     * @param {string} radarId - The radar ID
     * @param {number} bearing - Bearing in degrees (0-360)
     * @param {number} distance - Distance in meters
     * @returns {Promise<{success: boolean, targetId?: number, error?: string}>}
     */
    async acquireTarget(radarId, bearing, distance) {
      try {
        const result = await client.acquireTarget(radarId, bearing, distance)
        return { success: true, targetId: result.targetId }
      } catch (err) {
        debug(`acquireTarget error for ${radarId}: ${err.message}`)
        return { success: false, error: err.message }
      }
    },

    /**
     * Cancel tracking of a target
     * @param {string} radarId - The radar ID
     * @param {number} targetId - The target ID
     * @returns {Promise<boolean>}
     */
    async cancelTarget(radarId, targetId) {
      try {
        await client.cancelTarget(radarId, targetId)
        return true
      } catch (err) {
        debug(`cancelTarget error for ${radarId}/${targetId}: ${err.message}`)
        return false
      }
    }

    // Note: handleStreamConnection is NOT implemented here.
    // Spoke streaming is handled by SpokeForwarder which uses
    // app.binaryStreamManager.emitData() directly.
  }
}

module.exports = createRadarProvider
