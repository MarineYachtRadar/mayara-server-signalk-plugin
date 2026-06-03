import { describe, it, expect } from 'vitest'
import { rewriteGuiProxyPath } from '../src/gui-proxy-path'

describe('rewriteGuiProxyPath', () => {
  it('passes the bare /signalk discovery probe through unchanged', () => {
    expect(rewriteGuiProxyPath('/signalk')).toBe('/signalk')
  })

  it('passes /signalk/... API paths through unchanged', () => {
    expect(rewriteGuiProxyPath('/signalk/v2/api/vessels/self/radars')).toBe(
      '/signalk/v2/api/vessels/self/radars'
    )
  })

  it('passes /v2/ recordings paths through unchanged', () => {
    // Regression: these were mistakenly prefixed with /gui and 404'd behind
    // the Signal K proxy.
    expect(rewriteGuiProxyPath('/v2/api/vessels/self/radars/recordings/radars')).toBe(
      '/v2/api/vessels/self/radars/recordings/radars'
    )
    expect(rewriteGuiProxyPath('/v2/api/vessels/self/radars/recordings/files')).toBe(
      '/v2/api/vessels/self/radars/recordings/files'
    )
  })

  it('passes /v2/ debug-panel paths through unchanged', () => {
    expect(rewriteGuiProxyPath('/v2/api/debug/events')).toBe('/v2/api/debug/events')
  })

  it('prepends /gui to static asset paths', () => {
    expect(rewriteGuiProxyPath('/')).toBe('/gui/')
    expect(rewriteGuiProxyPath('/mayara.js')).toBe('/gui/mayara.js')
    expect(rewriteGuiProxyPath('/vendor/van-1.5.2.js')).toBe('/gui/vendor/van-1.5.2.js')
    expect(rewriteGuiProxyPath('/recordings.html')).toBe('/gui/recordings.html')
  })

  it('does not treat a /signalk substring elsewhere as an API path', () => {
    // Only a leading /signalk counts; an asset that merely contains the word
    // must still be served from /gui.
    expect(rewriteGuiProxyPath('/img/signalk-logo.png')).toBe('/gui/img/signalk-logo.png')
  })
})
