import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'
import packageJson from './package.json' with { type: 'json' }

// Matches the Signal K Admin UI's own build (vite + @module-federation/vite).
//
// The Admin UI loads a panel by reading the server-injected
// <script src="/<plugin>/remoteEntry.js"> tag: when that tag carries
// type="module" — which the server emits because this package is
// "type": "module" — it does `await import(remoteEntryUrl)` and expects the
// module to export `get` and `init`. That is exactly what this plugin's
// federation output provides. See the server's serverroutes.ts and the
// admin UI's views/Webapps/dynamicutilities.ts.
const federationName = packageJson.name.replace(/[-@/]/g, '_')

export default defineConfig({
  // The remote is served from /<plugin-name>/, not the site root, and the
  // chunk URLs the entry resolves must stay relative to it.
  base: './',
  plugins: [
    react({
      // Classic runtime, matching the panel tsconfig's "jsx": "react".
      // The automatic runtime emits imports of react/jsx-runtime, which is
      // NOT in the `shared` scope below — the remote would then carry its own
      // copy of React's jsx runtime, giving the host page a second React
      // instance whose dispatcher is not the one the host set. `useState`
      // then reads null inside the host's render tree and the panel fails to
      // mount, at runtime, with no build error.
      jsxRuntime: 'classic'
    }),
    federation({
      name: federationName,
      filename: 'remoteEntry.js',
      exposes: {
        './PluginConfigurationPanel': './src/configpanel/PluginConfigurationPanel.tsx'
      },
      shared: {
        react: {
          singleton: true,
          requiredVersion: packageJson.devDependencies.react
        }
      },
      // No consumer imports this remote's types — the panel is loaded by
      // name at runtime — so skip emitting @mf-types/ into the published
      // package. It also dominates build time.
      dts: false
    })
  ],
  // `public/` is this plugin's OUTPUT directory (Signal K serves it), not a
  // Vite static-asset source. Leaving publicDir at its default would make Vite
  // try to copy public/ into itself — it warns, and on a clean tree the copy
  // races the build.js artifacts it just wrote there.
  publicDir: false,
  build: {
    // Federation supplies the real entry (remoteEntry.js); without this
    // rolldown looks for an index.html it will never find.
    rollupOptions: { input: './src/configpanel/index.ts' },
    outDir: 'public',
    // The published package ships public/ alongside the app icon and the
    // build.js redirect page; wiping the directory would take them with it.
    emptyOutDir: false,
    target: 'es2022',
    // Module Federation remotes must not be inlined into a single file, and
    // the host resolves chunks relative to remoteEntry.js.
    cssCodeSplit: false
  }
})
