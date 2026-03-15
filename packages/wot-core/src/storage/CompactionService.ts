/**
 * Compaction Service
 *
 * Offloads Automerge document compaction (history-stripping) from the main thread.
 * Uses `setTimeout(0)` chunking to yield to the browser between expensive operations,
 * keeping the UI responsive.
 *
 * Why not a Web Worker?
 * Automerge uses WASM, and WASM bundling in Web Workers requires complex build
 * configuration (vite-plugin-wasm doesn't propagate to worker builds). Since all
 * three operations (Automerge.load, JSON roundtrip, Automerge.from) need the same
 * WASM module, a Worker would need its own copy — doubling memory usage.
 * The yielding approach achieves the same UI responsiveness goal more simply.
 *
 * Usage:
 *   const service = CompactionService.getInstance()
 *   const compacted = await service.compact(binary)
 */
import * as Automerge from '@automerge/automerge'

export interface CompactionRequest {
  id: string
  binary: Uint8Array
}

export interface CompactionResponse {
  id: string
  compacted?: Uint8Array
  error?: string
}

export class CompactionService {
  private static instance: CompactionService | null = null

  private constructor() {}

  static getInstance(): CompactionService {
    if (!CompactionService.instance) {
      CompactionService.instance = new CompactionService()
    }
    return CompactionService.instance
  }

  /**
   * Compact an Automerge document binary (strip change history).
   * Yields to the browser between steps to keep the UI responsive.
   *
   * @param binary - Automerge.save() output (includes history)
   * @returns Compacted binary (history-free)
   */
  async compact(binary: Uint8Array): Promise<Uint8Array> {
    // Step 1: Load doc from binary
    const doc = Automerge.load<any>(binary)

    // Yield to browser (let pending UI updates, animations, input events run)
    await yieldToMain()

    // Step 2: JSON roundtrip to extract plain state
    const plain = JSON.parse(JSON.stringify(doc))

    await yieldToMain()

    // Step 3: Create history-free doc and serialize
    const compacted = Automerge.save(Automerge.from(plain))
    return compacted
  }

  /**
   * Whether the service is using a Web Worker (true) or main-thread with yielding (false).
   */
  get isUsingWorker(): boolean {
    return false
  }

  destroy(): void {
    CompactionService.instance = null
  }
}

/**
 * Yield to the main thread so the browser can process UI updates.
 * Uses scheduler.yield() if available (Chrome 115+), falls back to setTimeout.
 */
function yieldToMain(): Promise<void> {
  // scheduler.yield() is the modern API — gives back control and resumes with priority
  if (typeof globalThis !== 'undefined' && 'scheduler' in globalThis &&
      typeof (globalThis as any).scheduler?.yield === 'function') {
    return (globalThis as any).scheduler.yield()
  }
  // Fallback: setTimeout(0) moves to next macrotask
  return new Promise(resolve => setTimeout(resolve, 0))
}
