#!/usr/bin/env node
/**
 * Build script for mayara-server-signalk-plugin
 *
 * Creates public/ with a redirect page to mayara-server's GUI.
 * The actual radar GUI runs on mayara-server itself.
 * Webpack adds remoteEntry.js for the config panel.
 */

const fs = require('fs')
const path = require('path')

const publicDest = path.join(__dirname, 'public')

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
  const logoSrc = path.resolve(__dirname, 'assets', 'mayara_logo.png')
  const logoDest = path.join(publicDest, 'assets', 'mayara_logo.png')
  if (!fs.existsSync(logoSrc)) {
    throw new Error(`Logo source missing: ${logoSrc}`)
  }
  fs.copyFileSync(logoSrc, logoDest)

  // Create redirect page
  fs.writeFileSync(
    path.join(publicDest, 'index.html'),
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>MaYaRa Radar</title>
  <script>
    fetch('/plugins/mayara-server-signalk-plugin/api/gui-url')
      .then(r => r.json())
      .then(data => {
        // Replace localhost/127.0.0.1 with browser's hostname (for managed containers)
        const url = new URL(data.url);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
          url.hostname = window.location.hostname;
        }
        window.location.href = url.href;
      })
      .catch(() => {
        document.getElementById('msg').textContent = 'mayara-server not reachable. Check plugin configuration.';
      });
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
    <p id="msg">Redirecting to mayara-server...</p>
  </div>
</body>
</html>
`
  )

  console.log('Created redirect page in public/\n')
  console.log('=== Build complete ===')
}

main()
