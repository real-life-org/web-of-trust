import type { MessagingAdapter, WireMessage } from '../../ports/MessagingAdapter'
import type { OutboxStore } from '../../ports/OutboxStore'
import type {
  DeliveryReceipt,
  MessagingState,
} from '../../types/messaging'
import { SPACE_SYNC_REQUEST_MESSAGE_TYPE } from '../../types/messaging'
import type { ControlFrame, ControlFrameReceipt } from '../../protocol/sync/control-frame-transport'
import { LOG_ENTRY_MESSAGE_TYPE } from '../../protocol/sync/log-entry'
import { SYNC_REQUEST_MESSAGE_TYPE } from '../../protocol/sync/sync-messages'

/**
 * #236 (I-AUTH / I-NQ): protocol-constant NEVER-QUEUE set — NOT a per-site option
 * like `skipTypes`, because it encodes an invariant, not a site preference: for
 * these types there is exactly ONE retry authority and it is NOT this outbox.
 *
 *  - log-entry/1.0: the LogSyncCoordinator owns delivery (durable logStore pending
 *    + resendPending with capability/generation semantics). An outbox flush resend
 *    has no capability context, so it can only ever produce CAPABILITY_REQUIRED →
 *    receipt-timeout → retry churn, while the entry ALSO stays (or worse, stops
 *    being) pending in the log store — the #236 orphan/data-loss window.
 *  - sync-request/1.0: one-way; the relay never answers it with a receipt. The
 *    coordinator's pending-sync-request waiter + the reconnect re-request paths
 *    are the authority; a queued copy is undeliverable noise.
 *  - space-sync-request (Old World): not relay/queue-eligible (Sync 003 whitelist)
 *    → error without receipt → guaranteed orphan. Its retry is the adapter's own
 *    requestSync trigger.
 *
 * These types leave the outbox ONLY via dequeue (lazy drain in flushOutbox), never
 * via send.
 */
const NEVER_QUEUE_TYPES: ReadonlySet<string> = new Set([
  LOG_ENTRY_MESSAGE_TYPE,
  SYNC_REQUEST_MESSAGE_TYPE,
  SPACE_SYNC_REQUEST_MESSAGE_TYPE,
])

/**
 * Offline-first wrapper for any MessagingAdapter.
 *
 * Decorator pattern (like OfflineFirstDiscoveryAdapter):
 * - Wraps an inner MessagingAdapter
 * - Persists unsent messages in an OutboxStore
 * - Retries on reconnect via flushOutbox()
 * - send() never throws for queued message types
 *
 * Usage:
 *   const ws = new WebSocketMessagingAdapter(url)
 *   const outboxStore = new EvoluOutboxStore(evolu)
 *   const messaging = new OutboxMessagingAdapter(ws, outboxStore)
 */
export class OutboxMessagingAdapter implements MessagingAdapter {
  private flushing = false
  // VE-8: skip-Werte decken beide Familien ab (Old-World-Strings + Type-URIs).
  private skipTypes: Set<string>
  private sendTimeoutMs: number
  private reconnectIntervalMs: number
  private maxRetries: number
  private isOnline: () => boolean
  private reconnectTimer: ReturnType<typeof setInterval> | null = null
  private myDid: string | null = null
  private unsubscribeStateChange: (() => void) | null = null

  /**
   * VE-9/VE-11 control-frame passthrough (Durable Wiring / VE-DW8). The log-sync
   * L1 gate feature-detects `typeof messaging.sendControlFrame === 'function'`, so
   * this wrapper must forward the method — otherwise wrapping a control-frame-
   * capable transport (WebSocketMessagingAdapter) in the outbox silently disables
   * log sync. Control frames are NOT outbox-queued envelopes (they are closed
   * top-level frames with their own receipt), so they bypass the outbox and go
   * straight to the inner adapter. Bound ONLY when the inner adapter supports
   * control frames, so the gate stays an accurate reflection of the wrapped
   * transport (an inner mock without control frames keeps this undefined).
   */
  sendControlFrame?: (frame: ControlFrame) => Promise<ControlFrameReceipt>

  /**
   * VE-11 control-frame-adjacent passthrough: forward a deviceId re-bind to the
   * inner transport (fresh-socket re-register) so a restore-clone can re-register
   * its new deviceId. Bound only when the inner adapter supports it.
   */
  rebindDeviceId?: (newDeviceId: string) => Promise<void>

  constructor(
    private inner: MessagingAdapter,
    private outbox: OutboxStore,
    options?: {
      skipTypes?: readonly string[]
      sendTimeoutMs?: number
      /** Auto-reconnect interval in ms. Set to 0 to disable. Default: 10000 (10s). */
      reconnectIntervalMs?: number
      /** Max retries before dropping a message. Default: 50. */
      maxRetries?: number
      /** Optional online check. Default: always true. */
      isOnline?: () => boolean
    },
  ) {
    this.skipTypes = new Set(options?.skipTypes ?? ['profile-update'])
    this.sendTimeoutMs = options?.sendTimeoutMs ?? 15_000
    this.reconnectIntervalMs = options?.reconnectIntervalMs ?? 10_000
    this.maxRetries = options?.maxRetries ?? 50
    this.isOnline = options?.isOnline ?? (() => true)
    // Expose control-frame passthrough ONLY when the inner transport supports it,
    // so the L1 gate's feature-detection reflects the real wrapped transport.
    if (typeof this.inner.sendControlFrame === 'function') {
      this.sendControlFrame = (frame) => this.inner.sendControlFrame!(frame)
    }
    if (typeof this.inner.rebindDeviceId === 'function') {
      this.rebindDeviceId = (newDeviceId) => this.inner.rebindDeviceId!(newDeviceId)
    }
  }

  // --- Connection lifecycle: delegate to inner ---

  async connect(myDid: string): Promise<void> {
    this.myDid = myDid
    await this.inner.connect(myDid)
    // Fire-and-forget flush after successful connect
    this.flushOutbox()
    this._startAutoReconnect()
  }

  async disconnect(): Promise<void> {
    this._stopAutoReconnect()
    return this.inner.disconnect()
  }

  getState(): MessagingState {
    return this.inner.getState()
  }

  // --- Send with outbox ---

  async send(envelope: WireMessage): Promise<DeliveryReceipt> {
    // Skip outbox for non-critical types (fire-and-forget)
    if (this.skipTypes.has(envelope.type)) {
      return this.inner.send(envelope)
    }

    // #236 (I-NQ): log-sync types are NEVER queued — their retry authority is the
    // LogSyncCoordinator / requestSync path, not this outbox (see NEVER_QUEUE_TYPES).
    // Pass through directly; a disconnected transport THROWS to the caller (the
    // coordinator treats that as "entry stays pending", local-first by design).
    if (NEVER_QUEUE_TYPES.has(envelope.type)) {
      return this.inner.send(envelope)
    }

    // If not connected, queue immediately
    if (this.inner.getState() !== 'connected') {
      await this.outbox.enqueue(envelope)
      return {
        messageId: envelope.id,
        status: 'accepted',
        timestamp: new Date().toISOString(),
        reason: 'queued-in-outbox',
      }
    }

    // Connected — try to send with timeout
    try {
      return await this.sendWithTimeout(envelope)
    } catch {
      // Send failed — queue for retry
      await this.outbox.enqueue(envelope)
      return {
        messageId: envelope.id,
        status: 'accepted',
        timestamp: new Date().toISOString(),
        reason: 'queued-in-outbox',
      }
    }
  }

  // --- Receiving: delegate to inner ---

  onMessage(callback: (envelope: WireMessage) => void | Promise<void>): () => void {
    return this.inner.onMessage(callback)
  }

  onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void {
    return this.inner.onReceipt(callback)
  }

  // --- Transport: delegate to inner ---

  async registerTransport(did: string, transportAddress: string): Promise<void> {
    return this.inner.registerTransport(did, transportAddress)
  }

  async resolveTransport(did: string): Promise<string | null> {
    return this.inner.resolveTransport(did)
  }

  // --- State change: delegate to inner (WebSocketMessagingAdapter-specific) ---

  onStateChange(callback: (state: MessagingState) => void): () => void {
    if ('onStateChange' in this.inner && typeof (this.inner as any).onStateChange === 'function') {
      return (this.inner as any).onStateChange(callback)
    }
    return () => {}
  }

  // --- Outbox flush ---

  /**
   * Retry all pending outbox messages.
   * Called automatically on connect(). Can also be called manually.
   * FIFO order. Individual failures don't abort the flush.
   */
  async flushOutbox(): Promise<void> {
    if (this.flushing) return
    this.flushing = true

    try {
      const pending = await this.outbox.getPending()
      for (const entry of pending) {
        if (this.inner.getState() !== 'connected') break

        // #236 (TC5, I-NQ): lazy-drain stale log-sync entries queued by PREVIOUS app
        // versions. They leave the outbox ONLY via dequeue, never via send — an outbox
        // resend has no capability context and the log store is the source of truth
        // for these types. Lives here (not a startup migration) because flushOutbox is
        // the single serialized (this.flushing) exit path for every flush trigger
        // (connect fire-and-forget, onStateChange listeners, manual).
        if (NEVER_QUEUE_TYPES.has(entry.envelope.type)) {
          console.warn('[Outbox] draining stale log-sync entry (#236):', entry.envelope.type, entry.envelope.id)
          await this.outbox.dequeue(entry.envelope.id)
          continue
        }

        // Drop messages that exceeded max retries
        if (entry.retryCount >= this.maxRetries) {
          console.warn('[Outbox] Dropping message after', entry.retryCount, 'retries:', entry.envelope.type, entry.envelope.id)
          await this.outbox.dequeue(entry.envelope.id)
          continue
        }

        try {
          await this.sendWithTimeout(entry.envelope)
          await this.outbox.dequeue(entry.envelope.id)
        } catch {
          await this.outbox.incrementRetry(entry.envelope.id)
        }
      }
    } finally {
      this.flushing = false
    }
  }

  /** Expose outbox store for UI (pending count badge). */
  getOutboxStore(): OutboxStore {
    return this.outbox
  }

  // --- Private ---

  private _startAutoReconnect(): void {
    if (this.reconnectIntervalMs <= 0) return
    this._stopAutoReconnect()

    // Listen for state changes to flush outbox on reconnect
    this.unsubscribeStateChange = this.onStateChange((state) => {
      if (state === 'connected') {
        this.flushOutbox()
      }
    })

    this.reconnectTimer = setInterval(() => {
      if (!this.myDid) return
      if (!this.isOnline()) return
      const state = this.inner.getState()
      if (state === 'disconnected' || state === 'error') {
        this.inner.connect(this.myDid).catch(() => {
          // Reconnect failed — will retry on next interval
        })
      }
    }, this.reconnectIntervalMs)
  }

  private _stopAutoReconnect(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.unsubscribeStateChange) {
      this.unsubscribeStateChange()
      this.unsubscribeStateChange = null
    }
  }

  private sendWithTimeout(envelope: WireMessage): Promise<DeliveryReceipt> {
    if (this.sendTimeoutMs <= 0) {
      return this.inner.send(envelope)
    }

    return new Promise<DeliveryReceipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Send timeout after ${this.sendTimeoutMs}ms`))
      }, this.sendTimeoutMs)

      this.inner.send(envelope).then(
        (receipt) => { clearTimeout(timer); resolve(receipt) },
        (error) => { clearTimeout(timer); reject(error) },
      )
    })
  }
}
