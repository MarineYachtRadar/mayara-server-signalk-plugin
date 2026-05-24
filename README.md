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
- **Check** — queries signalk-container's centralized update detection service. Auto-detects whether the running tag is semver (compare via GitHub releases) or floating like `latest`/`main` (compare local digest to remote). Offline-tolerant: if the boat is at sea, returns the last cached result rather than failing.
- **Update** — pulls the selected version, recreates the container, and reapplies the resource limits (see below).
- **Arguments** (advanced) — optional CLI args like `--brand furuno --interface eth0`

Without arguments, mayara-server auto-discovers all radar brands on all network interfaces.

### Signal K Authentication

The plugin reaches back into the local Signal K server in two places: it subscribes to navigation deltas over WebSocket (so the radar overlay can render own-ship heading/position), and it does a one-shot REST read of `/signalk/v1/api/vessels/` so the AIS overlay is populated immediately (rather than trickling in vessel-by-vessel over the next 5–60 s). On a Signal K server with security **enabled** — the default for fresh installs — both calls need a bearer token.

The plugin uses the standard Signal K device-access-request flow to obtain one. No copy-pasting tokens from the admin UI required:

1. **On first start**, the plugin POSTs a `readwrite` access request for `clientId = mayara-server-signalk-plugin`. The request appears in your admin UI under **Security → Access Requests** with description _"MaYaRa Radar (Server) — AIS overlay seeding + radar/target/notification writebacks"_.
2. Plugin status changes to _"Awaiting Signal K token approval — see Security → Access Requests"_. Approve the request once. (Mayara may also push radar targets, MARPA tracks, and notifications back to Signal K in future releases — hence the `readwrite` scope.)
3. The plugin caches the issued JWT to a `signalk-token` file in its plugin data directory (mode `0600`) — typically `~/.signalk/plugin-config-data/mayara-server-signalk-plugin/signalk-token` — and recreates the container with `-n ws:127.0.0.1:${PORT}` plus `--signalk-token-file /run/mayara/token`.
4. Subsequent restarts reuse the cached token — no further admin interaction.

Until the request is approved (or if you deny it), the container runs with `-n tcp:127.0.0.1:${TCPSTREAMPORT}` instead. Navigation deltas still flow, only the initial AIS REST snapshot is skipped (the overlay then fills from live deltas as vessels are heard).

**Settings:**

- **`requestSignalkToken`** (default: `true`) — disables the auto-request flow. Set to `false` if you'd rather mayara stay on the unauthenticated TCP stream, or if you intend to pass a token manually via `mayaraArgs: ["--signalk-token", "<token>"]` (or `--signalk-token-file`).

**Requirements:**

- mayara-server image with the `--signalk-token-file` flag — present on `:main` and on releases newer than v3.5.1. If your `Image version` is `latest` and the most recent release is still ≤ v3.5.1, switch to `main` (or wait for the next release) to exercise the WS-with-token path. The token request itself works regardless of the mayara version.
- Signal K's **Security → Settings → Allow New Device Registration** must remain enabled (it's on by default). If you've disabled it, the plugin's POST returns 403, the container stays on the TCP fallback, and plugin status surfaces a hint.

**Revoking access:** delete the device entry in **Security → Devices** (or **Security → Access Requests** if still listed there), then delete the plugin's cached token file:

```bash
rm ~/.signalk/plugin-config-data/mayara-server-signalk-plugin/signalk-token
```

Restart the plugin and it'll request a fresh token.

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

The webapp redirects to mayara-server's built-in GUI at `http://<host>:6502/gui/`.

## Features

- **Container management**: Pull, update, and run mayara-server via signalk-container with sensible default resource limits
- **Multi-radar support**: Auto-discovers all radars connected to mayara-server
- **Full Radar API**: Power, range, gain, sea/rain clutter, ARPA targets
- **Binary spoke streaming**: Forwards protobuf spoke data via SignalK's binaryStreamManager
- **Auto-reconnection**: Handles disconnections with configurable retry
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
