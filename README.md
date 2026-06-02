# MaYaRa Server SignalK Plugin

A SignalK plugin that connects to [mayara-server](https://github.com/MarineYachtRadar/mayara-server) and exposes marine radars via SignalK's Radar API. Supports automatic container management via [signalk-container](https://github.com/dirkwa/signalk-container).

## Prerequisites

- **SignalK Server ≥ 2.24.0** (the Radar API ships in 2.24.0+)
- **Node.js ≥ 22** (tested on Node 22 and 24)
- **[signalk-container](https://github.com/dirkwa/signalk-container) ≥ 1.6.0** (for managed container mode, optional)
- **Podman** or **Docker** runtime (for managed container mode)

## How It Works

The plugin acts as a thin proxy between SignalK and mayara-server. All radar protocol handling runs in mayara-server — this plugin registers as a Radar API provider, forwards control commands, and streams binary spoke data.

```
┌─────────────────────────────────────────────────────────────────┐
│                        SignalK Server                           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              mayara-server-signalk-plugin                 │  │
│  │                                                           │  │
│  │  HTTP Client ──────► RadarProvider ◄────── SpokeForwarder │  │
│  │      │                    │                     │         │  │
│  └──────┼────────────────────┼─────────────────────┼─────────┘  │
│         │    radarApi.register()     binaryStreamManager        │
│         │                    │                     │            │
│  ┌──────┼────────────────────┼─────────────────────┼─────────┐  │
│  │      │        SignalK Radar API                 │         │  │
│  │      │  /signalk/v2/api/vessels/self/radars/*   │         │  │
│  └──────┼──────────────────────────────────────────┼─────────┘  │
└─────────┼──────────────────────────────────────────┼────────────┘
          │ HTTP                            WebSocket│
          ▼                                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  mayara-server (container)                       │
│  /signalk/v2/api/vessels/self/radars/*           .../spokes     │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

Install from the **SignalK App Store** or from source:

```bash
git clone https://github.com/MarineYachtRadar/mayara-server-signalk-plugin
cd mayara-server-signalk-plugin
npm install
npm run build
npm link
# In your SignalK server directory:
npm link @marineyachtradar/signalk-plugin
```

## Configuration

The plugin provides a custom configuration panel in the SignalK Admin UI.

### Container Mode (default)

With **signalk-container** installed, the plugin automatically pulls and manages the `ghcr.io/marineyachtradar/mayara-server` container image using host networking for radar multicast discovery.

- **Image version** — select `latest`, `main`, or a specific release tag
- **Auto-update on each plugin start** — when the selected version is a floating tag (`latest`, `main`, etc.), the plugin pulls from the registry on every start, compares the registry digest against the running container's image, and recreates if newer. Offline-tolerant: if the boat is out of cell coverage at boot, the check is skipped silently and the cached container keeps running. Semver-pinned versions are never auto-updated — pin to a specific release tag if you want to freeze on a known build.
- **Check** — queries signalk-container's centralized update detection service. Auto-detects whether the running tag is semver (compare via GitHub releases) or floating like `latest`/`main` (compare local digest to remote). Offline-tolerant: if the boat is at sea, returns the last cached result rather than failing.
- **Update** — pulls the selected version, recreates the container, and reapplies the resource limits (see below).
- **Arguments** (advanced) — optional CLI args like `--brand furuno --interface eth0`

Without arguments, mayara-server auto-discovers all radar brands on all network interfaces.

### Signal K Authentication

The plugin reaches back into the local Signal K server in two places: it subscribes to navigation deltas over WebSocket (so the radar overlay can render own-ship heading/position), and it does a one-shot REST read of `/signalk/v1/api/vessels/` so the AIS overlay is populated immediately (rather than trickling in vessel-by-vessel over the next 5–60 s). On a Signal K server with security **enabled** — the default for fresh installs — both calls need a bearer token.

The plugin uses the standard Signal K device-access-request flow to obtain one. No copy-pasting tokens from the admin UI required:

1. **On first start**, the plugin POSTs a `readwrite` access request for `clientId = mayara-server-signalk-plugin`. The request appears in your admin UI under **Security → Access Requests** with description _"MaYaRa Radar (Server) — AIS overlay seeding + radar/target/notification writebacks"_.
2. Plugin status changes to _"Awaiting Signal K token approval — see Security → Access Requests"_. Approve the request once. (Mayara may also push radar targets, MARPA tracks, and notifications back to Signal K in future releases — hence the `readwrite` scope.)
3. The plugin caches the issued JWT to a `signalk-token` file in its plugin data directory (mode `0600`) — typically `~/.signalk/plugin-config-data/mayara-server-signalk-plugin/signalk-token` — and recreates the container with `-n ws:127.0.0.1:${PORT}` plus the token delivered through the `MAYARA_SIGNALK_TOKEN` environment variable. (The token is passed as an env var rather than a bind-mounted file because the container runs as a different UID than the Signal K host process, and env vars cross that boundary cleanly.)
4. Subsequent restarts reuse the cached token. On start the plugin first validates it against Signal K; if it's still good there's no further admin interaction, and if it was revoked the plugin drops it and requests a fresh one automatically (see _Revoking access_ below).

Until the request is approved (or if you deny it), the container runs with `-n tcp:127.0.0.1:${TCPSTREAMPORT}` instead. Navigation deltas still flow, only the initial AIS REST snapshot is skipped (the overlay then fills from live deltas as vessels are heard). If the request is denied, device registration is disabled, or the request expires, the plugin keeps re-requesting on the reconnect interval — so approving (or enabling device registration) later is picked up without restarting the plugin.

While the upstream connection is unauthenticated or hasn't delivered navigation yet, the radar GUI surfaces an on-screen status banner (e.g. _"Waiting for SignalK token approval"_ or _"SignalK navigation lost"_), so the cause of a missing position/AIS overlay is visible without digging through logs. That banner is implemented in mayara-server itself; see its documentation for details.

**Settings:**

- **`requestSignalkToken`** (default: `true`) — disables the auto-request flow. Set to `false` if you'd rather mayara stay on the unauthenticated TCP stream, or if you intend to pass a token manually via `mayaraArgs: ["--signalk-token", "<token>"]` (or `--signalk-token-file`).

**Requirements:**

- mayara-server image that accepts the token via the `MAYARA_SIGNALK_TOKEN` environment variable — present on `:main` and on releases newer than v3.5.1. If your `Image version` is `latest` and the most recent release is still ≤ v3.5.1, switch to `main` (or wait for the next release) to exercise the WS-with-token path. The token request itself works regardless of the mayara version.
- Signal K's **Security → Settings → Allow New Device Registration** must remain enabled (it's on by default). If you've disabled it, the plugin's POST returns 403 and the container stays on the TCP fallback; plugin status surfaces a hint and it keeps re-requesting, so enabling registration later recovers without a restart.

**Revoking access:** delete the device entry in **Security → Devices** (or deny it under **Security → Access Requests**). That's all — no manual file cleanup needed. The plugin notices the cached token has been revoked, discards it, drops the container back to the unauthenticated TCP stream, and requests a fresh one. Approve the new request and the AIS overlay re-seeds automatically.

### Resource Limits

The plugin sets sensible default resource caps so a runaway container can't take down Signal K:

| Setting        | Default | Why                                                  |
| -------------- | ------- | ---------------------------------------------------- |
| `cpus`         | `2`     | Mayara processing peaks ≈ 1 core; headroom for spikes and multi-radar |
| `memory`       | `512m`  | Hard memory cap, OOM-killed if exceeded              |
| `memorySwap`   | `512m`  | = memory → swap disabled (recommended on Pi/eMMC)     |
| `pidsLimit`    | `200`   | Bounds runaway thread leaks                          |

Tested on a Pi 5 8GB with a Garmin xHD2 at 24 NM range. If your setup needs different limits (e.g. multiple radars, larger range, weaker hardware), override per-field via signalk-container's plugin config under **Per-container resource overrides**:

```json
{
  "mayara-server": {
    "cpus": 3.0,
    "memory": "1g",
    "memorySwap": "1g"
  }
}
```

The override is field-level merged on top of the plugin defaults — you don't have to know what the plugin set, just specify what you want different. Use `null` to remove a specific limit set by the plugin (e.g. `{"memory": null}` for unlimited memory).

See [signalk-container's developer guide](https://github.com/dirkwa/signalk-container/blob/master/doc/plugin-developer-guide.md#resource-limits) for the full reference.

### External Mode

Set **Managed container** to off to connect to a mayara-server instance running elsewhere:

- **Host** — IP address or hostname
- **Port** — HTTP port (default: 6502)

### Radar Display

The webapp opens mayara-server's built-in GUI proxied through the Signal K
server at `/plugins/mayara-server-signalk-plugin/gui/`, so only the Signal K
port needs to be reachable — mayara-server's own port (6502) does not have to
be exposed. The proxy forwards the GUI's REST calls and its radar/state/spoke
WebSocket streams to mayara-server, over both HTTP and HTTPS.

## Features

- **Container management**: Pull, update, and run mayara-server via signalk-container with sensible default resource limits
- **Multi-radar support**: Auto-discovers all radars connected to mayara-server
- **Full Radar API**: Power, range, gain, sea/rain clutter, ARPA targets
- **Binary spoke streaming**: Forwards protobuf spoke data via SignalK's binaryStreamManager
- **Auto-reconnection**: Handles disconnections with configurable retry
- **Resilient Signal K authentication**: Requests a device token automatically, validates the cached token on start, and re-requests without a restart if it's denied, revoked, or expires
- **Centralized update detection**: Delegated to signalk-container's update service. Auto-detects semver vs floating tags, offline-tolerant with persistent cache, no direct shellouts.
- **User-configurable resource limits**: Default caps on CPU, memory, and PIDs; per-field overrides via signalk-container's config.

## Development

```bash
npm install
npm run build
```

### Scripts

- `npm run format` — prettier + eslint --fix
- `npm run lint` — eslint check
- `npm run build` — compile TypeScript + webpack config panel
- `npm run test` — run tests (vitest)
- `npm run build:all` — lint + build + test

## Related Projects

- **[mayara-server](https://github.com/MarineYachtRadar/mayara-server)** — Standalone radar server
- **[signalk-container](https://github.com/dirkwa/signalk-container)** — Container manager for SignalK
- **[Signal K Server](https://github.com/SignalK/signalk-server)** ≥ 2.24.0 — provides the Radar API

## License

Apache-2.0 — See [LICENSE](LICENSE)
