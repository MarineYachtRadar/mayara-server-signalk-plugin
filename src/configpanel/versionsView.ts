// Pure view-logic for the version dropdown, extracted from
// PluginConfigurationPanel.tsx so it can be unit-tested without a DOM.
// These functions decide what the panel shows from the /api/versions
// response; the component only wires them to state and JSX.

export interface VersionEntry {
  tag: string
  prerelease?: boolean
  pr?: number
  title?: string
}

export interface VersionsView {
  /** The list to show, or null to signal "keep the caller's prior list". */
  versions: VersionEntry[] | null
  /** Operator-facing error line, '' when there is nothing to report. */
  versionsError: string
}

/** The per-source status map `/api/versions` reports alongside the list. */
type SourceStatus = 'ok' | 'rate-limited' | 'error'

/**
 * Derive the versions list and the operator-facing error line from an
 * /api/versions response.
 *
 * @param ok - res.ok
 * @param body - parsed JSON body (the new {versions, sources} shape, or a
 *   legacy bare array for back-compat during a version skew)
 */
export function deriveVersionsView(ok: boolean, body: unknown): VersionsView {
  if (!ok) {
    // Both sources failed (502): the caller keeps its prior list; tell the
    // operator why rather than implying the dropdown is authoritative.
    return {
      versions: null, // null => caller preserves its existing list
      versionsError: '⚠ Could not reach GitHub — showing last known versions, retry'
    }
  }
  // Guard against a malformed 200 payload (null / non-object / no fields)
  // so reading .versions/.sources can't throw before the fallbacks apply.
  const obj: unknown = body && typeof body === 'object' ? body : {}
  const record = obj as { versions?: unknown; sources?: unknown }
  const rawList: unknown[] = Array.isArray(obj)
    ? obj
    : Array.isArray(record.versions)
      ? record.versions
      : []
  // Drop anything without a usable `tag`: every consumer keys off it (the
  // <option value>, the shownTags set, the running-tag fallback), so an entry
  // missing it would render a blank option that silently resets the select.
  const list: VersionEntry[] = rawList.reduce<VersionEntry[]>((acc, entry) => {
    if (!entry || typeof entry !== 'object') return acc
    const e = entry as Record<string, unknown>
    if (typeof e.tag !== 'string') return acc
    // A blank or whitespace-only tag is as unusable as a missing one: it would
    // render an empty <option> and could be saved as the image tag.
    const tag = e.tag.trim()
    if (tag === '') return acc
    acc.push({
      tag,
      ...(typeof e.prerelease === 'boolean' ? { prerelease: e.prerelease } : {}),
      ...(typeof e.pr === 'number' ? { pr: e.pr } : {}),
      ...(typeof e.title === 'string' ? { title: e.title } : {})
    })
    return acc
  }, [])
  // Only the three documented statuses are honoured; anything else is treated
  // as "not reported" rather than being compared against below.
  const rawSources: Record<string, unknown> =
    !Array.isArray(obj) && record.sources && typeof record.sources === 'object'
      ? (record.sources as Record<string, unknown>)
      : {}
  const isStatus = (v: unknown): v is SourceStatus =>
    v === 'ok' || v === 'rate-limited' || v === 'error'
  const sources: Partial<Record<'prImages' | 'releases', SourceStatus>> = {
    ...(isStatus(rawSources.prImages) ? { prImages: rawSources.prImages } : {}),
    ...(isStatus(rawSources.releases) ? { releases: rawSources.releases } : {})
  }
  let versionsError = ''
  if (sources.prImages === 'rate-limited') {
    // The PR-images source specifically failed — name it, since a running
    // pr<N> vanishing from the list is the visible symptom operators hit.
    versionsError = '⚠ GitHub rate-limited — PR test images temporarily unavailable, retry shortly'
  } else if (sources.releases === 'rate-limited') {
    versionsError = '⚠ GitHub rate-limited — some versions temporarily unavailable, retry shortly'
  } else if (sources.prImages === 'error' || sources.releases === 'error') {
    versionsError = '⚠ Could not fetch some versions from GitHub, retry'
  }
  return { versions: list, versionsError }
}

/**
 * Split the version list into the buckets the dropdown renders: PR test
 * images, the top 5 stable releases, and the top 3 pre-releases. The
 * single source of the slice limits — the panel's <optgroup> builder AND
 * shownTags both consume this, so the running-tag fallback can never
 * disagree with what is actually shown.
 */
export function splitVersions(versions: VersionEntry[]): {
  prVersions: VersionEntry[]
  stableVersions: VersionEntry[]
  preVersions: VersionEntry[]
} {
  const prVersions = versions.filter((v) => typeof v.pr === 'number')
  const releaseVersions = versions.filter((v) => typeof v.pr !== 'number')
  const stableVersions = releaseVersions.filter((v) => !v.prerelease).slice(0, 5)
  const preVersions = releaseVersions.filter((v) => v.prerelease).slice(0, 3)
  return { prVersions, stableVersions, preVersions }
}

/**
 * The set of tags the dropdown renders as real options. Used to decide
 * whether the running tag needs a synthetic fallback option.
 */
export function shownTags(versions: VersionEntry[]): Set<string> {
  const { prVersions, stableVersions, preVersions } = splitVersions(versions)
  return new Set([
    'latest',
    'main',
    ...preVersions.map((v) => v.tag),
    ...stableVersions.map((v) => v.tag),
    ...prVersions.map((v) => v.tag)
  ])
}

/**
 * The running image's tag if it is NOT among the rendered options (so the
 * controlled <select> would otherwise render blank and silently reset the
 * operator's real running image), else null. Covers a pr<N> whose /pulls
 * fetch was rate-limited and a stable pin that fell out of the top-N.
 */
export function runningTagFallback(
  mayaraVersion: string | undefined | null,
  versions: VersionEntry[]
): string | null {
  if (!mayaraVersion) return null
  return shownTags(versions).has(mayaraVersion) ? null : mayaraVersion
}
