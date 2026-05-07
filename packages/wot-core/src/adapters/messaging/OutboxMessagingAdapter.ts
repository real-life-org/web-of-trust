import type { MessagingAdapter } from '../../ports/MessagingAdapter'
import type { OutboxStore } from '../../ports/OutboxStore'
import type {
  MessageEnvelope,
  DeliveryReceipt,
  MessagingState,
  MessageType,
} from '../../types/messaging'

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
  private skipTypes: Set<MessageType>
  private sendTimeoutMs: number
  private reconnectIntervalMs: number
  private maxRetries: number
  private isOnline: () => boolean
  private reconnectTimer: ReturnType<typeof setInterval> | null = null
  private myDid: string | null = null
  private unsubscribeStateChange: (() => void) | null = null

  constructor(
    private inner: MessagingAdapter,
    private outbox: OutboxStore,
    options?: {
      skipTypes?: MessageType[]
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

  async send(envelope: MessageEnvelope): Promise<DeliveryReceipt> {
    // Skip outbox for non-critical types (fire-and-forget)
    if (this.skipTypes.has(envelope.type)) {
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

  onMessage(callback: (envelope: MessageEnvelope) => void | Promise<void>): () => void {
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

  private sendWithTimeout(envelope: MessageEnvelope): Promise<DeliveryReceipt> {
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
