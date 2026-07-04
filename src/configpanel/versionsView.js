// Pure view-logic for the version dropdown, extracted from
// PluginConfigurationPanel.js so it can be unit-tested without a DOM.
// These functions decide what the panel shows from the /api/versions
// response; the component only wires them to state and JSX.

/**
 * Derive the versions list and the operator-facing error line from an
 * /api/versions response.
 *
 * @param {boolean} ok - res.ok
 * @param {*} body - parsed JSON body (the new {versions, sources} shape,
 *   or a legacy bare array for back-compat during a version skew)
 * @returns {{ versions: Array, versionsError: string }}
 */
export function deriveVersionsView(ok, body) {
  if (!ok) {
    // Both sources failed (502): the caller keeps its prior list; tell the
    // operator why rather than implying the dropdown is authoritative.
    return {
      versions: null, // null => caller preserves its existing list
      versionsError:
        "⚠ Could not reach GitHub — showing last known versions, retry",
    };
  }
  // Guard against a malformed 200 payload (null / non-object / no fields)
  // so reading .versions/.sources can't throw before the fallbacks apply.
  const obj = body && typeof body === "object" ? body : {};
  const list = Array.isArray(obj) ? obj : Array.isArray(obj.versions) ? obj.versions : [];
  const sources =
    !Array.isArray(obj) && obj.sources && typeof obj.sources === "object"
      ? obj.sources
      : {};
  let versionsError = "";
  if (sources.prImages === "rate-limited") {
    // The PR-images source specifically failed — name it, since a running
    // pr<N> vanishing from the list is the visible symptom operators hit.
    versionsError =
      "⚠ GitHub rate-limited — PR test images temporarily unavailable, retry shortly";
  } else if (sources.releases === "rate-limited") {
    versionsError =
      "⚠ GitHub rate-limited — some versions temporarily unavailable, retry shortly";
  } else if (sources.prImages === "error" || sources.releases === "error") {
    versionsError = "⚠ Could not fetch some versions from GitHub, retry";
  }
  return { versions: list, versionsError };
}

/**
 * Split the version list into the buckets the dropdown renders: PR test
 * images, the top 5 stable releases, and the top 3 pre-releases. The
 * single source of the slice limits — the panel's <optgroup> builder AND
 * shownTags both consume this, so the running-tag fallback can never
 * disagree with what is actually shown.
 */
export function splitVersions(versions) {
  const prVersions = versions.filter((v) => typeof v.pr === "number");
  const releaseVersions = versions.filter((v) => typeof v.pr !== "number");
  const stableVersions = releaseVersions.filter((v) => !v.prerelease).slice(0, 5);
  const preVersions = releaseVersions.filter((v) => v.prerelease).slice(0, 3);
  return { prVersions, stableVersions, preVersions };
}

/**
 * The set of tags the dropdown renders as real options. Used to decide
 * whether the running tag needs a synthetic fallback option.
 */
export function shownTags(versions) {
  const { prVersions, stableVersions, preVersions } = splitVersions(versions);
  return new Set([
    "latest",
    "main",
    ...preVersions.map((v) => v.tag),
    ...stableVersions.map((v) => v.tag),
    ...prVersions.map((v) => v.tag),
  ]);
}

/**
 * The running image's tag if it is NOT among the rendered options (so the
 * controlled <select> would otherwise render blank and silently reset the
 * operator's real running image), else null. Covers a pr<N> whose /pulls
 * fetch was rate-limited and a stable pin that fell out of the top-N.
 */
export function runningTagFallback(mayaraVersion, versions) {
  if (!mayaraVersion) return null;
  return shownTags(versions).has(mayaraVersion) ? null : mayaraVersion;
}
