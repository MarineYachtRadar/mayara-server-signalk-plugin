# Radar API divergence: mayara-server vs. signalk-server vs. this plugin

**Date:** 2026-07-19
**Observed against:** mayara-server 3.6.0 (`http://10.56.0.1:6502`), signalk-server
2.30.0 with this plugin (`http://10.56.0.147:3000`), a Navico HALO24 (dual range
`nav1034A` / `nav1034B`).

While building an OpenCPN client (`mayara_pi`) against the Signal K Radar API, it
became clear that three things implement/serve "the radar API" and they do not
agree with each other — nor with the spec document that ships in the
signalk-server repo. This note records the concrete differences so they can be
reconciled.

## The three components

1. **mayara-server** — the standalone Rust server. Reference implementation of
   the Signal K Radar API per `signalk-server/docs/develop/rest-api/radar_api.md`.
2. **signalk-server radar API** — `signalk-server/src/api/radar/` (framework +
   REST/AsyncAPI surface) that a provider plugin registers with.
3. **this plugin** (`mayara-server-signalk-plugin`) — bridges mayara-server into
   signalk-server. It has two distinct code paths:
   - `radar-provider.ts` registers radars with the signalk-server radar API, and
     `spoke-forwarder.ts` forwards mayara's spokes into signalk-server's
     `binaryStreamManager`.
   - a `guiProxy` (`index.ts`, `router.use('/gui', …)`) that proxies
     mayara-server's _own_ HTTP API/GUI and rewrites stream URLs.

## Comparison

| Aspect                                    | mayara-server (:6502)                                   | signalk-server radar API (:3000)                                                                                                  | this plugin                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Radar **list** shape                      | keyed object `{ "nav1034A": {…} }`                      | **array** `[ { "id": "nav1034A", … } ]`                                                                                           | proxy assumes **keyed** (`Object.values`, `index.ts`)                                                                  |
| `spokeDataUrl` / `streamUrl` in list      | present                                                 | **absent**                                                                                                                        | present + rewritten (`index.ts` `rewriteStreamUrl`)                                                                    |
| spoke-length field                        | `maxSpokeLength`                                        | list: `maxSpokeLen`; capabilities: `maxSpokeLength`                                                                               | —                                                                                                                      |
| `capabilities`                            | spec format                                             | same spec format (incl. `legend.pixels`)                                                                                          | proxied                                                                                                                |
| **spoke stream** (binary, `spokeDataUrl`) | `…/radars/{id}/spokes` binary protobuf WS               | binary forwarding **implemented but mis-pathed at `…/radars/{id}/stream`** (`src/api/streams/index.ts`), not the spec's `/spokes` | emits into `binaryStreamManager` (streamId `radars/{id}`) — client-exposed by that endpoint                            |
| **control stream** (JSON, `streamUrl`)    | `radars.{id}.controls.*` deltas on `/signalk/v1/stream` | the standard SK delta/PUT stream **already exists**; it just carries no `radars.*` yet                                            | subscribes to mayara's v1 stream but **filters to notifications only** — radar deltas not republished, no PUT handlers |

Re-verified 2026-07-19 against the current `../signalk-server` tree (`radar_api.md`
last touched Jun 21, commit `9cd2ebe0` "Radar API refactored"; impl predates it):
every row above still holds unchanged **except the stream rows, corrected below**
— the original single-row claim that "the spoke stream is unimplemented / not
client-exposed" was wrong, _and_ it conflated two very different transports.

### Correction: two streams, and neither needs new signalk-server WS infra

A radar exposes **two independent streams**, and they are unrelated transports —
do not model them as one endpoint at two paths.

1. **`spokeDataUrl` → `…/radars/{id}/spokes`** — one-way **binary** protobuf spoke
   image data, high-frequency, server → client. The radar picture.
2. **`streamUrl` → `/signalk/v1/stream`** — the **standard Signal K delta/PUT
   stream**, _not_ a radar-specific socket. Radar state is modelled as Signal K
   paths (`radars.{id}.controls.*`, target data); a client subscribes for
   control-value / target deltas and sends Signal K **PUTs** to change controls.
   This is confirmed by observation (2026-07-20): mayara publishes the full
   control set — `radars.nav1034A.controls.{gain,power,range,sea,rain,mode,
doppler,targetTrails,…}` (both radars, plus `meta`) — on its own
   `ws://…/signalk/v1/stream`, exactly the URL its `/signalk` discovery advertises
   as `signalk-ws`.

**Binary (`/spokes`) already works — just at the wrong path.** The infrastructure
lives in a _different_ module than the radar API:

- `initializeBinaryStreams()` (`src/api/streams/index.ts`, wired at
  `src/api/index.ts:70`) installs a server-level `upgrade` listener serving the
  generic `…/api/streams/{streamId}` and the radar alias
  `…/api/vessels/self/radars/{id}/stream` → streamId `radars/{id}`.
- `BinaryStreamManager` (`src/api/streams/binary-stream-manager.ts`) fans frames
  out to all clients with a 256 KB-per-client backpressure cap and slow-consumer
  disconnect — production-grade, not a stub.
- This plugin's `spoke-forwarder.ts` already emits to that streamId, so binary
  spokes reach a client **through signalk-server** today — but the alias is named
  `/stream`, so it is serving _binary_ on a path whose name implies the control
  channel. It must move to `/spokes`.

**Control (`streamUrl`) needs no new signalk-server endpoint — the bridge is
plugin-side.** Signal K's `/signalk/v1/stream` already does deltas (out) and PUTs
(in); the gap is purely that radar data is not bridged across it:

- **mayara → SK (state out).** The plugin already connects to mayara's v1 stream
  but `notification-forwarder.ts` **filters to `notifications.*`**, so SK's
  `/signalk/v1/stream` carries **no `radars.*` paths** (verified: 98 messages, none).
  Widening the forwarder to also republish `radars.*` deltas via
  `app.handleMessage()` (stamping the proper `context`) surfaces live radar state
  to every SK subscriber.
- **SK → mayara (control in).** A client changes a control with a Signal K PUT
  (over the v1 stream or REST). The plugin registers
  `app.registerPutHandler('vessels.self', 'radars.<id>.controls.<control>', …)`
  and forwards to mayara's `PUT /…/radars/{id}/controls/{control}` — which
  `MayaraClient.setControl` already calls and mayara already serves.

Caveat: mayara's own `/signalk/v1/stream` is only loosely SK-conformant — its
hello omits `self` and its deltas omit `context` (MarineYachtRadar/mayara-server#462).
The plugin re-stamps `context` when republishing via `app.handleMessage()`, so this
is invisible to clients consuming radar data _through_ signalk-server; it only bites
a client pointed directly at mayara's stream.

So the control "stream" is standard Signal K plumbing the plugin bridges, not a
WebSocket signalk-server has to grow. The stale `radar/index.ts:812` note
("providers should expose their own streamUrl") points readers away from the
`streams/` module and should be fixed to reference `/spokes` (binary, in
`streams/`) and `/signalk/v1/stream` (control, standard SK).

**Fourth representation (added on re-verification).** signalk-server does not have
one shape and one spec — it has _four_ representations that disagree:

1. `radar_api.md` (hand-written spec): keyed `{ version, radars: { id: RadarInfo } }`,
   lean `RadarInfo` (`name/brand/model?/radarIpAddress/spokeDataUrl/streamUrl`),
   `maxSpokeLength`, `/spokes`.
2. `src/api/radar/openApi.ts` (machine OpenAPI served at `/admin/openapi`): `RadarInfo`
   requires `name/brand/spokeDataUrl/streamUrl/radarIpAddress` — the _lean_ shape,
   matching the markdown, **not** the array the server actually emits.
3. `packages/server-api/src/radarapi.ts` + `typebox/radar-schemas.ts` (the exported
   TypeScript type / TypeBox schema): rich `RadarInfo`
   (`id/status/spokesPerRevolution/maxSpokeLen/range/controls/legend?/streamUrl?`),
   no `spokeDataUrl`, `streamUrl` optional.
4. `src/api/radar/index.ts` (the running code): returns a bare **array** of the rich
   `RadarInfo` from #3. (The binary spoke WS _is_ implemented, but in the separate
   `src/api/streams/` module at `/stream`, not `/spokes` — see the stream correction
   above.)

So the two docs (#1, #2) describe the lean/keyed shape; the type and the code (#3, #4)
are the rich/array shape. Only #3 and #4 agree with each other.

### Observed responses

mayara-server list (keyed, with URLs):

```json
{
  "nav1034A": {
    "brand": "Navico",
    "model": "HALO24",
    "name": "Halo;",
    "radarIpAddress": "10.56.0.102",
    "spokeDataUrl": "ws://10.56.0.1:6502/signalk/v2/api/vessels/self/radars/nav1034A/spokes",
    "streamUrl": "ws://10.56.0.1:6502/signalk/v1/stream",
    "replay": false
  }
}
```

signalk-server list (array, no URLs, `maxSpokeLen`):

```json
[
  {
    "id": "nav1034A",
    "name": "Halo;",
    "brand": "Navico",
    "status": "transmit",
    "spokesPerRevolution": 2048,
    "maxSpokeLen": 1024,
    "range": 115,
    "controls": { "gain": { "auto": true, "value": 80 } }
  }
]
```

Note the same signalk-server returns `maxSpokeLength` from
`…/radars/nav1034A/capabilities` but `maxSpokeLen` in the list above — an
inconsistency _within_ one server.

## The three specific mismatches

1. **Spec vs. implementation, same repo.** `radar_api.md` (v3.1.0, in the
   signalk-server repo) documents the _keyed_ object, `spokeDataUrl`, and
   `/spokes` — which matches **mayara-server exactly**. signalk-server's actual
   `src/api/radar` implementation emits the _array_ shape and omits the URLs. So
   the implementation diverges from its own spec.

2. **Two streams: binary mis-pathed, control not bridged.** A radar has a **binary
   spoke** stream (`spokeDataUrl` → `/spokes`) and a **control/target** stream
   (`streamUrl` → the standard SK `/signalk/v1/stream`) — see the correction above.
   signalk-server forwards the _binary_ one (via `src/api/streams/`, fed by this
   plugin) but names it `/stream`, so it must move to `/spokes`. The control stream
   is not a missing endpoint — SK's v1 delta/PUT stream already exists and mayara
   already publishes `radars.{id}.controls.*` on its own — it is simply not bridged:
   this plugin's forwarder filters to `notifications.*`, and no PUT handlers are
   registered. The `radar/index.ts:812` note points away from the `streams/` module
   that already implements the binary transport.

3. **The plugin speaks two dialects.** `radar-provider.ts` feeds signalk-server's
   (array) API; `guiProxy` proxies mayara-server's (keyed) API for the embedded
   GUI. Even inside the plugin there are two shapes.

## Impact on clients

A spec-conforming client (e.g. `mayara_pi`) connecting to `/spokes` for the binary
image gets a 404 today and cannot tell the feature is merely at a different path —
the working binary endpoint is `/stream`. A client wanting control state/PUTs over
Signal K's `/signalk/v1/stream` finds no `radars.*` paths there (the plugin doesn't
bridge them). The list also omits `spokeDataUrl`. `mayara_pi` currently works around
the binary case by being dialect-tolerant — it parses both list shapes, uses
`spokeDataUrl` when present
and otherwise constructs the URL from the host per the spec, verifies the spoke
WebSocket actually opens, and falls back to connecting to mayara-server directly
when it does not.

## Chosen direction: converge the implementation onto the spec

Decision (2026-07-19): make signalk-server's **implementation match `radar_api.md`**
(which mayara-server already implements), rather than rewriting the spec to describe
the current rich/array code. This keeps the reference spec, mayara-server, and
`mayara_pi` on one shape; signalk-server is the component that moves.

This is a **breaking change to the exported `@signalk/server-api` `RadarProviderMethods`
contract** — every radar provider plugin (not just this one) must update, not only
signalk-server internals.

### What "match the spec" concretely means

It is **not** a field rename. The spec's list is _lean_ (discovery-only); the current
impl's list is _rich_ (state crammed into every entry). Converging means reverting the
`#2357` rich-list refactor's data model:

1. **List shape.** `GET /radars` returns `{ version, radars: Record<string, RadarInfo> }`
   (keyed object, wrapped) instead of a bare `RadarInfo[]`.
2. **`RadarInfo` goes lean.** `{ name, brand, model?, radarIpAddress, spokeDataUrl,
streamUrl }`. The fields dropped from the list — `status`, `range`, `controls`,
   `spokesPerRevolution`, `maxSpokeLength` — already have homes: `status`/`controls`
   at `/radars/{id}/state` and `/controls`, and `spokesPerRevolution`/`maxSpokeLength`
   at `/radars/{id}/capabilities`.
3. **Two stream URLs, both optional, different transports.** `spokeDataUrl` is the
   binary spoke WS; `streamUrl` is the **standard Signal K delta/PUT stream**
   (`/signalk/v1/stream`) carrying `radars.{id}.controls.*` and target data. The old
   type conflated them into one optional `streamUrl`; they are now split. Both are
   **optional**: absent means signalk-server serves it (spokes via the binary stream
   manager at `/spokes`; control via its own `/signalk/v1/stream`) and the client
   constructs the URL from the host. This is the key enabler for remote/containerised
   providers — clients reach the data through signalk-server with only its port
   exposed. Present means an external URL for direct connection.
4. **Two endpoints, two jobs — but only one is signalk-server work.** (a) **Binary
   `/spokes`** — move the existing binary forwarding from `/stream` to `/spokes` on
   the `src/api/streams/` upgrade listener and realign `asyncApi.ts`. A rename of a
   working transport, not new infrastructure. (b) **Control `/signalk/v1/stream`** —
   **no signalk-server endpoint is needed**: SK's v1 stream already does deltas (out)
   and PUTs (in), and mayara already models controls as `radars.{id}.controls.*` on
   its own v1 stream (observed 2026-07-20). The gap is purely the plugin-side bridge:
   widen `notification-forwarder.ts` (currently `notifications.*`-only) to also
   republish `radars.*` deltas, and register `app.registerPutHandler(...)` for
   `radars.<id>.controls.*` that forwards to mayara's control PUT. Also fix the stale
   `radar/index.ts:812` note to reference `/spokes` and `/signalk/v1/stream`.
5. **Field naming.** `maxSpokeLength` consistently (it leaves the list entirely and
   lives only in `/capabilities`, where it is already spelled `maxSpokeLength`, so the
   `maxSpokeLen` spelling disappears with the lean list).

### Consequence: `GET /radars` no longer shows status/range/controls

The central behavioural consequence. A client that renders a radar list with live
status today (one call) will, after convergence, need `GET /radars` for discovery
**plus** `GET /radars/{id}/state` per radar for status/range/controls. This is the
spec's intended separation (static discovery vs dynamic state vs capabilities), and it
is what mayara-server already does — the divergence doc's mayara list sample above is
exactly this lean shape — but it is a real regression in list convenience versus the
current rich array, and the reason the `#2357` refactor went the other way.

### Files touched (3 repos, breaking)

| #   | Repo / file                                                                         | Change                                                                                                                                                                                                                          | Status                                                  |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | `signalk-server` `packages/server-api/src/radarapi.ts` + `typebox/radar-schemas.ts` | Replace rich `RadarInfo` with the lean spec shape; add `RadarsResponse { version, radars }`; split into optional `spokeDataUrl` + `streamUrl`                                                                                   | **done** (branch `radar-lean-radarinfo-type`, unpushed) |
| 2   | `signalk-server` `src/api/radar/index.ts`                                           | `getRadars()` builds the keyed `{ version, radars }` object; stop cramming state into list entries                                                                                                                              | todo                                                    |
| 3   | `signalk-server` `src/api/radar/openApi.ts`                                         | Wrap the list response; it is already lean, so mostly response-envelope alignment                                                                                                                                               | todo                                                    |
| 4a  | `signalk-server` `src/api/streams/index.ts` + `src/api/radar/asyncApi.ts`           | Move the binary spoke forwarding from `/stream` to `/spokes` on the upgrade listener; realign `asyncApi.ts`; fix the stale `radar/index.ts:812` note                                                                            | todo                                                    |
| 4b  | **this plugin** `notification-forwarder.ts` (or a new forwarder)                    | Widen the mayara→SK forwarder to republish `radars.*` deltas, not just `notifications.*`, so radar state appears on SK's `/signalk/v1/stream`                                                                                   | todo                                                    |
| 4c  | **this plugin** `src/index.ts` + `radar-provider.ts`                                | Register `app.registerPutHandler` for `radars.<id>.controls.*` → forward to mayara control PUT (SK→mayara control-in)                                                                                                           | todo                                                    |
| 5   | **this plugin** `src/radar-provider.ts` + tests                                     | `getRadarInfo` returns the lean object (`name`/`brand`/`model?`/`radarIpAddress`); may omit `spokeDataUrl`/`streamUrl` so clients use signalk-server's forwarded endpoints; status/range/controls already covered by `getState` | todo                                                    |

Per this repo's PR discipline these are separate PRs, sequenced server-api →
signalk-server impl → plugin, because #1 breaks the type every consumer compiles
against. Only **4a** is signalk-server stream work (a small binary-path rename — the
transport already works). The control stream (**4b/4c**) is **entirely plugin-side**
over Signal K's existing v1 delta/PUT stream; signalk-server needs no new WebSocket
endpoint.

### Until convergence lands

Keep clients dialect-tolerant: parse both list shapes, use `spokeDataUrl` when present
and otherwise construct it from the host per the spec, and verify the spoke WebSocket
actually opens before relying on it (falling back to a direct mayara-server connection).
