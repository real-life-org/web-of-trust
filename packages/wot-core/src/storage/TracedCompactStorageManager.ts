/**
 * TracedCompactStorageManager — Decorator that wraps CompactStorageManager
 * and logs all operations to the TraceLog.
 *
 * Usage:
 *   const inner = new CompactStorageManager('wot-compact-store')
 *   const traced = new TracedCompactStorageManager(inner)
 *   await traced.open()
 *   await traced.save(docId, binary) // → traced in TraceLog
 */

import { CompactStorageManager } from './CompactStorageManager'
import { getTraceLog } from './TraceLog'

export class TracedCompactStorageManager {
  constructor(private inner: CompactStorageManager) {}

  async open(): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      await this.inner.open()
      trace.log({
        store: 'compact-store',
        operation: 'connect',
        label: 'open IndexedDB',
        durationMs: Math.round(performance.now() - start),
        success: true,
      })
    } catch (err) {
      trace.log({
        store: 'compact-store',
        operation: 'connect',
        label: 'open IndexedDB',
        durationMs: Math.round(performance.now() - start),
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  async save(docId: string, binary: Uint8Array): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      await this.inner.save(docId, binary)
      trace.log({
        store: 'compact-store',
        operation: 'write',
        label: `save ${docId.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - start),
        sizeBytes: binary.byteLength,
        success: true,
        meta: { docId },
      })
    } catch (err) {
      trace.log({
        store: 'compact-store',
        operation: 'write',
        label: `save ${docId.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - start),
        sizeBytes: binary.byteLength,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        meta: { docId },
      })
      throw err
    }
  }

  async load(docId: string): Promise<Uint8Array | null> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const result = await this.inner.load(docId)
      trace.log({
        store: 'compact-store',
        operation: 'read',
        label: `load ${docId.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - start),
        sizeBytes: result?.byteLength,
        success: true,
        meta: { docId, found: result !== null },
      })
      return result
    } catch (err) {
      trace.log({
        store: 'compact-store',
        operation: 'read',
        label: `load ${docId.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - start),
        success: false,
        error: err instanceof Error ? err.message : String(err),
        meta: { docId },
      })
      throw err
    }
  }

  async delete(docId: string): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      await this.inner.delete(docId)
      trace.log({
        store: 'compact-store',
        operation: 'delete',
        label: `delete ${docId.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - start),
        success: true,
        meta: { docId },
      })
    } catch (err) {
      trace.log({
        store: 'compact-store',
        operation: 'delete',
        label: `delete ${docId.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - start),
        success: false,
        error: err instanceof Error ? err.message : String(err),
        meta: { docId },
      })
      throw err
    }
  }

  async list(): Promise<string[]> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const result = await this.inner.list()
      trace.log({
        store: 'compact-store',
        operation: 'read',
        label: 'list all docs',
        durationMs: Math.round(performance.now() - start),
        success: true,
        meta: { count: result.length },
      })
      return result
    } catch (err) {
      trace.log({
        store: 'compact-store',
        operation: 'read',
        label: 'list all docs',
        durationMs: Math.round(performance.now() - start),
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  close(): void {
    this.inner.close()
    getTraceLog().log({
      store: 'compact-store',
      operation: 'disconnect',
      label: 'close IndexedDB',
      durationMs: 0,
      success: true,
    })
  }
}
