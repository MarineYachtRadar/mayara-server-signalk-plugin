import { describe, it, expect } from 'vitest'
import type { ResourceProvider } from '@signalk/server-api'
import { buildPlotterManifest, registerPlotterExtension } from '../src/plotter-extension.js'

const GUI = '/plugins/mayara-server-signalk-plugin/gui'

const registered = () => {
  const providers: ResourceProvider[] = []
  const manifest = buildPlotterManifest(GUI)
  registerPlotterExtension(
    { registerResourceProvider: (p: ResourceProvider) => providers.push(p) },
    'mayara-server-signalk-plugin',
    manifest
  )
  return { provider: providers[0], manifest }
}

describe('plotter extension', () => {
  it('offers the radar picture as a pane through the GUI proxy', () => {
    const manifest = buildPlotterManifest(GUI)
    expect(manifest.apiVersion).toBe('1')
    expect(manifest.requires).toEqual(['panels.iframe'])
    expect(manifest.panels).toEqual([
      {
        id: 'ppi',
        title: 'Radar',
        type: 'iframe',
        url: `${GUI}/viewer.html`,
        pane: true
      }
    ])
  })

  it('lists the manifest under the plugin id', async () => {
    const { provider, manifest } = registered()
    expect(provider.type).toBe('plotterExtensions')
    await expect(provider.methods.listResources({})).resolves.toEqual({
      'mayara-server-signalk-plugin': manifest
    })
    await expect(provider.methods.getResource('mayara-server-signalk-plugin')).resolves.toBe(
      manifest
    )
    await expect(provider.methods.getResource('other')).rejects.toThrow()
  })

  it('is read-only', async () => {
    const { provider } = registered()
    await expect(provider.methods.setResource('mayara-server-signalk-plugin', {})).rejects.toThrow(
      'read-only'
    )
    await expect(provider.methods.deleteResource('mayara-server-signalk-plugin')).rejects.toThrow(
      'read-only'
    )
  })
})
