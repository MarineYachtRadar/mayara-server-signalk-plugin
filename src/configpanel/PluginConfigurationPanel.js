import React, { useState, useEffect, useCallback } from "react";

const S = {
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#333",
    padding: "16px 0",
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: 10,
    marginTop: 24,
  },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 16px",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnPrimary: { background: "#3b82f6", color: "#fff" },
  btnDisabled: { opacity: 0.5, cursor: "not-allowed" },
  status: { marginTop: 8, fontSize: 12, minHeight: 18 },
  card: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "14px 18px",
    background: "#f8f9fa",
    border: "1px solid #e0e0e0",
    borderRadius: 10,
    marginBottom: 12,
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 20,
    fontWeight: 700,
    flexShrink: 0,
  },
  cardInfo: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: 600, color: "#333" },
  cardMeta: { fontSize: 12, color: "#888" },
  stateIndicator: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: "#555",
    width: 180,
    flexShrink: 0,
  },
  select: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: 13,
    background: "#fff",
    color: "#333",
    minWidth: 200,
  },
  input: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: 13,
    background: "#fff",
    color: "#333",
    width: 200,
  },
  inputSmall: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: 13,
    background: "#fff",
    color: "#333",
    width: 80,
  },
  checkbox: { width: 16, height: 16, accentColor: "#3b82f6" },
  hint: { fontSize: 11, color: "#aaa", marginLeft: 8 },
  empty: {
    textAlign: "center",
    padding: "30px 16px",
    color: "#999",
    fontSize: 13,
  },
  tag: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 600,
    marginLeft: 8,
  },
  tagPre: { background: "#fef3c7", color: "#92400e" },
  tagLatest: { background: "#dcfce7", color: "#166534" },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 10,
    marginBottom: 12,
  },
  statCard: {
    padding: "12px 16px",
    background: "#f8f9fa",
    border: "1px solid #e0e0e0",
    borderRadius: 10,
    textAlign: "center",
  },
  statValue: { fontSize: 22, fontWeight: 700, color: "#333" },
  statLabel: { fontSize: 11, color: "#888", marginTop: 2 },
};

/**
 * Format an UpdateCheckResult from signalk-container's update service
 * into a human-readable status line.
 */
function formatUpdateMessage(result) {
  const {
    runningTag,
    tagKind,
    currentVersion,
    latestVersion,
    updateAvailable,
    reason,
    fromCache,
    lastSuccessfulCheckAt,
  } = result || {};

  if (reason === "offline") {
    if (fromCache && lastSuccessfulCheckAt) {
      const ago = formatTimeAgo(lastSuccessfulCheckAt);
      return `Offline — last checked ${ago}: ${updateAvailable ? "update available" : "up to date"}`;
    }
    return "Offline — never checked yet";
  }

  if (reason === "newer-version") {
    return `Update available: ${currentVersion} \u2192 ${latestVersion}`;
  }

  if (reason === "digest-drift") {
    const stableNote = latestVersion ? ` (latest stable: ${latestVersion})` : "";
    return `Image rebuild available for :${runningTag}${stableNote}`;
  }

  if (reason === "up-to-date") {
    if (tagKind === "floating" && latestVersion) {
      return `Up to date with :${runningTag} (latest stable: ${latestVersion})`;
    }
    return `Up to date (${currentVersion || runningTag})`;
  }

  if (reason === "older-than-pinned") {
    return `Pinned to ${currentVersion}; latest stable is ${latestVersion}`;
  }

  if (reason === "error") {
    return `Check error: ${result.error || "unknown"}`;
  }

  return `State: ${reason || "unknown"}`;
}

function formatTimeAgo(isoTimestamp) {
  try {
    const then = new Date(isoTimestamp).getTime();
    // Defensive: clamp to 0 in case server clock is ahead of client
    // (would otherwise produce confusing "-5s ago" strings).
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return isoTimestamp;
  }
}

function CollapsibleSection({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div
        style={{
          ...S.sectionTitle,
          cursor: "pointer",
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        onClick={() => setOpen(!open)}
      >
        <span style={{ fontSize: 10, transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
          {"\u25b6"}
        </span>
        {title}
      </div>
      {open && <div style={{ marginBottom: 16 }}>{children}</div>}
    </div>
  );
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const cfg = configuration || {};

  const [managedContainer, setManagedContainer] = useState(cfg.managedContainer !== false);
  const [mayaraVersion, setMayaraVersion] = useState(cfg.mayaraVersion || "latest");
  const [mayaraArgs, setMayaraArgs] = useState((cfg.mayaraArgs || []).join(" "));
  const [host, setHost] = useState(cfg.host || "localhost");
  const [port, setPort] = useState(cfg.port || 6502);
  const [secure, setSecure] = useState(cfg.secure || false);
  const [discoveryPollInterval, setDiscoveryPollInterval] = useState(cfg.discoveryPollInterval || 10);
  const [reconnectInterval, setReconnectInterval] = useState(cfg.reconnectInterval || 5);

  const [versions, setVersions] = useState([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [pluginStatus, setPluginStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [actionStatus, setActionStatus] = useState("");
  const [statusError, setStatusError] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [checking, setChecking] = useState(false);

  const fetchVersions = useCallback(async () => {
    setVersionsLoading(true);
    try {
      const res = await fetch("/plugins/mayara-server-signalk-plugin/api/versions");
      if (res.ok) setVersions(await res.json());
    } catch { /* offline */ }
    setVersionsLoading(false);
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/plugins/mayara-server-signalk-plugin/status");
      if (res.ok) setPluginStatus(await res.json());
      else setPluginStatus({ connected: false, radars: [] });
    } catch {
      setPluginStatus({ connected: false, radars: [] });
    }
    setStatusLoading(false);
  }, []);

  useEffect(() => {
    fetchVersions();
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchVersions, fetchStatus]);

  // Sync dropdown to actual running container tag (once on first status load)
  const [versionSynced, setVersionSynced] = useState(false);
  useEffect(() => {
    if (!versionSynced && pluginStatus?.container?.image) {
      const tag = pluginStatus.container.image.split(":")[1];
      if (tag) {
        setMayaraVersion(tag);
        setVersionSynced(true);
      }
    }
  }, [pluginStatus, versionSynced]);

  const doSave = () => {
    const args = mayaraArgs.trim() ? mayaraArgs.trim().split(/\s+/) : [];
    save({
      managedContainer,
      mayaraVersion,
      mayaraArgs: args,
      host: managedContainer ? "127.0.0.1" : host,
      port,
      secure,
      discoveryPollInterval,
      reconnectInterval,
    });
    setActionStatus("Saved! Plugin will restart.");
    setStatusError(false);
  };

  const doCheckUpdate = async () => {
    setChecking(true);
    setActionStatus("Checking for updates...");
    setStatusError(false);
    try {
      const res = await fetch("/plugins/mayara-server-signalk-plugin/api/update/check");
      const data = await res.json();
      if (res.ok) {
        // Response shape is signalk-container's UpdateCheckResult.
        // See signalk-container/src/updates/types.ts.
        const message = formatUpdateMessage(data);
        if (data.reason === "offline") {
          setActionStatus("\ud83d\udce1 " + message);
          setStatusError(false);
        } else if (data.updateAvailable) {
          setActionStatus("\u26a0\ufe0f " + message);
          setStatusError(false);
        } else {
          setActionStatus("\u2705 " + message);
          setStatusError(false);
        }
      } else {
        setActionStatus("Check failed: " + (data.error || res.statusText));
        setStatusError(true);
      }
    } catch (e) {
      setActionStatus("Check failed: " + e.message);
      setStatusError(true);
    }
    setChecking(false);
  };

  const doUpdate = async () => {
    setUpdating(true);
    setActionStatus("Pulling image, stopping and recreating container...");
    setStatusError(false);
    try {
      const res = await fetch("/plugins/mayara-server-signalk-plugin/api/update/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: mayaraVersion }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.tag) setMayaraVersion(data.tag);
        setActionStatus("Updated! Save config to apply.");
      } else {
        const data = await res.json();
        setActionStatus("Update failed: " + (data.error || res.statusText));
        setStatusError(true);
      }
    } catch (e) {
      setActionStatus("Update failed: " + e.message);
      setStatusError(true);
    }
    setUpdating(false);
  };

  const isConnected = pluginStatus && pluginStatus.connected;
  const radarCount = pluginStatus ? pluginStatus.radars.length : 0;
  const containerState = pluginStatus?.container?.state;
  const containerImage = pluginStatus?.container?.image || "";
  const runningTag = containerImage.split(":")[1] || "unknown";
  const updateAvailable = versions.length > 0 && mayaraVersion === "latest"
    ? false  // can't compare "latest" to release tags
    : versions.length > 0 && !versions.some((v) => v.tag === mayaraVersion);

  const stableVersions = versions.filter((v) => !v.prerelease).slice(0, 5);
  const preVersions = versions.filter((v) => v.prerelease).slice(0, 3);

  return (
    <div style={S.root}>
      {/* Status */}
      <div style={S.sectionTitle}>mayara-server Status</div>

      {statusLoading ? (
        <div style={S.empty}>Checking connection...</div>
      ) : isConnected ? (
        <>
          <div style={S.card}>
            <div style={{ ...S.cardIcon, background: "#1e40af", color: "#fff" }}>R</div>
            <div style={S.cardInfo}>
              <div style={S.cardTitle}>mayara-server</div>
              <div style={S.cardMeta}>
                {host}:{port} &middot; {radarCount} radar{radarCount !== 1 ? "s" : ""} &middot; {runningTag}
              </div>
            </div>
            <div style={{ ...S.stateIndicator, background: "#10b981" }} title="Connected" />
          </div>

          {radarCount > 0 && (
            <div style={S.statsGrid}>
              {pluginStatus.radars.map((id) => {
                const fwd = (pluginStatus.spokeForwarders || []).find((f) => f.radarId === id);
                return (
                  <div key={id} style={S.statCard}>
                    <div style={S.statValue}>
                      <div style={{ ...S.stateIndicator, background: fwd && fwd.connected ? "#10b981" : "#f59e0b", display: "inline-block", marginRight: 6 }} />
                    </div>
                    <div style={S.statLabel}>{id}</div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div style={S.card}>
          <div style={{ ...S.cardIcon, background: "#fef2f2", color: "#ef4444" }}>R</div>
          <div style={S.cardInfo}>
            <div style={S.cardTitle}>mayara-server</div>
            <div style={S.cardMeta}>
              Not connected
              {managedContainer ? " — waiting for container" : ` — check ${host}:${port}`}
            </div>
          </div>
          <div style={{ ...S.stateIndicator, background: "#ef4444" }} />
        </div>
      )}

      {/* Container */}
      <div style={S.sectionTitle}>Container</div>

      <div style={S.fieldRow}>
        <span style={S.label}>Managed container</span>
        <input
          type="checkbox"
          style={S.checkbox}
          checked={managedContainer}
          onChange={(e) => setManagedContainer(e.target.checked)}
        />
        <span style={S.hint}>
          {managedContainer ? "signalk-container manages mayara-server" : "Connect to external instance"}
        </span>
      </div>

      {managedContainer && (
        <>
          <div style={S.fieldRow}>
            <span style={S.label}>Image version</span>
            <select style={S.select} value={mayaraVersion} onChange={(e) => setMayaraVersion(e.target.value)}>
              <option value="latest">latest (recommended)</option>
              <option value="main">main (development)</option>
              {preVersions.map((v) => (
                <option key={v.tag} value={v.tag}>{v.tag} (pre-release)</option>
              ))}
              {stableVersions.map((v, i) => (
                <option key={v.tag} value={v.tag}>{v.tag}{i === 0 ? " (current stable)" : ""}</option>
              ))}
            </select>
            {versionsLoading && <span style={S.hint}>loading...</span>}
            <button
              style={{ ...S.btn, ...S.btnPrimary, padding: "4px 10px", fontSize: 11 }}
              onClick={fetchVersions}
              title="Refresh available versions"
            >↻</button>
            {managedContainer && (
              <>
                <button
                  style={{ ...S.btn, background: "#6b7280", color: "#fff", padding: "4px 12px", fontSize: 11, ...(checking ? S.btnDisabled : {}) }}
                  onClick={doCheckUpdate}
                  disabled={checking || updating}
                  title="Pull latest image to check for updates"
                >{checking ? "Checking..." : "Check"}</button>
                {containerState === "running" && (
                  <button
                    style={{ ...S.btn, background: "#f59e0b", color: "#fff", padding: "4px 12px", fontSize: 11, ...(updating ? S.btnDisabled : {}) }}
                    onClick={doUpdate}
                    disabled={updating || checking}
                    title="Pull selected version, stop and recreate container"
                  >{updating ? "Updating..." : "Update"}</button>
                )}
              </>
            )}
          </div>

          <CollapsibleSection title="Advanced">
            <div style={S.fieldRow}>
              <span style={S.label}>Arguments</span>
              <input
                style={{ ...S.input, width: 300 }}
                placeholder="--brand furuno --interface eth0"
                value={mayaraArgs}
                onChange={(e) => setMayaraArgs(e.target.value)}
              />
              <span style={S.hint}>limit brand/interface, --emulator, etc.</span>
            </div>
          </CollapsibleSection>
        </>
      )}

      <CollapsibleSection title="Connection">
        <div style={S.fieldRow}>
          <span style={S.label}>Host</span>
          <input
            style={{ ...S.input, ...(managedContainer ? { opacity: 0.5 } : {}) }}
            value={managedContainer ? "127.0.0.1" : host}
            onChange={(e) => setHost(e.target.value)}
            disabled={managedContainer}
          />
          {managedContainer && <span style={S.hint}>auto (container runs locally)</span>}
        </div>

        <div style={S.fieldRow}>
          <span style={S.label}>Port</span>
          <input style={S.inputSmall} type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
        </div>

        <div style={S.fieldRow}>
          <span style={S.label}>Use HTTPS/WSS</span>
          <input type="checkbox" style={S.checkbox} checked={secure} onChange={(e) => setSecure(e.target.checked)} />
        </div>

        <div style={S.fieldRow}>
          <span style={S.label}>Discovery interval (s)</span>
          <input style={S.inputSmall} type="number" value={discoveryPollInterval} onChange={(e) => setDiscoveryPollInterval(Number(e.target.value))} />
        </div>

        <div style={S.fieldRow}>
          <span style={S.label}>Reconnect interval (s)</span>
          <input style={S.inputSmall} type="number" value={reconnectInterval} onChange={(e) => setReconnectInterval(Number(e.target.value))} />
        </div>
      </CollapsibleSection>

      {/* Status */}
      {actionStatus && (
        <div style={{ ...S.status, color: statusError ? "#ef4444" : "#10b981", marginTop: 16 }}>
          {actionStatus}
        </div>
      )}

      {/* Save */}
      <div style={{ marginTop: 24 }}>
        <button style={{ ...S.btn, ...S.btnPrimary }} onClick={doSave}>Save Configuration</button>
      </div>
    </div>
  );
}
