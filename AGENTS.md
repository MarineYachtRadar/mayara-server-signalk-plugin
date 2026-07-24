# Agent guidance

This file is read by AI coding agents (Claude Code, Cursor, Codex, etc.) when working in this repo. `CLAUDE.md` re-references it.

## Project at a glance

`@marineyachtradar/signalk-plugin` — Signal K plugin that bridges the Signal K Radar API to a `mayara-server` instance (which speaks to actual marine radars). Two modes:

- **Container mode** (default): manages the mayara-server container via the [signalk-container](https://github.com/dirkwa/signalk-container) plugin's API.
- **External mode**: connects to a mayara-server running elsewhere (host/port).

The plugin is a **thin proxy**: it registers as a Radar API provider, forwards control commands over HTTP, and pipes binary spoke data via Signal K's `binaryStreamManager`. **All radar protocol handling — discovery, model detection, ranges, status, ARPA — lives in mayara-server.** When something is missing or wrong at the radar level, the fix usually belongs in mayara-server, not here; the plugin's job is to pass mayara's view through faithfully (see "Radar status model" below).

### Module map (`src/`)

- `index.ts` — plugin lifecycle (`start` / `stop` / `asyncStart`), Express routes (`/status`, `/api/*`, GUI proxy), managed-container orchestration, radar discovery polling, and the Signal K token flow. The big file; everything is wired here.
- `mayara-client.ts` — HTTP(S) client for mayara's `/signalk/v2/api/vessels/self/radars/*` (list, capabilities, controls, targets). No protocol logic, just request plumbing.
- `radar-provider.ts` — implements `radar.RadarProviderMethods`, registered with the server via `app.radarApi.register(PLUGIN_ID, …)`. Translates Radar API calls into `MayaraClient` requests.
- `spoke-forwarder.ts` — one per radar; a WebSocket client that pipes mayara's binary spoke stream into `app.binaryStreamManager.emitData('radars/<id>', buf)`. Reconnects with backoff.
- `notification-forwarder.ts` — subscribes to `notifications.*` on mayara's Signal K **v1** stream and republishes the deltas upstream via `app.handleMessage()` (e.g. guard-zone alarms). Filters out non-notification paths.
- `gui-proxy-path.ts` — the pure `rewriteGuiProxyPath` used by the GUI reverse proxy: `/signalk…` and `/v2…` pass straight through to mayara, everything else gets `/gui` prepended for the static asset server.
- `signalk-token.ts` — the device-access-request flow (POST request, poll for approval, validate) plus token-cache file helpers.
- `config/schema.ts` — `ConfigSchema` (the Admin-UI form) and `SCHEMA_DEFAULTS` (the runtime default merge — see the gotcha below).
- `types.ts` — typed local mirrors of the cross-plugin APIs (signalk-container's `ContainerManagerApi`, the SK server surface the plugin uses).

Each module has a matching `test/*.test.ts`; `test/container-integration.test.ts` carries the lifecycle/regression guards.

## Radar status model (design intent)

This section is **design guidance**, not a description of finished code. Most of it is implemented in [mayara-server](https://github.com/MarineYachtRadar/mayara-server) (Rust), not in this plugin — but it lives here because this is where the architecture gets brainstormed, and because the plugin must not undo the model on the way through. File:line references below point into the mayara-server tree unless they start with `src/` of this repo.

### Principle: surface a radar early, never silently drop it

A radar should appear on `/radars` as soon as it is **discovered**, not only once its model is recognised and its ranges have arrived. Today mayara's `get_active()` (`src/lib/radar/mod.rs:750-759`) filters on `ranges.len() > 0`, so a radar whose model ID isn't recognised — or whose capability report hasn't landed yet — **vanishes** from `/radars` even though `/radars/<id>` still responds. Users report this as "the radar answers on `/radars/xxxx` but isn't in the list." The cure is not to special-case the vanish (the old "IP address missing" surfacing, mayara PR #334, was a kludge for one instance of this) but to **report the radar with a status that explains why it isn't fully usable yet.**

### Two orthogonal axes — do not conflate them

A radar carries **two independent pieces of state.** Modelling them as one field is the mistake to avoid.

**1. Lifecycle / health status.** What the radar _is_. Proposed shape (exact `Error` variants left open — they'll grow as hardware faults are decoded):

```text
Initializing { Locating, ModelDetecting } | Available | Error { HardwareError, SetupError, … }
```

Every non-`Available` state **carries a human-readable English explanation** that the GUI can show directly — few users read the error log, so the _why_ has to ride along with the status. Anchor the design in cases already in the code:

- Raymarine self-test fault `0x0A` (`src/lib/brand/raymarine/report/quantum.rs`, mayara PR #335) → `Error { HardwareError }`, text along the lines of "self-test failure; no image will appear until it clears."
- Model not recognised / ranges not yet arrived → `Initializing { ModelDetecting }`, **not** a disappearance.

Kees has already catalogued ~20 distinct Navico hardware-error codes, so `Error` is expected to fan out.

**2. Idle.** Whether _anyone is watching_. A radar is **idle** when it is powered but **no one is subscribed** to its data stream — there's no point spending CPU decoding spokes nobody consumes. Idle is **not** an error and must never be reported as one — it's a pure efficiency signal: mayara already drains the spoke socket but skips frame decode and blob detection while idle, saving ~1.5 cores on Furuno radars that spew spokes even in standby (issue #274). Idle composes with status on the orthogonal axis: an `Available` radar can be idle; an `Error` radar's idleness is irrelevant.

The current predicate is narrow — `should_idle(power, receiver_count) = standby && receiver_count == 0` (`src/lib/radar/mod.rs:973`) — so today only a _standby_ radar with no viewers idles. The intent reaches further: a radar an MFD has put into **transmit** while nothing is subscribed to mayara is equally pointless to decode. Widening idle to cover the transmit-but-unwatched case is on the table, but only once the subscriber count is honest about ARPA (next two points) — otherwise widening it would make the bug below bite harder.

### ARPA counts as a subscriber

A radar with an **active ARPA / MARPA tracker is not idle**, even if no GUI is open. ARPA is a legitimate consumer of the spoke stream — if it's tracking targets, somebody (the autopilot, a guard zone, a plotter) cares about that radar. Do not treat "no WebSocket viewers" as "nobody is watching."

### ⚠️ ARPA / idle gotcha — be careful here

Idle is currently computed **only** from `message_tx.receiver_count()`, the spoke-broadcast WebSocket subscriber count (`src/lib/radar/mod.rs:464-471`). But **ARPA does not subscribe to that broadcast** — it receives pre-detected blobs over a _separate_ mpsc channel (`src/lib/radar/mod.rs:1743-1774`, fed into `src/lib/radar/target/manager.rs`). And the idle flag is exactly what **skips blob detection**.

⇒ If ARPA is tracking targets while no GUI is connected, `receiver_count == 0` → the radar idles → blob detection stops → **ARPA silently dies.** Any idle predicate must fold in an active-tracker count (or equivalent "ARPA is running" signal) so an ARPA-tracked radar stays awake. This is the "code will need to be careful around that" case — get it wrong and ARPA breaks invisibly whenever the last viewer closes the GUI.

### Plugin-side rule: pass status through, don't flatten it

The plugin is a thin proxy, and today it **throws away** anything richer than power state. `radar-provider.ts` derives `status` solely from the `power` control (`transmit` / `standby` / `off`, `src/radar-provider.ts:33-34` and `src/radar-provider.ts:79-80`), and `getRadars()` just returns `Object.keys()` of mayara's response (`src/radar-provider.ts:12-20`). So a `status` / `idle` / `explanation` that mayara adds to its `/radars` JSON (`RadarApiV3` in `src/bin/mayara-server/web/signalk/v2.rs:177-205`) would be **dropped on the floor here.**

When mayara grows the status model, this plugin must **forward the new fields verbatim** into the Radar API `RadarInfo` / `RadarState` it returns (including the English explanation) rather than re-deriving a lesser status from `power`. The point of surfacing status early is lost if the proxy collapses it back to three power states.

## Commands

- `npm run format` — prettier + eslint --fix
- `npm run lint` — eslint check (no fixes)
- `npm run build` — tsc → `plugin/`, then webpack the React config panel
- `npm run test` — vitest
- `npm run build:all` — lint + build + test (run this before every commit)

## Pull request workflow

**One logical change per PR.** Refactors, behavior changes, doc updates, and dependency bumps belong in separate PRs. If a single change would produce two distinct lines in the auto-generated GitHub Release notes, it should be two PRs.

A bundled PR that "while I was in here, I also fixed X" is **not** acceptable — even if X is small. Open a second PR for X.

This rule exists because:

1. The publish workflow generates GitHub Release notes from PR titles. Bundled PRs produce a single line that hides the smaller change.
2. Reverts and bisects are easier when each PR is one thing.
3. Reviewers can reason about each change in isolation.

If you're tempted to bundle, the right move is to open the second PR off the merge of the first — the small extra round-trip is worth it.

### Version bumps

The `chore(release): X.Y.Z` commit is its **own** PR. Don't include a version bump in a feature or fix PR. The release PR can include the README/CHANGELOG-style summary that documents what's shipping.

Workflow:

1. Open and merge feature/fix PRs (no version bump in any of them).
2. Open a separate `release-X.Y.Z` branch with only `package.json` (and `plugin/` build output) bumped, with a `chore(release): X.Y.Z` commit.
3. Merge that PR.
4. Tag `vX.Y.Z` from `main` and push the tag — this triggers `publish.yml`.

### Branch naming

- No `/` in branch names (Signal K maintainers' convention). Use hyphens: `fix-container-startup`, not `fix/container-startup`.

### Commit messages

Angular conventional commits: `<type>(<scope>): <subject>` (`feat`, `fix`, `chore`, `docs`, `ci`, `test`, `refactor`). Subject in imperative mood ("add" not "added"), no trailing period.

For non-trivial changes, add a body explaining the **why**. Don't restate what the diff already shows.

No `Co-Authored-By` lines. No "Generated with Claude Code" attribution.

### PR descriptions

`## Summary` (bullets, why-not-what) and `## Tested` (only what was actually verified — no speculative test plans, no checkbox lists). Keep it tight.

## CI / publishing

- **Plugin CI** (`.github/workflows/signalk-ci.yml`) calls the upstream `SignalK/signalk-server` reusable workflow. It runs on push to `main`, on pull_request to `main`, and on `workflow_dispatch`. PR runs surface as checks on the PR itself; the push-to-main run still covers post-merge verification.
- **Publish** (`.github/workflows/publish.yml`) fires on `v*` tag push. It creates a GitHub Release with auto-generated notes (one line per PR since the previous tag), then `npm publish`es via OIDC trusted publishing.
- **No `NPM_TOKEN` secret exists or is needed.** Trusted publishing is configured on npm; do not add `NODE_AUTH_TOKEN` to the workflow.

## Plugin-specific gotchas

### Schema defaults are NOT injected at runtime

Signal K only uses the schema's `default` annotations to seed the JSON-schema form in the Admin UI. They are **not** materialised into the runtime config object passed to `plugin.start()`.

When the plugin is auto-enabled (`signalk-plugin-enabled-by-default: true`), `start()` is called with an empty `{}`. Without merging defaults, `settings.managedContainer` is `undefined`, the container-startup branch is silently skipped, and the plugin sits in an endless reconnect loop.

`src/config/schema.ts` exports `SCHEMA_DEFAULTS`; `start()` in `src/index.ts` spreads it under the incoming config. **Always preserve this merge** when modifying `start()`. Regression test in `test/container-integration.test.ts` ("starts the container even when start() is called with empty config") guards against this.

### Cross-plugin signalk-container API

The signalk-container plugin exposes its API on `globalThis.__signalk_containerManager`, not on the `app` object. Signal K passes each plugin a shallow copy of `app`, so properties added to it are not visible across plugins. `getContainerManager()` in `src/index.ts` is the typed accessor; always handle the `undefined` case (signalk-container may not have finished its own `start()` yet, or the user may have it disabled).

`waitForContainerManager()` first polls for the global to appear (signalk-container's `start()` may run after mayara's on a cold boot), then awaits `containers.whenReady()` (1.6.0+) to let runtime detection settle. After the await, re-check `getRuntime()` — `whenReady()` resolves on success OR failure of detection.

### Container config-change detection is centralized

signalk-container ≥1.6.0 diffs the requested `ContainerConfig` against the live container in `ensureRunning` and recreates transparently on drift across `image+tag`, `command`, `networkMode`, `env`, `volumes`, and `ports`. Resources still follow the live-update path. Mayara does **not** maintain a local `.container-hash` file — call `ensureRunning` with the same config every start and let signalk-container handle drift. A static guard in `test/container-integration.test.ts` ("src/index.ts does not import fs") catches accidental re-introduction of the old hash pattern.

`buildContainerConfig` also sets `autoUpdateOnFloatingTag: true` (requires signalk-container ≥1.9.0). When `mayaraVersion` resolves to a floating tag (`latest`, `main`, `edge`, `nightly`, etc.), signalk-container pulls on every `ensureRunning`, compares the registry digest to the live container's image, and recreates on drift. Without this, a boat that started on `:latest` keeps the cached image forever. Offline tolerance (`ENOTFOUND`, `ENETUNREACH`, `ETIMEDOUT`, …) is provided by signalk-container — the cached container keeps running and the check is silently skipped, so boats out of cell coverage still boot. Semver pins (e.g. `0.4.2`) are classified non-floating and skip the probe entirely, so the field is a no-op for pinned deployments. Test guard: "opts into floating-tag auto-update in buildContainerConfig" in `test/container-integration.test.ts`.

### Signal K device-token flow

When Signal K security is enabled, the managed mayara container needs an authenticated upstream channel so the AIS overlay can seed itself from `/signalk/v1/api/vessels/` (without it, the overlay only fills from live deltas, ~5–60 s per vessel). The plugin drives the standard SK device-access-request flow rather than asking the operator to mint and paste a token.

The flow lives in `src/signalk-token.ts` + `ensureSignalkToken()` in `src/index.ts`:

1. On start, POST `/signalk/v1/access/requests` with `clientId = mayara-server-signalk-plugin` and `permissions: 'readwrite'`. The broad scope is deliberate — SK admin UI cannot widen permissions post-approval, only revoke + re-request, and mayara's roadmap includes pushing radar targets / MARPA tracks / notifications back to Signal K.
2. Until the admin approves in **Security → Access Requests**, the container runs with `-n tcp:127.0.0.1:${TCPSTREAMPORT}` so nav deltas still flow.
3. On approval, `awaitApproval()` extracts the JWT, caches it to `${app.getDataDirPath()}/signalk-token` (mode `0600`, host-only), and recreates the container with `-n ws:127.0.0.1:${PORT}` plus `env.MAYARA_SIGNALK_TOKEN = <token>`. The token is delivered via env, not a bind-mounted file, because on docker / rootful podman signalk-container emits `--user 1000:1000` (the mayara image's USER) — and a 0600 file on the host owned by the SK process user would be unreadable from inside the container at that UID. Env vars cross the UID boundary unconditionally and `mayara-server` already accepts `MAYARA_SIGNALK_TOKEN` as an alternative to `--signalk-token-file` (see `mayara-server/src/lib/mod.rs:214-257`).
4. The flow is **resilient without a plugin restart**. On every start the cached token is validated against SK (`validateCachedToken()`) before reuse; a token that's been revoked, denied, or expired is discarded and a fresh request is issued automatically (`ensureSignalkTokenWithRecovery()` retries on the reconnect interval, and `connectAndDiscover()` re-enters the flow on a revocation mid-run). A monotonic `tokenGeneration` counter, captured at launch and compared on each step, cancels a stale recovery loop when `stop()`/`start()` cycles — so a recovery loop never outlives the plugin instance that started it. The duplicate-request guard treats an existing `PENDING` request as "already pending" rather than POSTing a second one on a fast restart.
5. `requestSignalkToken: false` in plugin config opts out entirely (manual `--signalk-token <token>` or `--signalk-token-file <path>` in `mayaraArgs` remains an escape hatch — and if the user passes `-n` in `mayaraArgs`, the plugin neither injects its default nor sets the token env, leaving the operator's config untouched).

Token-flow tests live in `test/signalk-token.test.ts` (module-level: cache helpers, POST branches, polling) and `test/container-integration.test.ts` (integration: opt-in/out, lifecycle, recreate-on-approval). The token module is mocked by default in container-integration tests so they don't issue stray HTTP requests against a non-existent local SK; token-flow tests override per-test via `vi.mocked()`. The `tokenGeneration` counter (bumped in `start()`/`stop()`, captured in `isCancelled()`) keeps a recovery loop from outliving the plugin instance that started it.

### Container user UID mapping

The mayara image declares `USER mayara` with UID/GID 1000. `buildContainerConfig` in `src/index.ts` declares `user: { inImageUid: 1000, inImageGid: 1000 }` so signalk-container emits the right uid-mapping flag — `--userns=keep-id:uid=1000,gid=1000` on rootless podman, `--user 1000:1000` on docker / rootful podman (signalk-container ≥ the version that honors `inImageUid` on the docker/rootful branch).

Without this, signalk-container defaults `inImageUid` to 0. On rootless podman the keep-id mapping puts the in-image UID 1000 at host UID `100999` (the subuid range); on docker / rootful podman the process runs as the SK host user's UID. Either way `/home/mayara/.local/share` (owned by uid 1000 inside the image) is unwritable and mayara fails to start.

The token is delivered via the `MAYARA_SIGNALK_TOKEN` env var, not as a bind-mounted file, precisely so the in-container UID can differ from the host SK UID without breaking the upstream Signal K channel. See "Signal K device-token flow" above.

Test guard: "declares the mayara image in-image UID/GID for correct uid mapping" in `test/container-integration.test.ts`. Don't remove the `user` field from `buildContainerConfig`; doing so silently regresses to whichever UID story the user's runtime defaults to.

### Build artifacts in `plugin/`

`plugin/*.js` is in `.gitignore` but several files (`plugin/index.js`, `plugin/config/*`) are tracked from before the gitignore rule. When source changes, **rebuild and commit the corresponding `plugin/` artifact** alongside the source change so `git diff` stays honest. The `prepublishOnly` hook also rebuilds before npm publish, so the published tarball is always correct regardless.

### Container resource overrides

`src/index.ts` passes `DEFAULT_RESOURCES` to signalk-container's `ensureRunning`. Users can field-level-override any limit via signalk-container's plugin config (`containerOverrides["mayara-server"]`). When changing defaults, also update the README table at the bottom of the "Resource Limits" section.

### GUI proxy WebSocket forwarding

The mayara GUI is proxied through Signal K at `/plugins/<id>/gui/` so only the SK port needs to be open. The GUI's REST calls go through Express' `router.use('/gui', guiProxy)`, but its radar/state/spoke **WebSocket** upgrades fire at the Node HTTP-server level, so `registerWithRouter` installs a manual `upgrade` listener on `req.socket.server`. Two non-obvious traps live here:

- **Match the server on `net.Server`, not `http.Server`.** With SSL enabled, Signal K's listener is an `https.Server`, which extends `tls.Server`/`net.Server` — **not** `http.Server`. An `instanceof http.Server` check silently fails under HTTPS, the listener is never installed, and every `wss://` upgrade hangs (radar display stuck on "Disconnected"). HTTP works, HTTPS doesn't — a classic SSL-only regression.
- **Keep `ws: false` on `createProxyMiddleware`.** With `ws: true`, the middleware auto-subscribes its _own_ upgrade handler to the server and the manual `guiProxy.upgrade()` call becomes a no-op (it guards on `wsInternalSubscribed`). The auto-handler sees the raw `/plugins/<id>/gui/signalk/...` URL, which `pathRewrite` can't strip the mount prefix from, so the upgrade reaches mayara at a bogus `/gui/...` path and 404s. The manual listener strips the prefix first, so it must be the one that runs.

`pathRewrite` (extracted as the exported pure `rewriteGuiProxyPath`) passes both of mayara's API roots straight through — `/signalk/...` (including the bare `/signalk` discovery path the GUI probes for mode detection) and `/v2/...` (recordings + the debug panel, which mayara serves _without_ a `/signalk` prefix). Everything else gets `/gui` prepended for the static asset server. The `/v2/` passthrough matters: without it, recordings/debug requests are mistaken for assets and 404 behind the Signal K proxy, even though they work in the standalone-direct GUI (no proxy involved). Unit-tested in `test/gui-proxy-path.test.ts`.

## Dependencies

- Signal K Server ≥ 2.31.0 (v3.4.0 Radar API requirement; the lean `RadarInfo` and the `{ version, radars }` list land in 2.31.0)
- signalk-container ≥ 1.6.0 (declared in `signalk.requires`; intentionally **not** an npm `peerDependency`. It's a cross-plugin runtime dependency discovered at runtime via `globalThis.__signalk_containerManager` and installed through Signal K's appstore, not something npm should resolve. Declaring it as a peer made npm enforce the version range, which broke `@beta`/prerelease installs with ERESOLVE because npm excludes prereleases from plain `>=` ranges.)
- Node ≥ engines floor in `package.json` (CI matrix tests Node 22 and 24)

When bumping the Node engines floor, update **all** of: `package.json` engines, `package.json` `@types/node`, `.github/dependabot.yml` comment, and the README prerequisites line.
