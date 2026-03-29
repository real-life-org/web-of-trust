import { MessagingAdapter } from '../interfaces/MessagingAdapter';
import { MessageEnvelope, DeliveryReceipt, MessagingState } from '../../types/messaging';
/**
 * In-memory messaging adapter for testing.
 *
 * Uses a shared static registry so two instances (Alice + Bob) in the same
 * process can exchange messages. Supports offline queuing: messages sent
 * to a DID that is not yet connected are queued and delivered on connect.
 */
export declare class InMemoryMessagingAdapter implements MessagingAdapter {
    private static registry;
    private static offlineQueue;
    private static transportMap;
    private myDid;
    private state;
    private messageCallbacks;
    private receiptCallbacks;
    connect(myDid: string): Promise<void>;
    disconnect(): Promise<void>;
    getState(): MessagingState;
    send(envelope: MessageEnvelope): Promise<DeliveryReceipt>;
    onMessage(callback: (envelope: MessageEnvelope) => void | Promise<void>): () => void;
    onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void;
    registerTransport(did: string, transportAddress: string): Promise<void>;
    resolveTransport(did: string): Promise<string | null>;
    /** Reset all shared state. Call in afterEach() for test isolation. */
    static resetAll(): void;
    private deliverToSelf;
}
//# sourceMappingURL=InMemoryMessagingAdapter.d.ts.map