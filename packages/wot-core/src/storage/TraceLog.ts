/**
 * TraceLog — Central tracing system for all store operations.
 *
 * Ring buffer of 1000 entries in memory, persisted asynchronously to IndexedDB.
 * Allows developers to see the full data flow: which stores are accessed,
 * in what order, with what timing and result.
 *
 * Usage:
 *   import { getTraceLog } from '@real-life/wot-core'
 *   const trace = getTraceLog()
 *   trace.log({ store: 'compact-store', operation: 'write', label: 'save personal-doc', durationMs: 12, sizeBytes: 4096, success: true })
 *   trace.subscribe(entries => console.log('new trace:', entries))
 *   window.wotTrace() // → TraceEntry[]
 */

export type TraceStore = 'compact-store' | 'relay' | 'vault' | 'profiles' | 'outbox' | 'personal-doc' | 'crdt' | 'crypto'
export type TraceOp = 'read' | 'write' | 'send' | 'receive' | 'sync' | 'delete' | 'flush' | 'error' | 'connect' | 'disconnect'

export interface TraceEntry {
  id: number
  timestamp: string
  store: TraceStore
  operation: TraceOp
  label: string
  durationMs: number
  sizeBytes?: number
  success: boolean
  error?: string
  meta?: Record<string, unknown>
}

export type TraceFilter = {
  store?: TraceStore
  operation?: TraceOp
  success?: boolean
  since?: string
  limit?: number
}

type TraceSubscriber = (entry: TraceEntry) => void

const MAX_ENTRIES = 1000
const IDB_NAME = 'wot-trace-log'
const IDB_STORE = 'traces'
const FLUSH_INTERVAL_MS = 500

export class TraceLog {
  private entries: TraceEntry[] = []
  private nextId = 1
  private subscribers = new Set<TraceSubscriber>()
  private db: IDBDatabase | null = null
  private pendingWrites: TraceEntry[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private initialized = false

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    if (typeof indexedDB === 'undefined') return

    try {
      this.db = await this.openDb()
      const stored = await this.loadFromDb()
      if (stored.length > 0) {
        this.entries = stored.slice(-MAX_ENTRIES)
        this.nextId = Math.max(...this.entries.map(e => e.id)) + 1
      }
      this.startFlushTimer()
    } catch (err) {
      console.warn('[TraceLog] IndexedDB init failed, running in-memory only:', err)
    }
  }

  log(entry: Omit<TraceEntry, 'id' | 'timestamp'>): TraceEntry {
    const full: TraceEntry = {
      ...entry,
      id: this.nextId++,
      timestamp: new Date().toISOString(),
    }

    this.entries.push(full)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift()
    }

    this.pendingWrites.push(full)
    this.notifySubscribers(full)

    return full
  }

  getAll(filter?: TraceFilter): TraceEntry[] {
    let result = [...this.entries]

    if (filter?.store) {
      result = result.filter(e => e.store === filter.store)
    }
    if (filter?.operation) {
      result = result.filter(e => e.operation === filter.operation)
    }
    if (filter?.success !== undefined) {
      result = result.filter(e => e.success === filter.success)
    }
    if (filter?.since) {
      result = result.filter(e => e.timestamp >= filter.since!)
    }
    if (filter?.limit) {
      result = result.slice(-filter.limit)
    }

    return result
  }

  getLatest(count: number = 50): TraceEntry[] {
    return this.entries.slice(-count)
  }

  getErrors(count: number = 20): TraceEntry[] {
    return this.entries.filter(e => !e.success).slice(-count)
  }

  getByStore(store: TraceStore): TraceEntry[] {
    return this.entries.filter(e => e.store === store)
  }

  getPerformanceSummary(): Record<string, { count: number; avgMs: number; p95Ms: number; maxMs: number }> {
    const groups = new Map<string, number[]>()

    for (const entry of this.entries) {
      if (!entry.success) continue
      const key = `${entry.store}:${entry.operation}`
      let arr = groups.get(key)
      if (!arr) {
        arr = []
        groups.set(key, arr)
      }
      arr.push(entry.durationMs)
    }

    const result: Record<string, { count: number; avgMs: number; p95Ms: number; maxMs: number }> = {}

    for (const [key, durations] of groups) {
      const sorted = [...durations].sort((a, b) => a - b)
      const count = sorted.length
      const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / count)
      const p95 = sorted[Math.floor(count * 0.95)] ?? sorted[count - 1]
      const max = sorted[count - 1]
      result[key] = { count, avgMs: avg, p95Ms: p95, maxMs: max }
    }

    return result
  }

  subscribe(callback: TraceSubscriber): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  clear(): void {
    this.entries = []
    this.pendingWrites = []
    if (this.db) {
      try {
        const tx = this.db.transaction(IDB_STORE, 'readwrite')
        tx.objectStore(IDB_STORE).clear()
      } catch { /* ignore */ }
    }
  }

  get size(): number {
    return this.entries.length
  }

  // --- Private ---

  private notifySubscribers(entry: TraceEntry): void {
    for (const sub of this.subscribers) {
      try {
        sub(entry)
      } catch { /* ignore subscriber errors */ }
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => this.flushToDb(), FLUSH_INTERVAL_MS)
  }

  private async flushToDb(): Promise<void> {
    if (!this.db || this.pendingWrites.length === 0) return

    const batch = this.pendingWrites.splice(0)

    try {
      const tx = this.db.transaction(IDB_STORE, 'readwrite')
      const store = tx.objectStore(IDB_STORE)

      for (const entry of batch) {
        store.put(entry)
      }

      // Cleanup old entries beyond MAX_ENTRIES
      const countReq = store.count()
      countReq.onsuccess = () => {
        const total = countReq.result
        if (total > MAX_ENTRIES) {
          const deleteCount = total - MAX_ENTRIES
          const cursorReq = store.openCursor()
          let deleted = 0
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (cursor && deleted < deleteCount) {
              cursor.delete()
              deleted++
              cursor.continue()
            }
          }
        }
      }
    } catch (err) {
      console.warn('[TraceLog] flush to IDB failed:', err)
    }
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  private loadFromDb(): Promise<TraceEntry[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve([])
      try {
        const tx = this.db.transaction(IDB_STORE, 'readonly')
        const store = tx.objectStore(IDB_STORE)
        const req = store.getAll()
        req.onsuccess = () => resolve(req.result ?? [])
        req.onerror = () => reject(req.error)
      } catch {
        resolve([])
      }
    })
  }
}

// --- Singleton ---

let traceLogInstance: TraceLog | null = null

export function getTraceLog(): TraceLog {
  if (!traceLogInstance) {
    traceLogInstance = new TraceLog()
  }
  return traceLogInstance
}

/**
 * Convenience: time an async operation and log it.
 *
 * Usage:
 *   const data = await traceAsync('compact-store', 'read', 'load personal-doc', async () => {
 *     return await compactStore.load(docId)
 *   })
 */
export async function traceAsync<T>(
  store: TraceStore,
  operation: TraceOp,
  label: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  const trace = getTraceLog()
  const start = performance.now()
  try {
    const result = await fn()
    const durationMs = Math.round(performance.now() - start)
    const sizeBytes = result instanceof Uint8Array ? result.byteLength : undefined
    trace.log({ store, operation, label, durationMs, sizeBytes, success: true, meta })
    return result
  } catch (err) {
    const durationMs = Math.round(performance.now() - start)
    trace.log({
      store,
      operation,
      label,
      durationMs,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      meta,
    })
    throw err
  }
}

/**
 * Wrap fetch() to trace HTTP calls to Vault/Profiles servers.
 */
export function tracedFetch(
  store: TraceStore,
  label: string,
  url: string,
  init?: RequestInit,
  meta?: Record<string, unknown>,
): Promise<Response> {
  return traceAsync(store, init?.method === 'GET' ? 'read' : 'write', label, async () => {
    const response = await fetch(url, init)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    return response
  }, { url, method: init?.method ?? 'GET', ...meta })
}

/**
 * Register window.wotTrace() — always available, not sensitive data.
 */
export function registerTraceApi(traceLog: TraceLog): void {
  if (typeof window !== 'undefined') {
    ;(window as any).wotTrace = (filter?: TraceFilter) => traceLog.getAll(filter)
    ;(window as any).wotTracePerf = () => traceLog.getPerformanceSummary()
    ;(window as any).wotTraceClear = () => traceLog.clear()
  }
}
