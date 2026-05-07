# Agent guidance

This file is read by AI coding agents (Claude Code, Cursor, Codex, etc.) when working in this repo. `CLAUDE.md` re-references it.

## Project at a glance

`@marineyachtradar/signalk-plugin` — Signal K plugin that bridges the Signal K Radar API to a `mayara-server` instance (which speaks to actual marine radars). Two modes:

- **Container mode** (default): manages the mayara-server container via the [signalk-container](https://github.com/dirkwa/signalk-container) plugin's API.
- **External mode**: connects to a mayara-server running elsewhere (host/port).

The plugin itself is a thin proxy: it registers as a Radar API provider, forwards control commands over HTTP, and pipes binary spoke data via Signal K's `binaryStreamManager`. All radar protocol handling lives in mayara-server.

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

- **Plugin CI** (`.github/workflows/signalk-ci.yml`) calls the upstream `SignalK/signalk-server` reusable workflow. It runs on push to `main` and `workflow_dispatch` only — **there is no `pull_request` trigger**. To check CI on a PR branch, dispatch it manually: `gh workflow run signalk-ci.yml --ref <branch>`.
- **Publish** (`.github/workflows/publish.yml`) fires on `v*` tag push. It creates a GitHub Release with auto-generated notes (one line per PR since the previous tag), then `npm publish`es via OIDC trusted publishing.
- **No `NPM_TOKEN` secret exists or is needed.** Trusted publishing is configured on npm; do not add `NODE_AUTH_TOKEN` to the workflow.

## Plugin-specific gotchas

### Schema defaults are NOT injected at runtime

Signal K only uses the schema's `default` annotations to seed the JSON-schema form in the Admin UI. They are **not** materialised into the runtime config object passed to `plugin.start()`.

When the plugin is auto-enabled (`signalk-plugin-enabled-by-default: true`), `start()` is called with an empty `{}`. Without merging defaults, `settings.managedContainer` is `undefined`, the container-startup branch is silently skipped, and the plugin sits in an endless reconnect loop.

`src/config/schema.ts` exports `SCHEMA_DEFAULTS`; `start()` in `src/index.ts` spreads it under the incoming config. **Always preserve this merge** when modifying `start()`. Regression test in `test/container-integration.test.ts` ("starts the container even when start() is called with empty config") guards against this.

### Cross-plugin signalk-container API

The signalk-container plugin exposes its API on `globalThis.__signalk_containerManager`, not on the `app` object. Signal K passes each plugin a shallow copy of `app`, so properties added to it are not visible across plugins. `getContainerManager()` in `src/index.ts` is the typed accessor; always handle the `undefined` case (signalk-container may not have finished its own `start()` yet, or the user may have it disabled).

### Build artifacts in `plugin/`

`plugin/*.js` is in `.gitignore` but several files (`plugin/index.js`, `plugin/config/*`) are tracked from before the gitignore rule. When source changes, **rebuild and commit the corresponding `plugin/` artifact** alongside the source change so `git diff` stays honest. The `prepublishOnly` hook also rebuilds before npm publish, so the published tarball is always correct regardless.

### Container resource overrides

`src/index.ts` passes `DEFAULT_RESOURCES` to signalk-container's `ensureRunning`. Users can field-level-override any limit via signalk-container's plugin config (`containerOverrides["mayara-server"]`). When changing defaults, also update the README table at the bottom of the "Resource Limits" section.

## Dependencies

- Signal K Server ≥ 2.24.0 (Radar API requirement)
- signalk-container ≥ 0.1.6 (declared in `peerDependenciesMeta` as optional and in `signalk.requires`)
- Node ≥ engines floor in `package.json` (CI matrix tests Node 22 and 24)

When bumping the Node engines floor, update **all** of: `package.json` engines, `package.json` `@types/node`, `.github/dependabot.yml` comment, and the README prerequisites line.
