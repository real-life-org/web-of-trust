import type { MessagingAdapter, WireMessage } from '../../ports/MessagingAdapter'
import type { DeliveryReceipt, MessagingState } from '../../types/messaging'
import type { ControlFrame, ControlFrameReceipt } from '../../protocol/sync/control-frame-transport'
import { routeForEnvelope, type BrokerRoute } from './broker-routing-policy'

/**
 * Dual-/Multi-broker multiplexer (Stage A — Sync 003 §Broker-Zuordnung und
 * Multi-Broker: "Clients synchronisieren mit allen relevanten Brokern").
 *
 * Decorator over N inner MessagingAdapters (index 0 = PRIMARY, e.g. the festival
 * box; the rest are secondaries, e.g. the public server). Routing per envelope
 * via {@link routeForEnvelope}: the idempotent inbox family fans out to every
 * connected broker, EVERYTHING else goes strictly to the primary — spaces and
 * personal docs stay single-home in Stage A (I-PRIMARY-STRICT).
 *
 * Key invariants (Stage-A invariant model, session plan doc; the A.1/A.2 cut
 * — discovery-dual follows in A.2 — is documented in PR #251):
 *  - I-START-ANYWHERE: connect() settles on the FIRST child success (per-child
 *    timeout) so the app starts even when the box is gone (post-camp path).
 *  - I-CHILD-RECONNECT: the multiplexer runs its OWN per-broker reconnect loop.
 *    The outer OutboxMessagingAdapter's reconnect only fires on the AGGREGATE
 *    state — with "connected if ≥1" a dead primary would otherwise never be
 *    redialed while a secondary lives.
 *  - I-RECEIPT-MONOTON: per messageId, ok-receipts (accepted/delivered) pass
 *    through (idempotent upgrade for consumers); a child `failed` is suppressed
 *    once ANY ok was seen — a late partial failure must never regress consumer
 *    state (e.g. AttestationService resets to failed on any failed receipt).
 *  - I-SINGLE-OFF: with one child this class is a transparent pass-through; the
 *    demo only builds it when secondary URLs are configured.
 */
export class MultiBrokerMessagingAdapter implements MessagingAdapter {
  private readonly children: MessagingAdapter[]
  private readonly connectTimeoutMs: number
  private readonly reconnectIntervalMs: number
  private myDid: string | null = null
  private reconnectTimer: ReturnType<typeof setInterval> | null = null
  /** Per-child "a connect() call is in flight" guard (no dial pile-up). */
  private connecting: boolean[]
  private stateCallbacks = new Set<(state: MessagingState) => void>()
  private childStateUnsubs: Array<() => void> = []
  private lastAggregate: MessagingState = 'disconnected'
  /**
   * I-RECEIPT-MONOTON — per-message fanout aggregation. A fanout send registers
   * its messageId with the target count; child receipts are then aggregated:
   * ok passes through (and ends the tracking), a child `failed` is HELD until
   * either an ok arrives (drop the failure) or ALL targets failed (emit exactly
   * one failure). Non-tracked ids keep single-broker passthrough semantics.
   * Size-bounded FIFO against receipts that never turn terminal.
   */
  private fanoutTracker = new Map<string, { targets: number; failed: number; okSeen: boolean }>()
  private static readonly TRACKER_MAX = 256

  /**
   * VE-9/VE-11 passthroughs — bound ONLY when the PRIMARY supports them, so the
   * LogSyncCoordinator's feature detection reflects the primary transport
   * exactly (I-PRIMARY-STRICT).
   */
  sendControlFrame?: (frame: ControlFrame) => Promise<ControlFrameReceipt>
  rebindDeviceId?: (newDeviceId: string) => Promise<void>

  constructor(
    children: MessagingAdapter[],
    options?: {
      /** Per-child connect timeout (ms) before the child is left to the reconnect loop. Default 8000. */
      connectTimeoutMs?: number
      /** Per-child reconnect interval (ms). 0 disables. Default 10000. */
      reconnectIntervalMs?: number
    },
  ) {
    if (children.length === 0) throw new Error('MultiBrokerMessagingAdapter: need at least one child')
    this.children = children
    this.connecting = children.map(() => false)
    this.connectTimeoutMs = options?.connectTimeoutMs ?? 8_000
    this.reconnectIntervalMs = options?.reconnectIntervalMs ?? 10_000

    const primary = children[0]
    if (typeof primary.sendControlFrame === 'function') {
      this.sendControlFrame = (frame) => primary.sendControlFrame!(frame)
    }
    if (typeof primary.rebindDeviceId === 'function') {
      this.rebindDeviceId = (newDeviceId) => primary.rebindDeviceId!(newDeviceId)
    }

    // Aggregate state: recompute on every child transition, notify on CHANGE.
    for (const child of children) {
      this.childStateUnsubs.push(
        child.onStateChange(() => this.notifyAggregate()),
      )
    }
  }

  // --- Connection lifecycle ---

  /**
   * Connect all children in parallel; resolve on the FIRST success
   * (I-START-ANYWHERE), reject only if EVERY child fails/times out within its
   * per-child window. Children that fail here are picked up by the reconnect
   * loop. Idempotent + partial: already-connected children are skipped.
   */
  async connect(myDid: string): Promise<void> {
    this.myDid = myDid
    this.startReconnectLoop()

    // Idempotent + partial (I-START-ANYWHERE): skip children that are already
    // connected OR currently dialing (in-flight guard) — a second connect()
    // (the demo init calls messagingRoot.connect early and outbox.connect later)
    // must never throw while the aggregate is fine.
    const attempts = this.children
      .map((child, i) => ({ child, i }))
      .filter(({ child, i }) => child.getState() !== 'connected' && !this.connecting[i] && child.getState() !== 'connecting')
      .map(({ child, i }) => this.dialChild(child, i, myDid))

    if (attempts.length === 0) {
      if (this.getState() === 'connected') return // aggregate already carried
      // Everything is in flight — await the aggregate instead of double-dialing.
      return this.awaitAggregateConnected()
    }

    // First success wins; if all settle without success, throw the first error —
    // UNLESS another in-flight dial (skipped above) carried the aggregate.
    return new Promise<void>((resolve, reject) => {
      let pending = attempts.length
      let firstError: unknown = null
      let settled = false
      for (const attempt of attempts) {
        attempt.then(
          () => {
            if (!settled) { settled = true; resolve() }
          },
          (err) => {
            firstError ??= err
            pending -= 1
            if (pending === 0 && !settled) {
              settled = true
              if (this.getState() === 'connected') { resolve(); return }
              reject(firstError instanceof Error ? firstError : new Error(String(firstError)))
            }
          },
        )
      }
    })
  }

  /** Resolve when the aggregate reaches 'connected' within the connect timeout. */
  private awaitAggregateConnected(): Promise<void> {
    if (this.getState() === 'connected') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub()
        reject(new Error(`no broker reached 'connected' within ${this.connectTimeoutMs}ms`))
      }, Math.max(this.connectTimeoutMs, 1))
      const unsub = this.onStateChange((state) => {
        if (state === 'connected') { clearTimeout(timer); unsub(); resolve() }
      })
    })
  }

  /** Dial one child with a timeout; on timeout, leave it to the reconnect loop. */
  private async dialChild(child: MessagingAdapter, index: number, did: string): Promise<void> {
    if (this.connecting[index]) throw new Error('connect already in flight')
    this.connecting[index] = true
    try {
      if (this.connectTimeoutMs <= 0) {
        await child.connect(did)
        return
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          // The child's own connect has no abort — force it back to a state the
          // reconnect loop handles ('connecting' would be invisible to it) by
          // tearing the socket down. Best-effort; the loop redials next tick.
          void child.disconnect().catch(() => {})
          reject(new Error(`broker[${index}] connect timeout after ${this.connectTimeoutMs}ms`))
        }, this.connectTimeoutMs)
        child.connect(did).then(
          () => { clearTimeout(timer); resolve() },
          (err) => { clearTimeout(timer); reject(err) },
        )
      })
    } finally {
      this.connecting[index] = false
      this.notifyAggregate()
    }
  }

  /**
   * I-CHILD-RECONNECT: redial every disconnected/errored child on an interval —
   * independent of the aggregate state, so a dead primary keeps being redialed
   * while a secondary carries the connection.
   */
  private startReconnectLoop(): void {
    if (this.reconnectIntervalMs <= 0 || this.reconnectTimer) return
    this.reconnectTimer = setInterval(() => {
      if (!this.myDid) return
      this.children.forEach((child, i) => {
        const state = child.getState()
        if ((state === 'disconnected' || state === 'error') && !this.connecting[i]) {
          this.dialChild(child, i, this.myDid!).catch(() => {
            // stays in the loop; next tick retries
          })
        }
      })
    }, this.reconnectIntervalMs)
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer)
      this.reconnectTimer = null
    }
    await Promise.allSettled(this.children.map((c) => c.disconnect()))
    this.notifyAggregate()
  }

  // --- Aggregate state (I-UI-TRUTH) ---

  getState(): MessagingState {
    const states = this.children.map((c) => c.getState())
    if (states.includes('connected')) return 'connected'
    if (states.includes('connecting')) return 'connecting'
    return states[0] // primary's word for the rest (disconnected/error)
  }

  /** Per-broker view for debug/D2 (primary first). */
  getBrokerStates(): MessagingState[] {
    return this.children.map((c) => c.getState())
  }

  onStateChange(callback: (state: MessagingState) => void): () => void {
    this.stateCallbacks.add(callback)
    return () => this.stateCallbacks.delete(callback)
  }

  private notifyAggregate(): void {
    const aggregate = this.getState()
    if (aggregate === this.lastAggregate) return
    this.lastAggregate = aggregate
    for (const cb of this.stateCallbacks) {
      try { cb(aggregate) } catch { /* subscriber errors are not ours */ }
    }
  }

  // --- Sending ---

  async send(envelope: WireMessage): Promise<DeliveryReceipt> {
    const route: BrokerRoute = routeForEnvelope(envelope)
    if (route === 'primary' || this.children.length === 1) {
      return this.children[0].send(envelope)
    }

    // fanout: all CONNECTED children in parallel. Success = first
    // accepted/delivered receipt (I-BEST-EFFORT-TX). A child resolving with a
    // 'failed' receipt (#245 write-path semantics) is NOT a success. If no child
    // succeeds: prefer returning a failed receipt over throwing only when one
    // exists; otherwise reject like the single-broker case (the outbox above
    // catches and queues).
    const targets = this.children.filter((c) => c.getState() === 'connected')
    if (targets.length === 0) return this.children[0].send(envelope) // throws like single (outbox queues)

    const messageId = (envelope as { id?: string }).id
    if (messageId) this.trackFanout(messageId, targets.length)

    return new Promise<DeliveryReceipt>((resolve, reject) => {
      let pending = targets.length
      let settled = false
      let lastFailed: DeliveryReceipt | null = null
      let firstError: unknown = null
      const settleOne = (receipt: DeliveryReceipt | null, err?: unknown) => {
        if (receipt && (receipt.status === 'accepted' || receipt.status === 'delivered')) {
          this.markFanoutOk(receipt.messageId)
          if (!settled) { settled = true; resolve(receipt) }
          return
        }
        if (receipt) lastFailed = receipt
        if (err !== undefined) firstError ??= err
        pending -= 1
        if (pending === 0 && !settled) {
          settled = true
          if (lastFailed) resolve(lastFailed)
          else reject(firstError instanceof Error ? firstError : new Error(String(firstError)))
        }
      }
      for (const target of targets) {
        target.send(envelope).then(
          (receipt) => settleOne(receipt),
          (err) => settleOne(null, err),
        )
      }
    })
  }

  // --- Receiving ---

  onMessage(callback: (envelope: WireMessage) => void | Promise<void>): () => void {
    // Register on EVERY child; dedup is the consumers' job and exists
    // (I-IDEMPOTENT-RX: durable MessageIdHistory + membership dedup stores).
    const unsubs = this.children.map((c) => c.onMessage(callback))
    return () => unsubs.forEach((u) => u())
  }

  onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void {
    // I-RECEIPT-MONOTON via per-message aggregation: for a tracked fanout id,
    // ok passes through; a child 'failed' is HELD until either an ok arrives
    // (drop it) or ALL targets failed (emit exactly one failure). Untracked ids
    // keep single-broker passthrough.
    const wrapped = (receipt: DeliveryReceipt) => {
      const entry = this.fanoutTracker.get(receipt.messageId)
      if (receipt.status === 'accepted' || receipt.status === 'delivered') {
        if (entry) entry.okSeen = true
        callback(receipt)
        return
      }
      if (!entry) { callback(receipt); return } // untracked → single semantics
      if (entry.okSeen) return // late partial failure — swallow
      entry.failed += 1
      if (entry.failed >= entry.targets) {
        this.fanoutTracker.delete(receipt.messageId)
        callback(receipt) // ALL targets failed — exactly one visible failure
      }
      // else: hold — another target may still succeed
    }
    const unsubs = this.children.map((c) => c.onReceipt(wrapped))
    return () => unsubs.forEach((u) => u())
  }

  private trackFanout(messageId: string, targets: number): void {
    this.fanoutTracker.set(messageId, { targets, failed: 0, okSeen: false })
    if (this.fanoutTracker.size > MultiBrokerMessagingAdapter.TRACKER_MAX) {
      const oldest = this.fanoutTracker.keys().next().value
      if (oldest !== undefined) this.fanoutTracker.delete(oldest)
    }
  }

  private markFanoutOk(messageId: string): void {
    const entry = this.fanoutTracker.get(messageId)
    if (entry) entry.okSeen = true
  }

  // --- Transport resolution (Old-World channel → primary-only) ---

  async registerTransport(did: string, transportAddress: string): Promise<void> {
    return this.children[0].registerTransport(did, transportAddress)
  }

  async resolveTransport(did: string): Promise<string | null> {
    return this.children[0].resolveTransport(did)
  }
}
