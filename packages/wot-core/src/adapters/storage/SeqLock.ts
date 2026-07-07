/**
 * SeqLock — the cross-tab atomicity boundary for log-entry seq reservation
 * (Sync 002 Z.108). It serializes the read-max-seq → build → persist critical
 * section so two writers can never reserve the same seq=k (which would reuse
 * the deterministic AES-GCM nonce nonce(deviceId, k); see DocLogStore).
 *
 * The lock — NOT the IndexedDB transaction — is the atomicity boundary, because
 * an IDB transaction does not survive the `await` over the async crypto build()
 * phase (it auto-closes on the next microtask).
 *
 * Two implementations:
 *  - {@link WebLocksSeqLock}: backed by the Web Locks API (navigator.locks),
 *    which serializes across ALL same-origin tabs/workers. Use whenever the API
 *    is available (real browsers, the demo, Android WebView).
 *  - {@link InProcessSeqLock}: a per-key promise-chain mutex, serializing only
 *    within a single JS context. Fallback when Web Locks is absent (e.g. the
 *    happy-dom test environment, Node without the API).
 *
 * Pick one at runtime with {@link createSeqLock}: Web Locks if present, else
 * in-process.
 */
export interface SeqLock {
  /**
   * Run `fn` while holding an exclusive lock on `key`. Concurrent calls for the
   * same key are serialized; different keys may run in parallel. The lock is
   * released when the returned promise settles (resolve OR reject).
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
}

/** Minimal structural view of the Web Locks API we depend on. */
interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: 'exclusive' | 'shared' },
    callback: () => Promise<T>,
  ): Promise<T>
}

/** Read navigator.locks without assuming a DOM lib, returning undefined if absent. */
function getNavigatorLocks(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: unknown } }).navigator
  const locks = nav?.locks as LockManagerLike | undefined
  return locks && typeof locks.request === 'function' ? locks : undefined
}

/** True when the Web Locks API is available in this context. */
export function hasWebLocks(): boolean {
  return getNavigatorLocks() !== undefined
}

/**
 * Cross-tab lock backed by the Web Locks API. navigator.locks.request with
 * mode:'exclusive' holds the named lock for the lifetime of the async callback,
 * serializing every same-origin tab/worker — the real cross-tab guarantee.
 */
export class WebLocksSeqLock implements SeqLock {
  private readonly locks: LockManagerLike

  constructor(locks?: LockManagerLike) {
    const resolved = locks ?? getNavigatorLocks()
    if (!resolved) {
      throw new Error('WebLocksSeqLock requires navigator.locks (Web Locks API)')
    }
    this.locks = resolved
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.request(key, { mode: 'exclusive' }, fn)
  }
}

/**
 * In-process per-key mutex via a promise chain. Each key keeps a tail promise;
 * a new caller awaits the current tail before running, then becomes the new
 * tail. Serializes within one JS context only (no cross-tab guarantee) — the
 * fallback for environments without Web Locks.
 */
export class InProcessSeqLock implements SeqLock {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    // Chain on the prior tail, swallowing its result/error so one caller's
    // failure does not poison (or unblock with an error) the next waiter.
    const gate = previous.then(
      () => undefined,
      () => undefined,
    )
    const result = gate.then(() => fn())
    // The tail tracks completion only (never the value/rejection of fn).
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, tail)
    // Drop the key once we are the last waiter, to avoid unbounded growth.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}

/**
 * Select a SeqLock for the current runtime: Web Locks if available (cross-tab
 * safe), otherwise the in-process fallback. The in-process path is what the
 * happy-dom tests exercise by default; the Web Locks path is tested separately
 * with a mocked navigator.locks.
 */
export function createSeqLock(): SeqLock {
  return hasWebLocks() ? new WebLocksSeqLock() : new InProcessSeqLock()
}
