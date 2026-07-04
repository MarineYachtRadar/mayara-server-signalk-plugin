// Type declarations for the plain-JS version-view helpers so the
// TypeScript unit tests (and any TS consumer) get real types. The
// implementation stays .js because the webpack config panel build uses
// babel-loader and only resolves .js/.jsx.

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

export function deriveVersionsView(ok: boolean, body: unknown): VersionsView

export function splitVersions(versions: VersionEntry[]): {
  prVersions: VersionEntry[]
  stableVersions: VersionEntry[]
  preVersions: VersionEntry[]
}

export function shownTags(versions: VersionEntry[]): Set<string>

export function runningTagFallback(
  mayaraVersion: string | undefined | null,
  versions: VersionEntry[]
): string | null
