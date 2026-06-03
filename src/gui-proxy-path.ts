/**
 * Rewrite a proxy path (already stripped of the `/gui` mount prefix by
 * Express' `router.use('/gui', guiProxy)`) so it reaches the right place on
 * mayara-server.
 *
 * mayara serves its GUI assets under `/gui/...` but its HTTP API under two
 * unprefixed roots:
 *   - `/signalk/...` — radars, controls, spokes, and the bare `/signalk`
 *     discovery probe the GUI uses for mode detection.
 *   - `/v2/...` — recordings and the debug panel (mayara-server serves these
 *     *without* a `/signalk` prefix; see its `web/recordings.rs` and
 *     `web/gui/debug-panel.js`).
 *
 * Both API roots must pass through untouched; only genuine static-asset
 * requests get the `/gui` prefix prepended for mayara's asset server.
 *
 * Without the `/v2/` passthrough, recordings/debug requests are mistaken for
 * assets and 404 behind the Signal K proxy — even though they work in the
 * standalone-direct GUI, where no proxy is involved.
 */
export function rewriteGuiProxyPath(path: string): string {
  if (path === '/signalk' || path.startsWith('/signalk/')) {
    return path
  }
  if (path.startsWith('/v2/')) {
    return path
  }
  return `/gui${path}`
}
