/**
 * VaultPushScheduler — Immediate vs. debounced persistence scheduling.
 *
 * Two modes:
 * - pushImmediate(): Explicit user actions (profile save, task create, contact add).
 *   Pushes right away, deduplicates via Automerge.getHeads() comparison.
 * - pushDebounced(): Streaming changes (collaborative text editing) or remote sync.
 *   Waits for a pause before pushing.
 *
 * In-flight deduplication: If a push is already running and another comes in,
 * at most one additional push is queued (not N).
 *
 * Lifecycle: Registers visibilitychange + beforeunload to flush pending work
 * when the user leaves the tab.
 */

export interface VaultPushSchedulerConfig {
  /** The actual push function (encrypt + HTTP). */
  pushFn: () => Promise<void>
  /** Returns a string representing current doc state (Automerge.getHeads().join(',')). Null = no doc yet. */
  getHeadsFn: () => string | null
  /** Debounce delay in ms. Default: 5000. */
  debounceMs?: number
}

export class VaultPushScheduler {
  private pushFn: () => Promise<void>
  private getHeadsFn: () => string | null
  private debounceMs: number

  private lastPushedHeads: string | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pushing = false
  private pendingAfterPush = false
  private destroyed = false

  private onVisibilityChange: (() => void) | null = null
  private onBeforeUnload: (() => void) | null = null

  constructor(config: VaultPushSchedulerConfig) {
    this.pushFn = config.pushFn
    this.getHeadsFn = config.getHeadsFn
    this.debounceMs = config.debounceMs ?? 5000

    // Lifecycle handlers — flush on tab hide / close
    if (typeof document !== 'undefined') {
      this.onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
          this.flush()
        }
      }
      document.addEventListener('visibilitychange', this.onVisibilityChange)
    }

    if (typeof window !== 'undefined') {
      this.onBeforeUnload = () => {
        this.flush()
      }
      window.addEventListener('beforeunload', this.onBeforeUnload)
    }
  }

  /** Set initial heads (e.g. after loading from vault — vault already has this state). */
  setLastPushedHeads(heads: string | null): void {
    this.lastPushedHeads = heads
  }

  /** Explicit user action — push immediately (deduplicated). */
  pushImmediate(): void {
    if (this.destroyed) return
    this.clearDebounce()
    this.schedulePush()
  }

  /** Streaming / remote sync — push after debounce delay. */
  pushDebounced(): void {
    if (this.destroyed) return
    this.clearDebounce()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.schedulePush()
    }, this.debounceMs)
  }

  /** Flush any pending debounced push immediately (lifecycle events). */
  flush(): void {
    if (this.destroyed) return
    if (this.debounceTimer) {
      this.clearDebounce()
      this.schedulePush()
    }
  }

  /** Clean up timers and lifecycle handlers. */
  destroy(): void {
    this.destroyed = true
    this.clearDebounce()

    if (this.onVisibilityChange && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
      this.onVisibilityChange = null
    }
    if (this.onBeforeUnload && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.onBeforeUnload)
      this.onBeforeUnload = null
    }
  }

  // --- Private ---

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private schedulePush(): void {
    if (this.pushing) {
      // Already pushing — queue at most one follow-up
      this.pendingAfterPush = true
      return
    }

    // Dirty check — skip if heads haven't changed
    const currentHeads = this.getHeadsFn()
    if (currentHeads !== null && currentHeads === this.lastPushedHeads) {
      return
    }

    this.pushing = true
    this.pushFn()
      .then(() => {
        // Mark as pushed — read heads again (push may have been slow, doc may have changed)
        this.lastPushedHeads = this.getHeadsFn()
      })
      .catch(() => {
        // Push failed — don't update lastPushedHeads so next attempt retries
      })
      .finally(() => {
        this.pushing = false
        if (this.pendingAfterPush && !this.destroyed) {
          this.pendingAfterPush = false
          this.schedulePush()
        }
      })
  }
}
