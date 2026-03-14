import { useState, useEffect, useCallback, useRef } from 'react'
import { Activity } from 'lucide-react'
import type { DebugSnapshot } from '@real-life/wot-core'

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

  const refresh = useCallback(() => {
    if (typeof window !== 'undefined' && (window as any).wotDebug) {
      setSnapshot((window as any).wotDebug())
    }
  }, [])

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
        className="fixed bottom-20 left-4 md:bottom-4 z-50 w-8 h-8 rounded-full bg-card border border-border shadow-sm flex items-center justify-center hover:bg-muted transition-colors"
        aria-label="Debug Panel"
      >
        <Activity className="w-3.5 h-3.5 text-muted-foreground" />
        <span className={`absolute -top-0.5 -left-0.5 w-2.5 h-2.5 rounded-full border border-card ${
          overallStatus === 'green' ? 'bg-success' :
          overallStatus === 'yellow' ? 'bg-warning' : 'bg-destructive'
        }`} />
      </button>

      {/* Panel */}
      {open && snapshot && (
        <div ref={panelRef} className="fixed bottom-20 left-4 md:bottom-14 z-50 w-72 max-h-[70vh] overflow-y-auto bg-card border border-border rounded-lg shadow-lg p-3 text-foreground">
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
            {snapshot.impl === 'compact-store' && (
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

          {/* Legacy */}
          {snapshot.impl === 'legacy' && snapshot.legacy.idbChunkCount !== null && (
            <Section title="Legacy (IDB)">
              <Row
                label="Chunks"
                value={String(snapshot.legacy.idbChunkCount)}
                status={snapshot.legacy.idbChunkCount > 20 ? 'red' : snapshot.legacy.idbChunkCount > 10 ? 'yellow' : 'green'}
              />
              {snapshot.legacy.healthCheckResult !== null && (
                <Row label="Health" value={snapshot.legacy.healthCheckResult ? 'OK' : 'Unhealthy'} status={snapshot.legacy.healthCheckResult ? 'green' : 'red'} />
              )}
              {snapshot.legacy.findDurationMs !== null && (
                <Row label="find()" value={formatMs(snapshot.legacy.findDurationMs)} />
              )}
              {snapshot.legacy.flushDurationMs !== null && (
                <Row label="flush()" value={formatMs(snapshot.legacy.flushDurationMs)} />
              )}
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
        </div>
      )}
    </>
  )
}
