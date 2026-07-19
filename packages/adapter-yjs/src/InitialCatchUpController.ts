/**
 * Explicit lifecycle for the single initial/reconnect catch-up flight of the
 * Personal-Doc log sync (Sync 002 VE-2/VE-4).
 *
 * The controller replaces the previous implicit state machine in
 * YjsPersonalLogSyncAdapter (in-flight promise + timer + resolver + pending
 * flag + generation counter) with one explicit state and one cancellation
 * concept:
 *
 * - Exactly ONE controller instance exists per adapter lifecycle. destroy()
 *   disposes it; a restart builds a NEW controller. A disposed controller does
 *   nothing, ever — there is no cross-lifecycle state to guard, and a flight
 *   that hangs inside catchUp() is simply detached (its owner is disposed, so
 *   every action after an await boundary is a no-op).
 * - `request()` is the only entry point (initial start and reconnect share the
 *   single-flight rule); `dispose()` is the only cancellation.
 */

/** Coordinator surface the controller drives (engine-neutral). */
export interface InitialCatchUpDeps {
  catchUp(): Promise<unknown>
  resendPending(): Promise<void>
  /** Reconnect = new socket = empty broker scope cache → re-present required. */
  resetForReconnect(): void
  /** Adapter started AND transport connected. */
  isReady(): boolean
  onError(context: string, err: unknown): void
}

type ControllerState = 'idle' | 'running' | 'backing-off' | 'disposed'

export class InitialCatchUpController {
  private state: ControllerState = 'idle'
  /** A reconnect observed while a flight runs, drained after it settles. */
  private rerunRequested = false
  private backoffTimer: ReturnType<typeof setTimeout> | null = null
  private backoffResolve: (() => void) | null = null

  constructor(
    private readonly deps: InitialCatchUpDeps,
    private readonly backoffMs: readonly number[] = [0, 25, 75],
  ) {}

  /**
   * Request a catch-up flight. While one is running, a reconnect request is
   * remembered and drained after the flight settles (single-flight; a plain
   * re-request is deduplicated).
   */
  request(reconnect: boolean): void {
    if (this.state === 'disposed') return
    if (this.state !== 'idle') {
      this.rerunRequested ||= reconnect
      return
    }
    if (reconnect) this.deps.resetForReconnect()
    void this.runFlight().catch(() => {})
  }

  /**
   * Terminal: resolves a waiting backoff, detaches a flight hanging inside
   * catchUp() (it becomes a no-op past its next await boundary), and rejects
   * all future requests. Irreversible — a restart builds a new controller.
   */
  dispose(): void {
    this.state = 'disposed'
    this.rerunRequested = false
    if (this.backoffTimer) clearTimeout(this.backoffTimer)
    this.backoffTimer = null
    const resolvePending = this.backoffResolve
    this.backoffResolve = null
    resolvePending?.()
  }

  private async runFlight(): Promise<void> {
    this.state = 'running'
    await this.runAttempts()
    if (this.state === 'disposed') return
    this.state = 'idle'
    if (this.rerunRequested && this.deps.isReady()) {
      this.rerunRequested = false
      this.request(true)
    }
  }

  /** Bounded, ready-only attempts with increasing backoff. */
  private async runAttempts(): Promise<void> {
    for (let attempt = 0; attempt < this.backoffMs.length; attempt += 1) {
      if (this.state === 'disposed' || !this.deps.isReady()) return
      if (attempt > 0) {
        await this.waitBackoff(this.backoffMs[attempt])
        if (this.state === 'disposed' || !this.deps.isReady()) return
      }
      this.state = 'running'
      try {
        const result = await this.deps.catchUp()
        if (this.state === 'disposed') return
        // Ein aufgelöstes, aber unvollständiges Ergebnis ist KEIN Erfolg:
        // 'timeout' ist innerhalb des Backoffs erneut zu versuchen;
        // 'gap-pending'/'blocked-by-key' haben eigene Recovery-Pfade und
        // dürfen hier nicht kurzschleifen.
        const incomplete = result as { complete?: boolean; incomplete?: string } | undefined
        if (incomplete && incomplete.complete === false) {
          if (incomplete.incomplete === 'timeout') continue
          return
        }
        await this.deps.resendPending()
        return
      } catch (err) {
        this.deps.onError(attempt === 0 ? 'initial catch-up' : 'initial catch-up retry', err)
      }
    }
  }

  private async waitBackoff(delayMs: number): Promise<void> {
    this.state = 'backing-off'
    await new Promise<void>((resolve) => {
      // dispose() muss den wartenden Backoff AUFLÖSEN (nicht nur den Timer
      // löschen) — sonst bliebe der Flight ewig pending.
      this.backoffResolve = resolve
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null
        this.backoffResolve = null
        resolve()
      }, delayMs)
    })
  }
}
