/**
 * Persistence Metrics
 *
 * Structured logging and monitoring for the persistence layer.
 * Collects load/save/error metrics and exposes them via window.wotDebug().
 *
 * Output format:
 *   [persistence] ✓ load impl=legacy source=indexeddb time=3775ms size=12.3KB contacts=9
 *   [persistence] ✓ save impl=legacy target=vault time=210ms size=12.3KB
 *   [persistence] ✗ save impl=legacy target=vault error="NetworkError" time=5002ms
 */

export type ImplTag = 'legacy' | 'compact-store'
export type LoadSource = 'compact-store' | 'indexeddb' | 'vault' | 'wot-profiles' | 'migration' | 'new'
export type SaveTarget = 'compact-store' | 'vault'

export interface LoadMetric {
  source: LoadSource
  timeMs: number
  sizeBytes: number
  details: Record<string, unknown>
  at: string
}

export interface SaveMetric {
  target: SaveTarget
  timeMs: number
  sizeBytes: number
  blockedUiMs?: number
  at: string
}

export interface ErrorMetric {
  operation: string
  error: string
  at: string
}

export interface MigrationMetric {
  fromChunks: number
  toSizeBytes: number
  at: string
}

export interface SaveStats {
  lastAt: string | null
  lastTimeMs: number
  lastSizeBytes: number
  totalSaves: number
  errors: number
}

export interface SpaceMetric {
  spaceId: string
  name: string | null
  loadSource: LoadSource | null
  loadTimeMs: number | null
  docSizeBytes: number
  compactStoreSaves: number
  vaultSaves: number
  lastSaveMs: number | null
  members: number
}

export interface DebugSnapshot {
  impl: ImplTag
  persistence: {
    lastLoad: LoadMetric | null
    saves: {
      compactStore: SaveStats
      vault: SaveStats
    }
    migration: MigrationMetric | null
    errors: ErrorMetric[]
  }
  spaces: SpaceMetric[]
  sync: {
    relay: {
      connected: boolean
      url: string | null
      peers: number
      lastMessage: string | null
    }
  }
  automerge: {
    saveBlockedUiMs: { last: number; avg: number; max: number }
    docSizeBytes: number
    docStats: { contacts: number; attestations: number; spaces: number }
  }
  legacy: {
    idbChunkCount: number | null
    healthCheckResult: boolean | null
    findDurationMs: number | null
    flushDurationMs: number | null
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  return `${(bytes / 1024).toFixed(1)}KB`
}

function formatDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

export class PersistenceMetrics {
  private impl: ImplTag
  private lastLoad: LoadMetric | null = null
  private compactStoreSaves: SaveStats = { lastAt: null, lastTimeMs: 0, lastSizeBytes: 0, totalSaves: 0, errors: 0 }
  private vaultSaves: SaveStats = { lastAt: null, lastTimeMs: 0, lastSizeBytes: 0, totalSaves: 0, errors: 0 }
  private migration: MigrationMetric | null = null
  private errors: ErrorMetric[] = []
  private blockedUiSamples: number[] = []

  // Space metrics
  private spaceMetrics = new Map<string, SpaceMetric>()

  // Legacy-specific
  private _idbChunkCount: number | null = null
  private _healthCheckResult: boolean | null = null
  private _findDurationMs: number | null = null
  private _flushDurationMs: number | null = null

  // Sync info (set externally)
  private _relayConnected = false
  private _relayUrl: string | null = null
  private _relayPeers = 0
  private _relayLastMessage: string | null = null

  // Doc info (set externally)
  private _docSizeBytes = 0
  private _docContacts = 0
  private _docAttestations = 0
  private _docSpaces = 0

  constructor(impl: ImplTag) {
    this.impl = impl
  }

  logLoad(source: LoadSource, timeMs: number, sizeBytes: number, details: Record<string, unknown> = {}): void {
    const metric: LoadMetric = {
      source,
      timeMs,
      sizeBytes,
      details,
      at: new Date().toISOString(),
    }
    this.lastLoad = metric

    const detailStr = Object.keys(details).length > 0 ? ` ${formatDetails(details)}` : ''
    console.log(`[persistence] ✓ load impl=${this.impl} source=${source} time=${timeMs}ms size=${formatSize(sizeBytes)}${detailStr}`)
  }

  logSave(target: SaveTarget, timeMs: number, sizeBytes: number, blockedUiMs?: number): void {
    const stats = target === 'compact-store' ? this.compactStoreSaves : this.vaultSaves
    stats.lastAt = new Date().toISOString()
    stats.lastTimeMs = timeMs
    stats.lastSizeBytes = sizeBytes
    stats.totalSaves++

    if (blockedUiMs !== undefined) {
      this.blockedUiSamples.push(blockedUiMs)
      // Keep last 100 samples
      if (this.blockedUiSamples.length > 100) this.blockedUiSamples.shift()
    }

    const blockedStr = blockedUiMs !== undefined ? ` save-blocked-ui=${blockedUiMs}ms` : ''
    console.log(`[persistence] ✓ save impl=${this.impl} target=${target} time=${timeMs}ms size=${formatSize(sizeBytes)}${blockedStr}`)
  }

  logError(operation: string, error: unknown): void {
    const errorStr = error instanceof Error ? error.message : String(error)
    const metric: ErrorMetric = {
      operation,
      error: errorStr,
      at: new Date().toISOString(),
    }
    this.errors.push(metric)
    // Keep last 50 errors
    if (this.errors.length > 50) this.errors.shift()

    // Track save errors in stats
    if (operation.startsWith('save:')) {
      const target = operation.split(':')[1]
      if (target === 'compact-store') this.compactStoreSaves.errors++
      if (target === 'vault') this.vaultSaves.errors++
    }

    console.error(`[persistence] ✗ ${operation} impl=${this.impl} error="${errorStr}"`)
  }

  logMigration(fromChunks: number, toSizeBytes: number): void {
    this.migration = {
      fromChunks,
      toSizeBytes,
      at: new Date().toISOString(),
    }
    console.log(`[persistence] ⚡ migration impl=${this.impl} chunks=${fromChunks} → snapshot=${formatSize(toSizeBytes)}`)
  }

  // --- Legacy-specific setters ---

  setIdbChunkCount(count: number): void {
    this._idbChunkCount = count
  }

  setHealthCheckResult(healthy: boolean): void {
    this._healthCheckResult = healthy
  }

  setFindDuration(ms: number): void {
    this._findDurationMs = ms
  }

  setFlushDuration(ms: number): void {
    this._flushDurationMs = ms
  }

  // --- Sync info setters ---

  setRelayStatus(connected: boolean, url: string | null, peers: number): void {
    this._relayConnected = connected
    this._relayUrl = url
    this._relayPeers = peers
    this._relayLastMessage = new Date().toISOString()
  }

  // --- Doc info setters ---

  setDocStats(sizeBytes: number, contacts: number, attestations: number, spaces: number): void {
    this._docSizeBytes = sizeBytes
    this._docContacts = contacts
    this._docAttestations = attestations
    this._docSpaces = spaces
  }

  // --- Space metrics ---

  logSpaceLoad(spaceId: string, name: string | null, source: LoadSource, timeMs: number, sizeBytes: number, members: number): void {
    const existing = this.spaceMetrics.get(spaceId)
    this.spaceMetrics.set(spaceId, {
      spaceId,
      name,
      loadSource: source,
      loadTimeMs: timeMs,
      docSizeBytes: sizeBytes,
      compactStoreSaves: existing?.compactStoreSaves ?? 0,
      vaultSaves: existing?.vaultSaves ?? 0,
      lastSaveMs: existing?.lastSaveMs ?? null,
      members,
    })
    console.log(`[persistence] ✓ space-load id=${spaceId.slice(0,8)}… name="${name}" source=${source} time=${timeMs}ms size=${formatSize(sizeBytes)} members=${members}`)
  }

  logSpaceSave(spaceId: string, target: SaveTarget, timeMs: number, sizeBytes: number): void {
    const existing = this.spaceMetrics.get(spaceId)
    if (existing) {
      existing.docSizeBytes = sizeBytes
      existing.lastSaveMs = timeMs
      if (target === 'compact-store') existing.compactStoreSaves++
      else existing.vaultSaves++
    }
  }

  removeSpace(spaceId: string): void {
    this.spaceMetrics.delete(spaceId)
  }

  // --- Implementation tag ---

  setImpl(impl: ImplTag): void {
    this.impl = impl
  }

  // --- Debug API ---

  getSnapshot(): DebugSnapshot {
    const samples = this.blockedUiSamples
    const avg = samples.length > 0 ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0
    const max = samples.length > 0 ? Math.max(...samples) : 0
    const last = samples.length > 0 ? samples[samples.length - 1] : 0

    return {
      impl: this.impl,
      persistence: {
        lastLoad: this.lastLoad,
        saves: {
          compactStore: { ...this.compactStoreSaves },
          vault: { ...this.vaultSaves },
        },
        migration: this.migration,
        errors: [...this.errors],
      },
      spaces: Array.from(this.spaceMetrics.values()).map(s => ({ ...s })),
      sync: {
        relay: {
          connected: this._relayConnected,
          url: this._relayUrl,
          peers: this._relayPeers,
          lastMessage: this._relayLastMessage,
        },
      },
      automerge: {
        saveBlockedUiMs: { last, avg, max },
        docSizeBytes: this._docSizeBytes,
        docStats: {
          contacts: this._docContacts,
          attestations: this._docAttestations,
          spaces: this._docSpaces,
        },
      },
      legacy: {
        idbChunkCount: this._idbChunkCount,
        healthCheckResult: this._healthCheckResult,
        findDurationMs: this._findDurationMs,
        flushDurationMs: this._flushDurationMs,
      },
    }
  }
}

// --- Singleton ---

let metricsInstance: PersistenceMetrics | null = null

export function getMetrics(): PersistenceMetrics {
  if (!metricsInstance) {
    metricsInstance = new PersistenceMetrics('legacy')
  }
  return metricsInstance
}

/**
 * Register window.wotDebug() — always available, not sensitive data.
 */
export function registerDebugApi(metrics: PersistenceMetrics): void {
  if (typeof window !== 'undefined') {
    ;(window as any).wotDebug = () => metrics.getSnapshot()
  }
}
