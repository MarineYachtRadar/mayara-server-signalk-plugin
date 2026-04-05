# MaYaRa Server SignalK Plugin

A SignalK plugin that connects to [mayara-server](https://github.com/MarineYachtRadar/mayara-server) and exposes marine radars via SignalK's Radar API. Supports automatic container management via [signalk-container](https://github.com/dirkwa/signalk-container).

## Prerequisites

- **SignalK Server** with the Radar API — **PR [SignalK/signalk-server#2357](https://github.com/SignalK/signalk-server/pull/2357)**
- **[signalk-container](https://github.com/dirkwa/signalk-container)** plugin (for managed container mode, optional)
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
- **Check** — pulls the selected tag and compares against the running container
- **Update** — pulls, stops, removes, and recreates the container with the new image
- **Arguments** (advanced) — optional CLI args like `--brand furuno --interface eth0`

Without arguments, mayara-server auto-discovers all radar brands on all network interfaces.

### External Mode

Set **Managed container** to off to connect to a mayara-server instance running elsewhere:

- **Host** — IP address or hostname
- **Port** — HTTP port (default: 6502)

### Radar Display

The webapp redirects to mayara-server's built-in GUI at `http://<host>:6502/gui/`.

## Features

- **Container management**: Pull, update, and run mayara-server via signalk-container
- **Multi-radar support**: Auto-discovers all radars connected to mayara-server
- **Full Radar API**: Power, range, gain, sea/rain clutter, ARPA targets
- **Binary spoke streaming**: Forwards protobuf spoke data via SignalK's binaryStreamManager
- **Auto-reconnection**: Handles disconnections with configurable retry
- **Update detection**: Compare running container image against registry

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
- **[signalk-server#2357](https://github.com/SignalK/signalk-server/pull/2357)** — Radar API for SignalK server

## License

Apache-2.0 — See [LICENSE](LICENSE)
