import { MessagingAdapter } from '../ports/MessagingAdapter';
import { OutboxStore } from '../ports/OutboxStore';
import { Subscribable } from '../ports/Subscribable';
/**
 * Delivery status lifecycle:
 *   sending → queued → delivered → acknowledged
 *                  ↘ failed ↙
 */
export type DeliveryStatus = 'sending' | 'queued' | 'delivered' | 'acknowledged' | 'failed';
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
export declare class AttestationDeliveryService {
    private deliveryStatus;
    private statusSubscribers;
    private receiptUnsubscribe;
    private messageUnsubscribe;
    private persistFn;
    /**
     * Set a persistence callback for delivery status (called on every status change).
     * Apps use this to persist status to their storage layer (e.g. Automerge, IndexedDB).
     */
    setPersistFn(fn: (attestationId: string, status: string) => Promise<void>): void;
    /**
     * Restore delivery statuses from persistent storage (call on app startup).
     */
    restore(statuses: Map<string, string>): void;
    getStatus(attestationId: string): DeliveryStatus | undefined;
    watchStatus(): Subscribable<Map<string, DeliveryStatus>>;
    /**
     * Set status for an attestation. Called by the app layer after send attempts.
     */
    setStatus(attestationId: string, status: DeliveryStatus): void;
    /**
     * Listen for relay delivery receipts and attestation-ack messages.
     * Call once after messaging is connected.
     */
    listenForReceipts(messaging: MessagingAdapter): void;
    /**
     * Stop listening for receipts. Call on disconnect/cleanup.
     */
    stopListening(): void;
    /**
     * Bootstrap delivery status from outbox (on app startup).
     * Marks pending attestation envelopes as 'queued'.
     * Marks stale 'sending' statuses (not in outbox) as 'failed'.
     */
    initFromOutbox(outboxStore: OutboxStore): Promise<void>;
    private notifySubscribers;
}
//# sourceMappingURL=AttestationDeliveryService.d.ts.map