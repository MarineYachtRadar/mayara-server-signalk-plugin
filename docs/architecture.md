# Plugin Architecture

This document describes the internal architecture of mayara-server-signalk-plugin.

## Overview

The plugin acts as a **thin proxy layer** between SignalK and mayara-server. All radar
logic (protocol handling, ARPA tracking, signal processing) runs on mayara-server.
The plugin's job is to:

1. Discover radars from mayara-server
2. Expose them via SignalK's Radar API
3. Forward binary spoke data efficiently

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SignalK Server                                    │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                   mayara-server-signalk-plugin                          │ │
│  │                                                                         │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │ │
│  │  │  MayaraClient   │  │  RadarProvider  │  │    SpokeForwarder       │ │ │
│  │  │  (HTTP client)  │  │  (API methods)  │  │  (WS → emitData)        │ │ │
│  │  └────────┬────────┘  └────────┬────────┘  └────────────┬────────────┘ │ │
│  │           │                    │                        │              │ │
│  └───────────┼────────────────────┼────────────────────────┼──────────────┘ │
│              │   radarApi.register()      binaryStreamManager.emitData()    │
│              │                    │                        │                │
│  ┌───────────┼────────────────────┼────────────────────────┼──────────────┐ │
│  │           │        SignalK Radar API v2                 │              │ │
│  │           │   /signalk/v2/api/vessels/self/radars/*     │              │ │
│  │           │   Security: JWT via authorizeWS()           │              │ │
│  └───────────┼────────────────────────────────────────────────────────────┘ │
└──────────────┼──────────────────────────────────────────────────────────────┘
               │ HTTP + WebSocket
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            mayara-server                                     │
│              /v2/api/radars/*            /v2/api/radars/*/spokes             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Module Structure

### index.js (Main Entry Point)

The main plugin module that:
- Defines plugin metadata (id, name, schema)
- Implements `start()` and `stop()` lifecycle methods
- Registers with SignalK's `app.radarApi.register()`
- Manages discovery polling and reconnection
- Creates/destroys SpokeForwarders per radar

**Key State:**
- `client` - MayaraClient instance
- `provider` - RadarProvider methods object
- `spokeForwarders` - Map of radarId → SpokeForwarder
- `knownRadars` - Set of currently discovered radar IDs

### mayara-client.js (HTTP Client)

Simple HTTP client for mayara-server's REST API:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `getRadars()` | GET /v2/api/radars | List all radars |
| `getCapabilities(id)` | GET /v2/api/radars/{id}/capabilities | Capability manifest |
| `getState(id)` | GET /v2/api/radars/{id}/state | Current state |
| `setControl(id, ctrl, val)` | PUT /v2/api/radars/{id}/controls/{ctrl} | Set control |
| `setControls(id, ctrls)` | PUT /v2/api/radars/{id}/controls | Batch set |
| `getTargets(id)` | GET /v2/api/radars/{id}/targets | ARPA targets |
| `acquireTarget(id, b, d)` | POST /v2/api/radars/{id}/targets | Acquire target |
| `cancelTarget(id, tid)` | DELETE /v2/api/radars/{id}/targets/{tid} | Cancel target |
| `getSpokeStreamUrl(id)` | - | WebSocket URL for spokes |

### radar-provider.js (RadarProviderMethods)

Implements SignalK's `RadarProviderMethods` interface by proxying to mayara-server:

**Required Methods:**
- `getRadars()` - Returns array of radar IDs
- `getRadarInfo(id)` - Builds RadarInfo from state/capabilities
- `getCapabilities(id)` - Returns capability manifest
- `getState(id)` - Returns current radar state
- `setControl(id, ctrl, val)` - Sets a control value
- `setControls(id, ctrls)` - Sets multiple controls

**ARPA Methods:**
- `getTargets(id)` - Returns tracked targets
- `acquireTarget(id, bearing, distance)` - Manual target acquisition
- `cancelTarget(id, targetId)` - Cancel tracking

**Note:** Does NOT implement `handleStreamConnection`. Spoke streaming is handled
by SpokeForwarder using `binaryStreamManager.emitData()`.

### spoke-forwarder.js (WebSocket → binaryStreamManager)

Connects to mayara-server's spoke WebSocket and forwards binary data to SignalK's
built-in binary stream infrastructure.

```
mayara-server                    SpokeForwarder                  SignalK
ws://.../spokes  ──binary──►  ws.on('message')  ──►  binaryStreamManager.emitData()
                                                              │
                                                              ▼
                                                 /signalk/v2/api/.../stream
                                                    (to connected clients)
```

**Why use binaryStreamManager?**
- SignalK handles client WebSocket connections automatically
- Security (JWT auth) handled by SignalK's `authorizeWS()`
- Backpressure handling (slow clients disconnected)
- Consistent with mayara-signalk-wasm architecture

**Reconnection Logic:**
- On WebSocket close/error, schedules reconnect after `reconnectInterval`
- Respects `closed` flag to prevent reconnect after stop()

## Lifecycle

### Plugin Start

```
1. Create MayaraClient with host/port from settings
2. Create RadarProvider with client reference
3. Check app.radarApi exists (requires SignalK >= 2.0)
4. Register: app.radarApi.register(plugin.id, { name, methods: provider })
5. Start connection/discovery: connectAndDiscover(settings)
```

### connectAndDiscover()

```
1. Try client.getRadars()
   ├─ Success:
   │   ├─ Set isConnected = true
   │   ├─ Call updateRadars() with radar IDs
   │   └─ Start discovery polling interval
   │
   └─ Failure:
       ├─ Set isConnected = false
       ├─ Set plugin error status
       └─ Start reconnect interval
```

### updateRadars()

```
For each radarId in current list:
   If new (not in knownRadars):
      ├─ Add to knownRadars
      ├─ Create SpokeForwarder for this radar
      └─ Start forwarder

For each radarId in knownRadars:
   If removed (not in current list):
      ├─ Remove from knownRadars
      ├─ Stop SpokeForwarder
      └─ Delete forwarder
```

### Plugin Stop

```
1. Unregister: app.radarApi.unRegister(plugin.id)
2. Clear discovery interval
3. Clear reconnect interval
4. Stop all SpokeForwarders
5. Close MayaraClient
```

## Configuration Schema

```javascript
{
  host: string,              // mayara-server hostname (default: 'localhost')
  port: number,              // mayara-server port (default: 6502)
  secure: boolean,           // Use HTTPS/WSS (default: false)
  discoveryPollInterval: number,  // Seconds between radar list polls (default: 10)
  reconnectInterval: number  // Seconds between reconnect attempts (default: 5)
}
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| mayara-server unreachable | Set plugin error, start reconnect timer |
| Radar disappears | Remove from knownRadars, stop SpokeForwarder |
| WebSocket error | Log error, schedule reconnect |
| API call fails | Log error, return null/false to SignalK |

## Design Decisions

### Why Not WASM?

The mayara-signalk-wasm plugin embeds mayara-core directly for standalone operation.
This plugin is for deployments where:

- mayara-server runs on separate hardware (dedicated radar PC)
- Multiple clients need to share the same radar (browser, SignalK, future OpenCPN)
- Network separation is desired between radar hardware and display systems

### Why binaryStreamManager Instead of handleStreamConnection?

SignalK provides `binaryStreamManager` for efficient binary streaming:

1. **Security**: JWT authentication handled by SignalK
2. **Backpressure**: Slow clients automatically disconnected
3. **Simplicity**: No custom WebSocket server code needed
4. **Consistency**: Same pattern used by mayara-signalk-wasm

### Why Poll for Radar Discovery?

Mayara-server's REST API is pull-based. The plugin polls `/v2/api/radars` periodically
to detect:

- New radars connecting to mayara-server
- Radars disconnecting from mayara-server

A push-based notification system could be added to mayara-server in the future.
