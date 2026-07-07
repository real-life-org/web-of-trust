import { useState, useEffect, useCallback, useRef } from 'react'
import { Activity } from 'lucide-react'
import type { DebugSnapshot } from '@web_of_trust/core/storage'
import {
  DEBUG_OBSERVABILITY_ENABLED,
  getDebugObservabilityCollector,
  subscribeDebugObservability,
  WOT_DEBUG_JSON_TESTID,
  type WotDebugSnapshot,
  type WotDebugCollector,
} from '../../debug/debugObservability'

function StatusDot({ status }: { status: 'green' | 'yellow' | 'red' }) {
  const colors = {
    green: 'bg-success',
    yellow: 'bg-warning',
    red: 'bg-destructive',
  }
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[status]}`} />
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0B'
  if (bytes < 1024) return `${bytes}B`
  return `${(bytes / 1024).toFixed(1)}KB`
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString()
}

function getLoadHealthStatus(snapshot: DebugSnapshot): 'green' | 'yellow' | 'red' {
  if (!snapshot.persistence.lastLoad) return 'yellow'
  const ms = snapshot.persistence.lastLoad.timeMs
  if (ms < 500) return 'green'
  if (ms < 3000) return 'yellow'
  return 'red'
}

function getRelayStatus(snapshot: DebugSnapshot): 'green' | 'yellow' | 'red' {
  return snapshot.sync.relay.connected ? 'green' : 'red'
}

function getOverallStatus(snapshot: DebugSnapshot): 'green' | 'yellow' | 'red' {
  const load = getLoadHealthStatus(snapshot)
  const relay = getRelayStatus(snapshot)
  if (load === 'red' || relay === 'red') return 'red'
  if (load === 'yellow' || relay === 'yellow') return 'yellow'
  return 'green'
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">{title}</h4>
      {children}
    </div>
  )
}

function Row({ label, value, status }: { label: string; value: string; status?: 'green' | 'yellow' | 'red' }) {
  return (
    <div className="flex items-center justify-between text-xs py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono flex items-center gap-1.5">
        {status && <StatusDot status={status} />}
        {value}
      </span>
    </div>
  )
}

export function DebugPanel() {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null)
  const [appSnapshot, setAppSnapshot] = useState<WotDebugSnapshot | null>(null)

  const refresh = useCallback(() => {
    if (typeof window !== 'undefined' && (window as any).wotDebug) {
      setSnapshot((window as any).wotDebug())
    }
  }, [])

  // D2 test-observability (GATED): poll the app collector so window.__wotDebug + the data-testid
  // JSON stay fresh even while the panel is closed (a Spur-B operator reads it without opening).
  // Only runs when the flag registered a collector; entirely tree-shaken/dormant when off.
  const pullGenRef = useRef(0)
  useEffect(() => {
    if (!DEBUG_OBSERVABILITY_ENABLED) return
    let alive = true
    const pull = (collect: WotDebugCollector | null) => {
      // Bump the generation on EVERY pull. A collector promise is bound to the generation at its
      // start; a LATE resolution (a still-in-flight collect() from the PREVIOUS identity that
      // resolves after an unregister or after a newer collector was registered) is dropped because
      // its generation is stale — so a slow A().then() can never re-populate the DOM channel with
      // A's deviceId/DID/store-names after A was unregistered/superseded.
      const gen = ++pullGenRef.current
      if (!collect) { if (alive) setAppSnapshot(null); return }
      collect()
        .then((s) => { if (alive && pullGenRef.current === gen) setAppSnapshot(s) })
        .catch(() => {})
    }
    // Subscribe: fires immediately with the current collector AND synchronously on every
    // (un)register — an unregister clears the snapshot in the SAME tick (no 2s stale-identity gap).
    const unsub = subscribeDebugObservability(pull)
    // Periodic refresh for live head/outbox/gen updates while a collector is registered.
    const interval = setInterval(() => pull(getDebugObservabilityCollector()), 2000)
    return () => { alive = false; unsub(); clearInterval(interval) }
  }, [])

  const copyAppSnapshot = useCallback(() => {
    if (!appSnapshot) return
    void navigator.clipboard?.writeText(JSON.stringify(appSnapshot, null, 2)).catch(() => {})
  }, [appSnapshot])

  // Refresh every 2s when open
  useEffect(() => {
    if (!open) return
    refresh()
    const interval = setInterval(refresh, 2000)
    return () => clearInterval(interval)
  }, [open, refresh])

  // Initial check — show icon only if wotDebug is available
  useEffect(() => {
    const check = setInterval(() => {
      if ((window as any).wotDebug) {
        refresh()
        clearInterval(check)
      }
    }, 1000)
    return () => clearInterval(check)
  }, [refresh])

  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const overallStatus = snapshot ? getOverallStatus(snapshot) : 'yellow'

  return (
    <>
      {/* Toggle button — bottom left, above mobile nav */}
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        className="fixed bottom-[calc(5rem+var(--safe-bottom))] left-4 md:bottom-4 z-50 w-8 h-8 rounded-full bg-card border border-border shadow-sm flex items-center justify-center hover:bg-muted transition-colors"
        aria-label="Debug Panel"
      >
        <Activity className="w-3.5 h-3.5 text-muted-foreground" />
        <span className={`absolute -top-0.5 -left-0.5 w-2.5 h-2.5 rounded-full border border-card ${
          overallStatus === 'green' ? 'bg-success' :
          overallStatus === 'yellow' ? 'bg-warning' : 'bg-destructive'
        }`} />
      </button>

      {/* D2 machine-readable observable (GATED): always in the DOM when the flag registered a
          collector, so a Spur-B / Playwright operator reads the full snapshot WITHOUT opening the
          panel. Absent from the DOM entirely when the flag is off (default, prod-safe). */}
      {DEBUG_OBSERVABILITY_ENABLED && appSnapshot && (
        <div data-testid={WOT_DEBUG_JSON_TESTID} hidden style={{ display: 'none' }}>
          {JSON.stringify(appSnapshot)}
        </div>
      )}

      {/* Panel */}
      {open && snapshot && (
        <div ref={panelRef} className="fixed bottom-[calc(5rem+var(--safe-bottom))] left-4 md:bottom-14 z-50 w-72 max-h-[70vh] overflow-y-auto bg-card border border-border rounded-lg shadow-lg p-3 text-foreground">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <StatusDot status={overallStatus} />
              Persistence
            </h3>
            <span className="text-xs text-muted-foreground font-mono">{snapshot.impl}</span>
          </div>

          {/* Load */}
          <Section title="Last Load">
            {snapshot.persistence.lastLoad ? (
              <>
                <Row
                  label="Source"
                  value={snapshot.persistence.lastLoad.source}
                />
                <Row label="Time" value={formatMs(snapshot.persistence.lastLoad.timeMs)} status={getLoadHealthStatus(snapshot)} />
                <Row label="Size" value={formatSize(snapshot.persistence.lastLoad.sizeBytes)} />
                {Object.entries(snapshot.persistence.lastLoad.details).map(([k, v]) => (
                  <Row key={k} label={k} value={String(v)} />
                ))}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No load yet</p>
            )}
          </Section>

          {/* Saves */}
          <Section title="Saves">
            {(snapshot.impl === 'compact-store' || snapshot.impl === 'yjs') && (
              <>
                <Row
                  label="CompactStore"
                  value={snapshot.persistence.saves.compactStore.totalSaves > 0
                    ? `${snapshot.persistence.saves.compactStore.totalSaves}× — last ${formatMs(snapshot.persistence.saves.compactStore.lastTimeMs)}`
                    : '—'}
                />
                {snapshot.persistence.saves.compactStore.errors > 0 && (
                  <Row label="CS Errors" value={String(snapshot.persistence.saves.compactStore.errors)} status="red" />
                )}
              </>
            )}
            <Row
              label="Vault"
              value={snapshot.persistence.saves.vault.totalSaves > 0
                ? `${snapshot.persistence.saves.vault.totalSaves}× — last ${formatMs(snapshot.persistence.saves.vault.lastTimeMs)}`
                : '—'}
            />
            {snapshot.persistence.saves.vault.errors > 0 && (
              <Row label="Vault Errors" value={String(snapshot.persistence.saves.vault.errors)} status="red" />
            )}
            {snapshot.automerge.saveBlockedUiMs.max > 0 && (
              <Row
                label="UI Block"
                value={`avg ${formatMs(snapshot.automerge.saveBlockedUiMs.avg)} / max ${formatMs(snapshot.automerge.saveBlockedUiMs.max)}`}
                status={snapshot.automerge.saveBlockedUiMs.max > 100 ? 'red' : snapshot.automerge.saveBlockedUiMs.max > 50 ? 'yellow' : 'green'}
              />
            )}
          </Section>

          {/* Sync */}
          <Section title="Sync">
            <Row
              label="Relay"
              value={snapshot.sync.relay.connected ? 'Connected' : 'Disconnected'}
              status={getRelayStatus(snapshot)}
            />
            {snapshot.sync.relay.url && (
              <Row label="URL" value={new URL(snapshot.sync.relay.url).hostname} />
            )}
            <Row label="Peers" value={String(snapshot.sync.relay.peers)} />
          </Section>

          {/* Spaces */}
          {snapshot.spaces.length > 0 && (
            <Section title={`Spaces (${snapshot.spaces.length})`}>
              {snapshot.spaces.map(s => (
                <div key={s.spaceId} className="mb-1.5 last:mb-0">
                  <div className="text-xs font-medium truncate" title={s.spaceId}>
                    {s.name || s.spaceId.slice(0, 8) + '…'}
                  </div>
                  <div className="pl-2">
                    <Row label="Size" value={formatSize(s.docSizeBytes)} />
                    <Row label="Members" value={String(s.members)} />
                    {s.loadSource && (
                      <Row label="Loaded" value={`${s.loadSource}${s.loadTimeMs !== null ? ` ${formatMs(s.loadTimeMs)}` : ''}`} />
                    )}
                    {(s.compactStoreSaves > 0 || s.vaultSaves > 0) && (
                      <Row label="Saves" value={`CS ${s.compactStoreSaves}× / V ${s.vaultSaves}×`} />
                    )}
                  </div>
                </div>
              ))}
            </Section>
          )}

          {/* Migration */}
          {snapshot.persistence.migration && (
            <Section title="Migration">
              <Row label="From" value={`${snapshot.persistence.migration.fromChunks} chunks`} />
              <Row label="To" value={formatSize(snapshot.persistence.migration.toSizeBytes)} />
              <Row label="At" value={formatTime(snapshot.persistence.migration.at)} />
            </Section>
          )}

          {/* Errors */}
          {snapshot.persistence.errors.length > 0 && (
            <Section title="Recent Errors">
              {snapshot.persistence.errors.slice(-3).map((err, i) => (
                <div key={i} className="text-xs text-destructive py-0.5 font-mono truncate" title={err.error}>
                  {err.operation}: {err.error}
                </div>
              ))}
            </Section>
          )}

          {/* D2 — Test Observability (GATED). deviceId / 3 heads per space / gen / outbox /
              keystore status / durable-store presence. No key material, ever. */}
          {DEBUG_OBSERVABILITY_ENABLED && appSnapshot && (
            <Section title="Test Observability (D2)">
              <Row label="deviceId" value={appSnapshot.deviceId} />
              <Row label="Outbox depth" value={String(appSnapshot.outboxDepth)} />
              <Row label="Keystore enrolled" value={String(appSnapshot.keystore.enrolled)} />
              {appSnapshot.spaces.map((sp) => (
                <div key={sp.spaceId} className="text-xs py-0.5 font-mono">
                  <div className="text-muted-foreground truncate" title={sp.spaceId}>
                    {(sp.name ?? sp.spaceId.slice(0, 8))} · gen {sp.generation}
                  </div>
                  <div className="pl-2 text-[10px] truncate">strict {JSON.stringify(sp.heads.strictContiguous)}</div>
                  <div className="pl-2 text-[10px] truncate">sync {JSON.stringify(sp.heads.syncRequest)}</div>
                  <div className="pl-2 text-[10px] truncate">known {JSON.stringify(sp.heads.known)}</div>
                </div>
              ))}
              {appSnapshot.durableStores.map((st) => (
                <Row key={st.name} label={st.name.replace(/:.*$/, '')} value={String(st.present)} />
              ))}
              <button
                onClick={copyAppSnapshot}
                className="mt-1 text-xs px-2 py-1 rounded bg-muted hover:bg-muted/70 border border-border"
                aria-label="Copy debug snapshot JSON"
              >
                Copy JSON
              </button>
            </Section>
          )}
        </div>
      )}
    </>
  )
}
