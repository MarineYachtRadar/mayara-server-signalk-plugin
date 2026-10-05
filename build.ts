#!/usr/bin/env node
/**
 * Build script for mayara-server-signalk-plugin
 *
 * Creates public/ with a redirect page to mayara-server's GUI.
 * The actual radar GUI runs on mayara-server itself.
 * Vite adds remoteEntry.js for the config panel.
 */

import fs from 'node:fs'
import path from 'node:path'

const projectRoot = import.meta.dirname

const publicDest = path.join(projectRoot, 'public')

function main() {
  console.log('=== MaYaRa SignalK Plugin Build ===\n')

  if (fs.existsSync(publicDest)) {
    fs.rmSync(publicDest, { recursive: true })
  }
  fs.mkdirSync(publicDest, { recursive: true })
  fs.mkdirSync(path.join(publicDest, 'assets'), { recursive: true })

  // Copy logo for webapp icon. SignalK resolves signalk.appIcon relative to
  // public/, so the file must live at public/assets/mayara_logo.png in the
  // published package.
  const logoSrc = path.resolve(projectRoot, 'assets', 'mayara_logo.png')
  const logoDest = path.join(publicDest, 'assets', 'mayara_logo.png')
  if (!fs.existsSync(logoSrc)) {
    throw new Error(`Logo source missing: ${logoSrc}`)
  }
  fs.copyFileSync(logoSrc, logoDest)

  // Create redirect page. The target is resolved at runtime from
  // /api/gui-url, because it depends on the `directGuiUrl` setting:
  // mayara's own host:port by default, or a same-origin path served by the
  // plugin's reverse proxy when the operator disables it (the browser then
  // stays on the SK server's host/port, inheriting its TLS, and only the SK
  // port needs to be open). The proxy path is also the fallback if the
  // request fails, since it is valid in either configuration.
  fs.writeFileSync(
    path.join(publicDest, 'index.html'),
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>MaYaRa Radar</title>
  <link rel="icon" type="image/png" href="assets/mayara_logo.png">
  <script>
    var PROXY_URL = '/plugins/mayara-server-signalk-plugin/gui/';
    fetch('/plugins/mayara-server-signalk-plugin/api/gui-url')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        window.location.replace(j && typeof j.url === 'string' ? j.url : PROXY_URL);
      })
      .catch(function () { window.location.replace(PROXY_URL); });
  </script>
  <style>
    body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #111; color: #ccc; }
    .box { text-align: center; }
    .box img { width: 80px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="box">
    <img src="assets/mayara_logo.png" alt="MaYaRa">
    <p id="msg">Opening radar UI...</p>
    <!-- Without scripting the fetch above never runs, so offer the proxy
         path — always valid, and the default when directGuiUrl is off — as
         a plain link rather than leaving the page stuck on "Opening…". -->
    <noscript>
      <p><a href="/plugins/mayara-server-signalk-plugin/gui/">Open the radar UI</a></p>
    </noscript>
  </div>
</body>
</html>
`
  )

  console.log('Created redirect page in public/\n')
  console.log('=== Build complete ===')
}

main()
