# MaYaRa Server SignalK Plugin

A native SignalK plugin that connects to a remote [mayara-server](https://github.com/MarineYachtRadar/mayara-server) and exposes its radar(s) via SignalK's Radar API.

## Prerequisites

This plugin requires SignalK server with the **Radar API** enabled. The Radar API is not yet in upstream SignalK — it is available via:

- **PR [SignalK/signalk-server#2357](https://github.com/SignalK/signalk-server/pull/2357)** — Radar API refactored

Until that PR is merged, use a SignalK server build that includes the Radar API (e.g. from the `radar_api` branch).

Also requires **mayara-server** running and accessible on the network.

## Overview

This plugin acts as a thin proxy layer between SignalK and mayara-server. All radar logic (protocol handling, signal processing) runs on mayara-server — this plugin simply forwards control commands and streams radar data.

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
│                        mayara-server                            │
│         /v2/api/radars/*              /v2/api/radars/*/spokes   │
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

Enable the plugin in SignalK Admin UI and configure:

| Setting | Description | Default |
|---------|-------------|---------|
| **Host** | IP address or hostname of mayara-server | `localhost` |
| **Port** | HTTP port of mayara-server REST API | `6502` |
| **Use HTTPS/WSS** | Enable secure connections | `false` |
| **Discovery Poll Interval** | How often to poll for new/disconnected radars (seconds) | `10` |
| **Reconnect Interval** | How often to retry when mayara-server is unreachable (seconds) | `5` |

## Features

- **Multi-radar support**: Automatically discovers and manages all radars connected to mayara-server
- **Full Radar API**: Power, range, gain, sea/rain clutter, ARPA targets
- **Binary spoke streaming**: Uses SignalK's binaryStreamManager for efficient data delivery
- **Auto-reconnection**: Handles network disconnections gracefully
- **Integrated GUI**: Includes the MaYaRa radar display webapp

## GUI

The radar display is available at:
```
http://your-signalk-server:3000/@marineyachtradar/signalk-plugin/
```

## Development

The GUI is sourced from [mayara-server](https://github.com/MarineYachtRadar/mayara-server)'s `web/gui/` directory (expected as a sibling checkout at `../mayara-server/`).

```bash
npm install
npm run build
```

To specify a different GUI source path:

```bash
node build.js --gui-path /path/to/mayara-server/web/gui
```

### Scripts

- `npm run format` — prettier + eslint --fix
- `npm run lint` — eslint check
- `npm run build` — compile TypeScript + copy GUI
- `npm run test` — run tests (vitest)
- `npm run build:all` — lint + build + test

## Related Projects

- **[mayara-server](https://github.com/MarineYachtRadar/mayara-server)** - Standalone radar server (provides GUI)
- **[signalk-playback-plugin](https://github.com/MarineYachtRadar/mayara-server-signalk-playbackrecordings-plugin)** - Play recorded .mrr files through SignalK
- **[signalk-server#2357](https://github.com/SignalK/signalk-server/pull/2357)** - Radar API for SignalK server

## License

Apache-2.0 - See [LICENSE](LICENSE)
