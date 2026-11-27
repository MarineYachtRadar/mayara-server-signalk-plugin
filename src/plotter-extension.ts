import type { ServerAPI } from '@signalk/server-api'

const API_VERSION = '1'

/**
 * The Plotter Extensions manifest: the radar picture as a panel a chartplotter
 * (Freeboard-SK) can show beside its chart in a split screen. The page is the
 * GUI behind this plugin's proxy, so it reaches mayara wherever it runs.
 */
export function buildPlotterManifest(guiPath: string) {
  return {
    name: 'MaYaRa Radar',
    description: 'The radar picture (PPI) beside the chart',
    apiVersion: API_VERSION,
    requires: ['panels.iframe'],
    optional: ['panes'],
    panels: [
      {
        id: 'ppi',
        title: 'Radar',
        type: 'iframe',
        url: `${guiPath}/viewer.html`,
        pane: true
      }
    ]
  }
}

/** Offers the manifest under `id`. The server drops the provider when the plugin stops. */
export function registerPlotterExtension(
  app: Pick<ServerAPI, 'registerResourceProvider'>,
  id: string,
  manifest: object
): void {
  const readOnly = () => Promise.reject(new Error(`${id} is read-only`))
  app.registerResourceProvider({
    type: 'plotterExtensions',
    methods: {
      listResources: () => Promise.resolve({ [id]: manifest }),
      getResource: (resourceId: string) =>
        resourceId === id
          ? Promise.resolve(manifest)
          : Promise.reject(new Error(`No such plotterExtensions resource: ${resourceId}`)),
      setResource: readOnly,
      deleteResource: readOnly
    }
  })
}
