# MaYaRa Server SignalK Plugin

A native SignalK plugin that connects to a remote [mayara-server](https://github.com/MarineYachtRadar/mayara-server) and exposes its radar(s) via SignalK's Radar API.

## Overview

This plugin acts as a thin proxy layer between SignalK and mayara-server. All radar logic (protocol handling, signal processing) runs on mayara-server - this plugin simply forwards control commands and streams radar data.

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
│  │      │        SignalK Radar API v2              │         │  │
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

## Requirements

- **SignalK Server** >= 2.0.0 (with Radar API support)
- **mayara-server** running and accessible on the network

## Installation

### From npm (recommended)

```bash
npm install @marineyachtradar/signalk-plugin
```

### From source

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
| **Use HTTPS/WSS** | Enable secure connections (requires TLS on mayara-server) | `false` |
| **Discovery Poll Interval** | How often to poll for new/disconnected radars (seconds) | `10` |
| **Reconnect Interval** | How often to retry when mayara-server is unreachable (seconds) | `5` |

## Features

- **Multi-radar support**: Automatically discovers and manages all radars connected to mayara-server
- **Full Radar API**: Implements SignalK's RadarProviderMethods interface
  - Power control (off/standby/transmit)
  - Range selection
  - Gain, sea clutter, and rain clutter adjustment
  - ARPA target acquisition and tracking
- **Binary spoke streaming**: Uses SignalK's built-in binaryStreamManager for efficient data delivery
- **Auto-reconnection**: Handles network disconnections gracefully
- **Integrated GUI**: Includes the MaYaRa radar display webapp

## API Endpoints

Once configured, the plugin exposes radars at:

- `GET /signalk/v2/api/vessels/self/radars` - List all radars
- `GET /signalk/v2/api/vessels/self/radars/{id}` - Radar info
- `GET /signalk/v2/api/vessels/self/radars/{id}/capabilities` - Capability manifest
- `GET /signalk/v2/api/vessels/self/radars/{id}/state` - Current state
- `PUT /signalk/v2/api/vessels/self/radars/{id}/controls/{control}` - Set control
- `GET /signalk/v2/api/vessels/self/radars/{id}/targets` - ARPA targets
- `WS /signalk/v2/api/vessels/self/radars/{id}/stream` - Binary spoke data

## GUI

The radar display is available at:
```
http://your-signalk-server:3000/@marineyachtradar/signalk-plugin/
```

## Development

```bash
# Use local mayara-gui instead of npm version
npm run build -- --local-gui

# Link for development
npm link
cd ~/.signalk
npm link @marineyachtradar/signalk-plugin
```

## License

Apache-2.0 - See [LICENSE](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)
