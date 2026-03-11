import type { MessagingAdapter } from '../adapters/interfaces/MessagingAdapter'
import type { OutboxStore } from '../adapters/interfaces/OutboxStore'
import type { Subscribable } from '../adapters/interfaces/Subscribable'

/**
 * Delivery status lifecycle:
 *   sending → queued → delivered → acknowledged
 *                  ↘ failed ↙
 */
export type DeliveryStatus = 'sending' | 'queued' | 'delivered' | 'acknowledged' | 'failed'

/**
 * Tracks delivery status for attestation messages.
 *
 * Responsibilities:
 * - Status map (attestationId → DeliveryStatus)
 * - Reactive status updates via Subscribable
 * - Relay receipt listener (delivered/failed)
 * - Attestation-ack listener (acknowledged)
 * - Outbox bootstrap (queued/failed on startup)
 * - Optional persistence callback
 *
 * Does NOT handle attestation CRUD — that stays in the app layer.
 */
export class AttestationDeliveryService {
  private deliveryStatus = new Map<string, DeliveryStatus>()
  private statusSubscribers = new Set<(map: Map<string, DeliveryStatus>) => void>()
  private receiptUnsubscribe: (() => void) | null = null
  private messageUnsubscribe: (() => void) | null = null
  private persistFn: ((attestationId: string, status: string) => Promise<void>) | null = null

  /**
   * Set a persistence callback for delivery status (called on every status change).
   * Apps use this to persist status to their storage layer (e.g. Automerge, IndexedDB).
   */
  setPersistFn(fn: (attestationId: string, status: string) => Promise<void>): void {
    this.persistFn = fn
  }

  /**
   * Restore delivery statuses from persistent storage (call on app startup).
   */
  restore(statuses: Map<string, string>): void {
    const validStatuses: DeliveryStatus[] = ['sending', 'queued', 'delivered', 'acknowledged', 'failed']
    for (const [id, status] of statuses) {
      if (validStatuses.includes(status as DeliveryStatus)) {
        this.deliveryStatus.set(id, status as DeliveryStatus)
      }
    }
    this.notifySubscribers()
  }

  // --- Status access ---

  getStatus(attestationId: string): DeliveryStatus | undefined {
    return this.deliveryStatus.get(attestationId)
  }

  watchStatus(): Subscribable<Map<string, DeliveryStatus>> {
    return {
      getValue: () => this.deliveryStatus,
      subscribe: (callback: (map: Map<string, DeliveryStatus>) => void) => {
        this.statusSubscribers.add(callback)
        return () => { this.statusSubscribers.delete(callback) }
      },
    }
  }

  /**
   * Set status for an attestation. Called by the app layer after send attempts.
   */
  setStatus(attestationId: string, status: DeliveryStatus): void {
    this.deliveryStatus = new Map(this.deliveryStatus)
    this.deliveryStatus.set(attestationId, status)
    this.notifySubscribers()
    this.persistFn?.(attestationId, status).catch(() => {})
  }

  // --- Listeners ---

  /**
   * Listen for relay delivery receipts and attestation-ack messages.
   * Call once after messaging is connected.
   */
  listenForReceipts(messaging: MessagingAdapter): void {
    this.receiptUnsubscribe?.()
    this.messageUnsubscribe?.()

    // Relay delivery receipts
    this.receiptUnsubscribe = messaging.onReceipt((receipt) => {
      if (!this.deliveryStatus.has(receipt.messageId)) return
      if (receipt.status === 'delivered') {
        this.setStatus(receipt.messageId, 'delivered')
      } else if (receipt.status === 'failed') {
        this.setStatus(receipt.messageId, 'failed')
      }
    })

    // Attestation-ack messages from recipients
    this.messageUnsubscribe = messaging.onMessage((envelope) => {
      if (envelope.type !== 'attestation-ack') return
      try {
        const { attestationId } = JSON.parse(envelope.payload)
        if (attestationId && this.deliveryStatus.has(attestationId)) {
          this.setStatus(attestationId, 'acknowledged')
        }
      } catch {
        // Invalid payload — ignore
      }
    })
  }

  /**
   * Stop listening for receipts. Call on disconnect/cleanup.
   */
  stopListening(): void {
    this.receiptUnsubscribe?.()
    this.messageUnsubscribe?.()
    this.receiptUnsubscribe = null
    this.messageUnsubscribe = null
  }

  /**
   * Bootstrap delivery status from outbox (on app startup).
   * Marks pending attestation envelopes as 'queued'.
   * Marks stale 'sending' statuses (not in outbox) as 'failed'.
   */
  async initFromOutbox(outboxStore: OutboxStore): Promise<void> {
    const pending = await outboxStore.getPending()
    const outboxIds = new Set<string>()

    for (const entry of pending) {
      if (entry.envelope.type === 'attestation') {
        outboxIds.add(entry.envelope.id)
        this.setStatus(entry.envelope.id, 'queued')
      }
    }

    // Any 'sending' status not in the outbox means the send was interrupted
    for (const [id, status] of this.deliveryStatus) {
      if (status === 'sending' && !outboxIds.has(id)) {
        this.setStatus(id, 'failed')
      }
    }
  }

  // --- Private ---

  private notifySubscribers(): void {
    for (const cb of this.statusSubscribers) {
      cb(this.deliveryStatus)
    }
  }
}
