# Deployment Guide

This guide covers building, installing, and deploying mayara-server-signalk-plugin.

## Building & Installing

### Install from npm (Recommended)

```bash
cd ~/.signalk
npm install @marineyachtradar/signalk-plugin
```

The postinstall script automatically downloads the GUI from `@marineyachtradar/mayara-gui`.

### Install from Tarball

For offline installation or testing unreleased versions:

```bash
# On development machine: create tarball with GUI included
cd /path/to/mayara-server-signalk-plugin
npm run build -- --pack

# Copy .tgz to target machine, then:
cd ~/.signalk
npm install /path/to/marineyachtradar-signalk-plugin-x.x.x.tgz
```

### Build Options

The `build.js` script supports several options:

| Option | Description |
|--------|-------------|
| (none) | Copy GUI from `node_modules/@marineyachtradar/mayara-gui` |
| `--local-gui` | Copy GUI from sibling `../mayara-gui` directory (for development) |
| `--pack` | Create `.tgz` tarball with `public/` included |

**Examples:**

```bash
# Standard build (uses npm mayara-gui)
npm run build

# Development: use local mayara-gui
npm run build -- --local-gui

# Create tarball for manual installation
npm run build -- --pack

# Development: local GUI + create tarball
npm run build -- --local-gui --pack
```

### Development Setup

For plugin development with live GUI changes:

```bash
# 1. Clone repos side-by-side
cd ~/dev
git clone https://github.com/MarineYachtRadar/mayara-gui
git clone https://github.com/MarineYachtRadar/mayara-server-signalk-plugin

# 2. Build with local GUI
cd mayara-server-signalk-plugin
npm run build -- --local-gui

# 3. Link to SignalK
cd ~/.signalk
npm link ~/dev/mayara-server-signalk-plugin

# 4. After GUI changes, rebuild:
cd ~/dev/mayara-server-signalk-plugin
npm run build -- --local-gui
# Then restart SignalK
```

## Prerequisites

- **SignalK Server** >= 2.0.0 with Radar API support
- **mayara-server** running and accessible on the network
- At least one radar connected to mayara-server

## Deployment Scenarios

### Scenario 1: Local Development

Everything running on the same machine for development/testing.

```
┌────────────────────────────────────────────────────┐
│                  Development Machine                │
│                                                     │
│  mayara-server (localhost:6502)                    │
│       ↑                                            │
│       │ HTTP/WebSocket                             │
│       ↓                                            │
│  SignalK Server (localhost:3000)                   │
│       └── mayara-server-signalk-plugin             │
│              configured: host=localhost, port=6502 │
│                                                     │
│  Radar Simulator or real radar on local network    │
└────────────────────────────────────────────────────┘
```

**Setup:**
```bash
# Terminal 1: Start mayara-server
cd ~/dev/mayara-server
cargo run --release

# Terminal 2: Start SignalK with plugin
cd ~/.signalk
npm link @marineyachtradar/signalk-plugin
# Enable plugin in SignalK Admin UI
```

### Scenario 2: Dedicated Radar PC

mayara-server runs on a dedicated PC near the radar hardware, SignalK runs elsewhere.

```
┌─────────────────────┐              ┌─────────────────────┐
│    Radar PC         │              │   Navigation PC     │
│                     │              │                     │
│  mayara-server      │◄── Network ──│  SignalK Server     │
│  (192.168.1.100)    │   Ethernet   │  └── plugin         │
│       ↑             │              │      host=192.168.  │
│       │ Ethernet    │              │           1.100     │
│       ↓             │              │                     │
│  Radar Hardware     │              │  Chart Plotter      │
│  (Furuno/Navico/etc)│              │  (browser)          │
└─────────────────────┘              └─────────────────────┘
```

**Configuration:**
```
Host: 192.168.1.100
Port: 6502
Use HTTPS/WSS: false
```

### Scenario 3: Multiple Clients

One mayara-server serving multiple display systems.

```
                    ┌─────────────────────┐
                    │   mayara-server     │
                    │   (192.168.1.100)   │
                    └─────────┬───────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Direct Browser │ │  SignalK Server │ │ Future OpenCPN  │
│  (mayara-gui)   │ │  + plugin       │ │                 │
│  Helm station   │ │  Chart table    │ │  Nav station    │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

All clients share the same radar data stream from mayara-server.

### Scenario 4: Boat Network with Router

Typical production setup with network isolation.

```
┌─────────────────────────────────────────────────────────────┐
│                        Boat Network                          │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Radar Unit   │    │   Router     │    │   Tablet     │  │
│  │ 192.168.1.10 │◄──►│ 192.168.1.1  │◄──►│  Browser     │  │
│  └──────────────┘    └──────┬───────┘    └──────────────┘  │
│                             │                               │
│  ┌──────────────┐           │           ┌──────────────┐   │
│  │ Radar PC     │◄──────────┴──────────►│ Nav PC       │   │
│  │ mayara-server│                       │ SignalK      │   │
│  │ .100:6502    │                       │ .50:3000     │   │
│  └──────────────┘                       └──────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**SignalK Plugin Configuration:**
```
Host: 192.168.1.100
Port: 6502
```

## Security Considerations

### mayara-server

mayara-server does not currently implement authentication. In production:

- Keep mayara-server on a private network
- Use firewall rules to restrict access
- Consider VPN for remote access

### SignalK

SignalK provides JWT-based authentication. The plugin benefits from:

- SignalK's `authorizeWS()` for spoke streaming
- Standard SignalK access controls
- Integration with SignalK's user management

### HTTPS/WSS

For secure connections:

1. Configure TLS on mayara-server (not yet implemented)
2. Set `Use HTTPS/WSS: true` in plugin settings
3. Install valid certificates on mayara-server

## Troubleshooting

### Plugin shows "Cannot connect to mayara-server"

1. Verify mayara-server is running: `curl http://HOST:PORT/v2/api/radars`
2. Check network connectivity between SignalK and mayara-server
3. Verify firewall allows port 6502 (or configured port)

### No radars appear

1. Check mayara-server has discovered radars: `curl http://HOST:PORT/v2/api/radars`
2. Verify radar is powered and connected to network
3. Check mayara-server logs for discovery messages

### Spoke streaming not working

1. Verify WebSocket URL is reachable: `wscat -c ws://HOST:PORT/v2/api/radars/ID/spokes`
2. Check SignalK logs for SpokeForwarder connection messages
3. Verify `app.binaryStreamManager` is available in SignalK

### Reconnection loops

If the plugin keeps reconnecting:

1. Increase `Reconnect Interval` setting
2. Check for network instability
3. Verify mayara-server isn't restarting

## Performance Tuning

### Discovery Poll Interval

Default: 10 seconds

- Decrease for faster radar discovery
- Increase to reduce network traffic
- Minimum: 5 seconds

### Reconnect Interval

Default: 5 seconds

- Increase if network is unstable
- Decrease for faster recovery
- Minimum: 1 second

### Spoke Data Rate

Spoke streaming uses mayara-server's native rate. For Furuno radars this is
approximately 8192 spokes per revolution. SignalK's binaryStreamManager handles
backpressure automatically.
