import { MessagingAdapter } from '../interfaces/MessagingAdapter';
import { OutboxStore } from '../interfaces/OutboxStore';
import { MessageEnvelope, DeliveryReceipt, MessagingState, MessageType } from '../../types/messaging';
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
export declare class OutboxMessagingAdapter implements MessagingAdapter {
    private inner;
    private outbox;
    private flushing;
    private skipTypes;
    private sendTimeoutMs;
    private reconnectIntervalMs;
    private isOnline;
    private reconnectTimer;
    private myDid;
    private unsubscribeStateChange;
    constructor(inner: MessagingAdapter, outbox: OutboxStore, options?: {
        skipTypes?: MessageType[];
        sendTimeoutMs?: number;
        /** Auto-reconnect interval in ms. Set to 0 to disable. Default: 10000 (10s). */
        reconnectIntervalMs?: number;
        /** Optional online check. Default: always true. */
        isOnline?: () => boolean;
    });
    connect(myDid: string): Promise<void>;
    disconnect(): Promise<void>;
    getState(): MessagingState;
    send(envelope: MessageEnvelope): Promise<DeliveryReceipt>;
    onMessage(callback: (envelope: MessageEnvelope) => void | Promise<void>): () => void;
    onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void;
    registerTransport(did: string, transportAddress: string): Promise<void>;
    resolveTransport(did: string): Promise<string | null>;
    onStateChange(callback: (state: MessagingState) => void): () => void;
    /**
     * Retry all pending outbox messages.
     * Called automatically on connect(). Can also be called manually.
     * FIFO order. Individual failures don't abort the flush.
     */
    flushOutbox(): Promise<void>;
    /** Expose outbox store for UI (pending count badge). */
    getOutboxStore(): OutboxStore;
    private _startAutoReconnect;
    private _stopAutoReconnect;
    private sendWithTimeout;
}
//# sourceMappingURL=OutboxMessagingAdapter.d.ts.map