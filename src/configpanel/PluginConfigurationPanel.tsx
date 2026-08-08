import React, { useState, useEffect, useCallback } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { deriveVersionsView, runningTagFallback, splitVersions } from './versionsView.js'
import type { VersionEntry } from './versionsView.js'

/** The plugin configuration this panel edits. Mirrors src/config/schema.ts. */
interface PanelConfig {
  managedContainer?: boolean
  mayaraVersion?: string
  mayaraArgs?: string[]
  host?: string
  port?: number
  secure?: boolean
  discoveryPollInterval?: number
  reconnectInterval?: number
}

/** Props the Signal K Admin UI passes to a federated config panel. */
interface PluginConfigurationPanelProps {
  configuration?: PanelConfig
  save: (configuration: PanelConfig) => void
}

/** The subset of GET /status this panel renders. */
interface PluginStatus {
  connected: boolean
  radars: string[]
  spokeForwarders?: Array<{ radarId: string; connected: boolean }>
  container?: { state?: string; image?: string }
}

/** signalk-container's UpdateCheckResult, as returned by /api/update/check. */
interface UpdateCheckResult {
  runningTag?: string
  tagKind?: string
  currentVersion?: string | null
  latestVersion?: string | null
  updateAvailable?: boolean
  reason?: string
  fromCache?: boolean
  lastSuccessfulCheckAt?: string | null
  error?: string
}

const S = {
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#333',
    padding: '16px 0'
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 10,
    marginTop: 24
  },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer'
  },
  btnPrimary: { background: '#3b82f6', color: '#fff' },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  status: { marginTop: 8, fontSize: 12, minHeight: 18 },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '14px 18px',
    background: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: 10,
    marginBottom: 12
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 20,
    fontWeight: 700,
    flexShrink: 0
  },
  cardInfo: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: 600, color: '#333' },
  cardMeta: { fontSize: 12, color: '#888' },
  stateIndicator: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    flexShrink: 0
  },
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 10
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: '#555',
    width: 180,
    flexShrink: 0
  },
  select: {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    fontSize: 13,
    background: '#fff',
    color: '#333',
    minWidth: 200
  },
  input: {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    fontSize: 13,
    background: '#fff',
    color: '#333',
    width: 200
  },
  inputSmall: {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    fontSize: 13,
    background: '#fff',
    color: '#333',
    width: 80
  },
  checkbox: { width: 16, height: 16, accentColor: '#3b82f6' },
  hint: { fontSize: 11, color: '#aaa', marginLeft: 8 },
  empty: {
    textAlign: 'center',
    padding: '30px 16px',
    color: '#999',
    fontSize: 13
  },
  tag: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 600,
    marginLeft: 8
  },
  tagPre: { background: '#fef3c7', color: '#92400e' },
  tagLatest: { background: '#dcfce7', color: '#166534' },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 10,
    marginBottom: 12
  },
  statCard: {
    padding: '12px 16px',
    background: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: 10,
    textAlign: 'center'
  },
  statValue: { fontSize: 22, fontWeight: 700, color: '#333' },
  statLabel: { fontSize: 11, color: '#888', marginTop: 2 }
  // `satisfies`, not an annotation: `Record<string, CSSProperties>` erases the
  // literal keys, so a typo like `S.cardTtile` would silently type as
  // CSSProperties and render an unstyled element instead of failing the build.
} satisfies Record<string, CSSProperties>

/**
 * Format an UpdateCheckResult from signalk-container's update service
 * into a human-readable status line.
 */
function formatUpdateMessage(result: UpdateCheckResult | null | undefined): string {
  const {
    runningTag,
    tagKind,
    currentVersion,
    latestVersion,
    updateAvailable,
    reason,
    fromCache,
    lastSuccessfulCheckAt
  } = result || {}

  if (reason === 'offline') {
    if (fromCache && lastSuccessfulCheckAt) {
      const ago = formatTimeAgo(lastSuccessfulCheckAt)
      return `Offline — last checked ${ago}: ${updateAvailable ? 'update available' : 'up to date'}`
    }
    return 'Offline — never checked yet'
  }

  if (reason === 'newer-version') {
    return `Update available: ${currentVersion} \u2192 ${latestVersion}`
  }

  if (reason === 'digest-drift') {
    const stableNote = latestVersion ? ` (latest stable: ${latestVersion})` : ''
    return `Image rebuild available for :${runningTag}${stableNote}`
  }

  if (reason === 'up-to-date') {
    if (tagKind === 'floating' && latestVersion) {
      return `Up to date with :${runningTag} (latest stable: ${latestVersion})`
    }
    return `Up to date (${currentVersion || runningTag})`
  }

  if (reason === 'older-than-pinned') {
    return `Pinned to ${currentVersion}; latest stable is ${latestVersion}`
  }

  if (reason === 'error') {
    return `Check error: ${result?.error || 'unknown'}`
  }

  return `State: ${reason || 'unknown'}`
}

/** A caught value is `unknown` under strict TS; render it safely. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `Response.json()` is typed `Promise<any>`, which silently spreads `any`
 * through every value derived from a response. Funnel reads through this so
 * the payload arrives as `unknown` and each caller has to narrow it.
 */
async function readJson(res: Response): Promise<unknown> {
  return (await res.json()) as unknown
}

/** Narrow an unknown payload to a plain object without asserting its shape. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/**
 * The tag of an image reference, or null when it carries none.
 *
 * Splitting on the *first* colon breaks on a registry that includes a port —
 * `registry:5000/mayara:latest` would yield `5000/mayara`. The tag is the
 * segment after the last colon, and only if no `/` follows it (otherwise that
 * colon belonged to the registry host).
 */
function imageTag(image: string): string | null {
  const colon = image.lastIndexOf(':')
  if (colon === -1) return null
  const tag = image.slice(colon + 1)
  return tag === '' || tag.includes('/') ? null : tag
}

/**
 * Decode an UpdateCheckResult. Every field is optional on the wire, so each is
 * kept only when it has the expected type — otherwise a server sending, say, an
 * object for `error` would render "Check failed: [object Object]".
 */
function toUpdateCheckResult(value: unknown): UpdateCheckResult {
  const o = asRecord(value)
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return {
    runningTag: str(o.runningTag),
    tagKind: str(o.tagKind),
    currentVersion: str(o.currentVersion) ?? null,
    latestVersion: str(o.latestVersion) ?? null,
    updateAvailable: o.updateAvailable === true,
    reason: str(o.reason),
    fromCache: o.fromCache === true,
    lastSuccessfulCheckAt: str(o.lastSuccessfulCheckAt) ?? null,
    error: str(o.error)
  }
}

/**
 * `/status` drives the whole connection panel, so a malformed body must not
 * reach render — `radars.length` on a missing array would throw. Anything
 * that isn't the expected shape degrades to "disconnected".
 */
function toPluginStatus(value: unknown): PluginStatus {
  const obj = asRecord(value)
  if (!Array.isArray(obj.radars)) return { connected: false, radars: [] }

  // Nested fields are validated too, not just the top level: `container.image`
  // is string-split to derive the running tag, and each forwarder is matched
  // against a radar id, so a wrong type there would surface as a render-time
  // crash rather than a missing badge.
  const container = asRecord(obj.container)
  const state = typeof container.state === 'string' ? container.state : undefined
  const image = typeof container.image === 'string' ? container.image : undefined

  return {
    connected: obj.connected === true,
    radars: obj.radars.filter((r): r is string => typeof r === 'string'),
    spokeForwarders: Array.isArray(obj.spokeForwarders)
      ? obj.spokeForwarders
          .map(asRecord)
          .filter(
            (f): f is { radarId: string; connected: boolean } =>
              typeof f.radarId === 'string' && typeof f.connected === 'boolean'
          )
      : undefined,
    container: state === undefined && image === undefined ? undefined : { state, image }
  }
}

function formatTimeAgo(isoTimestamp: string): string {
  // An unparseable date does NOT throw — `new Date('nonsense').getTime()` is
  // NaN, which then flows through every branch below and renders "NaNd ago".
  // Test the value instead of wrapping this in a try/catch that can't fire.
  const then = new Date(isoTimestamp).getTime()
  if (Number.isNaN(then)) return isoTimestamp

  // Defensive: clamp to 0 in case server clock is ahead of client
  // (would otherwise produce confusing "-5s ago" strings).
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function CollapsibleSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      {/* A real <button>, not a click-handled <div>: the header is the only
          way to reveal this section, so it has to be keyboard-reachable and
          announce its expanded state to assistive tech. */}
      <button
        type="button"
        aria-expanded={open}
        style={{
          ...S.sectionTitle,
          cursor: 'pointer',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          // Strip the default button chrome so it still looks like the
          // section heading it replaced.
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          textAlign: 'left',
          width: '100%'
        }}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span
          style={{
            fontSize: 10,
            transition: 'transform 0.15s',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)'
          }}
        >
          {'\u25b6'}
        </span>
        {title}
      </button>
      {open && <div style={{ marginBottom: 16 }}>{children}</div>}
    </div>
  )
}

export default function PluginConfigurationPanel({
  configuration,
  save
}: PluginConfigurationPanelProps) {
  const cfg: PanelConfig = configuration || {}

  const [managedContainer, setManagedContainer] = useState(cfg.managedContainer !== false)
  const [mayaraVersion, setMayaraVersion] = useState(cfg.mayaraVersion || 'latest')
  const [mayaraArgs, setMayaraArgs] = useState((cfg.mayaraArgs || []).join(' '))
  const [host, setHost] = useState(cfg.host || 'localhost')
  const [secure, setSecure] = useState(cfg.secure || false)
  // The three numeric fields keep their RAW input while editing rather than
  // coercing on every keystroke: Number("") is 0, so clearing the box to
  // retype used to write port 0 into the config, and a partial entry like
  // "1e" became NaN. They are parsed and range-checked in doSave() instead.
  const [port, setPort] = useState(String(cfg.port ?? 6502))
  const [discoveryPollInterval, setDiscoveryPollInterval] = useState(
    String(cfg.discoveryPollInterval ?? 10)
  )
  const [reconnectInterval, setReconnectInterval] = useState(String(cfg.reconnectInterval ?? 5))

  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsError, setVersionsError] = useState('')
  const [pluginStatus, setPluginStatus] = useState<PluginStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [actionStatus, setActionStatus] = useState('')
  const [statusError, setStatusError] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [checking, setChecking] = useState(false)

  const fetchVersions = useCallback(async () => {
    setVersionsLoading(true)
    try {
      const res = await fetch('/plugins/mayara-server-signalk-plugin/api/versions')
      const body: unknown = res.ok ? await readJson(res) : null
      // deriveVersionsView (unit-tested in test/versionsView.test.ts)
      // decides the list + error line from the response; a null list on a
      // 502 means "keep the prior dropdown rather than wipe it".
      const view = deriveVersionsView(res.ok, body)
      if (view.versions !== null) setVersions(view.versions)
      setVersionsError(view.versionsError)
    } catch {
      // Offline: preserve whatever is already shown.
      setVersionsError('⚠ Offline — showing last known versions')
    }
    setVersionsLoading(false)
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/plugins/mayara-server-signalk-plugin/status')
      if (res.ok) setPluginStatus(toPluginStatus(await readJson(res)))
      else setPluginStatus({ connected: false, radars: [] })
    } catch {
      setPluginStatus({ connected: false, radars: [] })
    }
    setStatusLoading(false)
  }, [])

  useEffect(() => {
    // Both handle their own errors internally, so nothing can reject here;
    // `void` marks them as deliberately not awaited.
    void fetchVersions()
    void fetchStatus()
    const interval = setInterval(() => void fetchStatus(), 5000)
    return () => {
      clearInterval(interval)
    }
  }, [fetchVersions, fetchStatus])

  // Sync dropdown to actual running container tag (once on first status load)
  const [versionSynced, setVersionSynced] = useState(false)
  useEffect(() => {
    if (!versionSynced && pluginStatus?.container?.image) {
      const tag = imageTag(pluginStatus.container.image)
      if (tag) {
        setMayaraVersion(tag)
        setVersionSynced(true)
      }
    }
  }, [pluginStatus, versionSynced])

  const doSave = () => {
    // Validate the raw numeric inputs before persisting. Empty / partial /
    // out-of-range values are rejected with a message rather than silently
    // written (an empty port box used to save 0). Bounds mirror
    // src/config/schema.ts.
    const numeric: Array<{ label: string; raw: string; min: number; max: number }> = [
      { label: 'Port', raw: port, min: 1, max: 65535 },
      { label: 'Discovery interval', raw: discoveryPollInterval, min: 5, max: 60 },
      { label: 'Reconnect interval', raw: reconnectInterval, min: 1, max: 30 }
    ]
    const parsed: number[] = []
    for (const field of numeric) {
      const value = Number(field.raw.trim())
      // Integer, not just finite: all three are ports/second counts, and
      // Number("6502.5") is a perfectly finite value the server can't use.
      if (field.raw.trim() === '' || !Number.isInteger(value)) {
        setActionStatus(`${field.label} must be a whole number`)
        setStatusError(true)
        return
      }
      if (value < field.min || value > field.max) {
        setActionStatus(`${field.label} must be between ${field.min} and ${field.max}`)
        setStatusError(true)
        return
      }
      parsed.push(value)
    }
    const [portValue, discoveryValue, reconnectValue] = parsed as [number, number, number]

    const args = mayaraArgs.trim() ? mayaraArgs.trim().split(/\s+/) : []
    save({
      managedContainer,
      mayaraVersion,
      mayaraArgs: args,
      host: managedContainer ? '127.0.0.1' : host,
      port: portValue,
      secure,
      discoveryPollInterval: discoveryValue,
      reconnectInterval: reconnectValue
    })
    setActionStatus('Saved! Plugin will restart.')
    setStatusError(false)
  }

  const doCheckUpdate = async () => {
    setChecking(true)
    setActionStatus('Checking for updates...')
    setStatusError(false)
    try {
      const res = await fetch('/plugins/mayara-server-signalk-plugin/api/update/check')
      // Response shape is signalk-container's UpdateCheckResult.
      // See signalk-container/src/updates/types.ts.
      const data = toUpdateCheckResult(await readJson(res))
      if (res.ok) {
        const message = formatUpdateMessage(data)
        if (data.reason === 'offline') {
          setActionStatus('\ud83d\udce1 ' + message)
          setStatusError(false)
        } else if (data.updateAvailable) {
          setActionStatus('\u26a0\ufe0f ' + message)
          setStatusError(false)
        } else {
          setActionStatus('\u2705 ' + message)
          setStatusError(false)
        }
      } else {
        setActionStatus('Check failed: ' + (data.error || res.statusText))
        setStatusError(true)
      }
    } catch (e) {
      setActionStatus('Check failed: ' + errMsg(e))
      setStatusError(true)
    }
    setChecking(false)
  }

  const doUpdate = async () => {
    setUpdating(true)
    setActionStatus('Pulling image, stopping and recreating container...')
    setStatusError(false)
    try {
      const res = await fetch('/plugins/mayara-server-signalk-plugin/api/update/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: mayaraVersion })
      })
      const body = asRecord(await readJson(res))
      const data = {
        tag: typeof body.tag === 'string' ? body.tag : undefined,
        error: typeof body.error === 'string' ? body.error : undefined
      }
      if (res.ok) {
        if (data.tag) setMayaraVersion(data.tag)
        setActionStatus('Updated! Save config to apply.')
      } else {
        setActionStatus('Update failed: ' + (data.error || res.statusText))
        setStatusError(true)
      }
    } catch (e) {
      setActionStatus('Update failed: ' + errMsg(e))
      setStatusError(true)
    }
    setUpdating(false)
  }

  const isConnected = pluginStatus && pluginStatus.connected
  const radarCount = pluginStatus ? pluginStatus.radars.length : 0
  const containerState = pluginStatus?.container?.state
  const containerImage = pluginStatus?.container?.image || ''
  const runningTag = imageTag(containerImage) ?? 'unknown'
  // The rendered option buckets. splitVersions is the shared source of the
  // slice limits, so shownTags/runningTagFallback can never disagree with
  // what these <optgroup>s actually render.
  const { prVersions, stableVersions, preVersions } = splitVersions(versions)

  // When the running image's tag isn't among the rendered options — e.g. a
  // pr<N> whose /pulls fetch was rate-limited, or a stable pin that fell out
  // of the top-N — inject a synthetic option so the controlled <select>
  // never renders blank and silently resets the operator's real running
  // image. runningTagFallback is unit-tested in test/versionsView.test.ts.
  const runningFallbackTag = runningTagFallback(mayaraVersion, versions)

  return (
    <div style={S.root}>
      {/* Status */}
      <div style={S.sectionTitle}>mayara-server Status</div>

      {statusLoading ? (
        <div style={S.empty}>Checking connection...</div>
      ) : isConnected ? (
        <>
          <div style={S.card}>
            <div style={{ ...S.cardIcon, background: '#1e40af', color: '#fff' }}>R</div>
            <div style={S.cardInfo}>
              <div style={S.cardTitle}>mayara-server</div>
              <div style={S.cardMeta}>
                {host}:{port} &middot; {radarCount} radar{radarCount !== 1 ? 's' : ''} &middot;{' '}
                {runningTag}
              </div>
            </div>
            <div style={{ ...S.stateIndicator, background: '#10b981' }} title="Connected" />
          </div>

          {radarCount > 0 && (
            <div style={S.statsGrid}>
              {pluginStatus.radars.map((id) => {
                const fwd = (pluginStatus.spokeForwarders || []).find((f) => f.radarId === id)
                const streaming = fwd?.connected === true
                const stateText = streaming ? 'streaming' : 'connecting'
                return (
                  <div key={id} style={S.statCard}>
                    <div style={S.statValue}>
                      {/* The dot alone would convey state by colour only, which
                          is invisible to a colour-blind user — the label below
                          repeats it as text, and title/role expose it to AT. */}
                      <div
                        role="img"
                        aria-label={stateText}
                        title={stateText}
                        style={{
                          ...S.stateIndicator,
                          background: streaming ? '#10b981' : '#f59e0b',
                          display: 'inline-block',
                          marginRight: 6
                        }}
                      />
                    </div>
                    <div style={S.statLabel}>
                      {id} — {stateText}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      ) : (
        <div style={S.card}>
          <div style={{ ...S.cardIcon, background: '#fef2f2', color: '#ef4444' }}>R</div>
          <div style={S.cardInfo}>
            <div style={S.cardTitle}>mayara-server</div>
            <div style={S.cardMeta}>
              Not connected
              {managedContainer ? ' — waiting for container' : ` — check ${host}:${port}`}
            </div>
          </div>
          <div style={{ ...S.stateIndicator, background: '#ef4444' }} />
        </div>
      )}

      {/* Container */}
      <div style={S.sectionTitle}>Container</div>

      <div style={S.fieldRow}>
        <label style={S.label} htmlFor="mayara-managed-container">
          Managed container
        </label>
        <input
          id="mayara-managed-container"
          type="checkbox"
          style={S.checkbox}
          checked={managedContainer}
          onChange={(e) => {
            setManagedContainer(e.target.checked)
          }}
        />
        <span style={S.hint}>
          {managedContainer
            ? 'signalk-container manages mayara-server'
            : 'Connect to external instance'}
        </span>
      </div>

      {managedContainer && (
        <>
          <div style={S.fieldRow}>
            <label style={S.label} htmlFor="mayara-image-version">
              Image version
            </label>
            <select
              id="mayara-image-version"
              style={S.select}
              value={mayaraVersion}
              onChange={(e) => {
                setMayaraVersion(e.target.value)
              }}
            >
              <option value="latest">latest (recommended)</option>
              <option value="main">main (development)</option>
              {preVersions.map((v) => (
                <option key={v.tag} value={v.tag}>
                  {v.tag} (pre-release)
                </option>
              ))}
              {stableVersions.map((v, i) => (
                <option key={v.tag} value={v.tag}>
                  {v.tag}
                  {i === 0 ? ' (current stable)' : ''}
                </option>
              ))}
              {prVersions.length > 0 && (
                <optgroup label="PR test images">
                  {prVersions.map((v) => (
                    <option key={v.tag} value={v.tag}>
                      {v.tag} — {v.title}
                    </option>
                  ))}
                </optgroup>
              )}
              {runningFallbackTag && (
                <option value={runningFallbackTag}>{runningFallbackTag} (running)</option>
              )}
            </select>
            {versionsLoading && <span style={S.hint}>loading...</span>}
            <button
              type="button"
              style={{ ...S.btn, ...S.btnPrimary, padding: '4px 10px', fontSize: 11 }}
              onClick={() => void fetchVersions()}
              aria-label="Refresh available versions"
              title="Refresh available versions"
            >
              ↻
            </button>
            <button
              type="button"
              style={{
                ...S.btn,
                background: '#6b7280',
                color: '#fff',
                padding: '4px 12px',
                fontSize: 11,
                ...(checking ? S.btnDisabled : {})
              }}
              onClick={() => void doCheckUpdate()}
              disabled={checking || updating}
              title="Pull latest image to check for updates"
            >
              {checking ? 'Checking...' : 'Check'}
            </button>
            {containerState === 'running' && (
              <button
                type="button"
                style={{
                  ...S.btn,
                  background: '#f59e0b',
                  color: '#fff',
                  padding: '4px 12px',
                  fontSize: 11,
                  ...(updating ? S.btnDisabled : {})
                }}
                onClick={() => void doUpdate()}
                disabled={updating || checking}
                title="Pull selected version, stop and recreate container"
              >
                {updating ? 'Updating...' : 'Update'}
              </button>
            )}
          </div>

          {versionsError && (
            <div style={S.fieldRow}>
              <span style={S.label} />
              <span style={{ ...S.hint, color: '#ef4444' }}>{versionsError}</span>
            </div>
          )}

          <CollapsibleSection title="Advanced">
            <div style={S.fieldRow}>
              <label style={S.label} htmlFor="mayara-args">
                Arguments
              </label>
              <input
                id="mayara-args"
                style={{ ...S.input, width: 300 }}
                placeholder="--brand furuno --interface eth0"
                value={mayaraArgs}
                onChange={(e) => {
                  setMayaraArgs(e.target.value)
                }}
              />
              <span style={S.hint}>limit brand/interface, --emulator, etc.</span>
            </div>
          </CollapsibleSection>
        </>
      )}

      <CollapsibleSection title="Connection">
        <div style={S.fieldRow}>
          <label style={S.label} htmlFor="mayara-host">
            Host
          </label>
          <input
            id="mayara-host"
            style={{ ...S.input, ...(managedContainer ? { opacity: 0.5 } : {}) }}
            value={managedContainer ? '127.0.0.1' : host}
            onChange={(e) => {
              setHost(e.target.value)
            }}
            disabled={managedContainer}
          />
          {managedContainer && <span style={S.hint}>auto (container runs locally)</span>}
        </div>

        <div style={S.fieldRow}>
          <label style={S.label} htmlFor="mayara-port">
            Port
          </label>
          <input
            id="mayara-port"
            style={S.inputSmall}
            type="number"
            value={port}
            onChange={(e) => {
              setPort(e.target.value)
            }}
          />
        </div>

        <div style={S.fieldRow}>
          <label style={S.label} htmlFor="mayara-secure">
            Use HTTPS/WSS
          </label>
          <input
            id="mayara-secure"
            type="checkbox"
            style={S.checkbox}
            checked={secure}
            onChange={(e) => {
              setSecure(e.target.checked)
            }}
          />
        </div>

        <div style={S.fieldRow}>
          <label style={S.label} htmlFor="mayara-discovery-interval">
            Discovery interval (s)
          </label>
          <input
            id="mayara-discovery-interval"
            style={S.inputSmall}
            type="number"
            value={discoveryPollInterval}
            onChange={(e) => {
              setDiscoveryPollInterval(e.target.value)
            }}
          />
        </div>

        <div style={S.fieldRow}>
          <label style={S.label} htmlFor="mayara-reconnect-interval">
            Reconnect interval (s)
          </label>
          <input
            id="mayara-reconnect-interval"
            style={S.inputSmall}
            type="number"
            value={reconnectInterval}
            onChange={(e) => {
              setReconnectInterval(e.target.value)
            }}
          />
        </div>
      </CollapsibleSection>

      {/* Status */}
      {actionStatus && (
        <div style={{ ...S.status, color: statusError ? '#ef4444' : '#10b981', marginTop: 16 }}>
          {actionStatus}
        </div>
      )}

      {/* Save */}
      <div style={{ marginTop: 24 }}>
        <button type="button" style={{ ...S.btn, ...S.btnPrimary }} onClick={doSave}>
          Save Configuration
        </button>
      </div>
    </div>
  )
}
