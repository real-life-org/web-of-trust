import { MessagingAdapter } from '../../ports/MessagingAdapter';
import { MessageEnvelope, DeliveryReceipt, MessagingState } from '../../types/messaging';
import { OutboxStore } from '../../ports/OutboxStore';
import { OutboxMessagingAdapter } from './OutboxMessagingAdapter';
export declare class TracedOutboxMessagingAdapter implements MessagingAdapter {
    private inner;
    constructor(inner: OutboxMessagingAdapter);
    connect(myDid: string): Promise<void>;
    disconnect(): Promise<void>;
    getState(): MessagingState;
    onStateChange(callback: (state: MessagingState) => void): () => void;
    send(envelope: MessageEnvelope): Promise<DeliveryReceipt>;
    onMessage(callback: (envelope: MessageEnvelope) => void | Promise<void>): () => void;
    onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void;
    registerTransport(did: string, transportAddress: string): Promise<void>;
    resolveTransport(did: string): Promise<string | null>;
    flushOutbox(): Promise<void>;
    getOutboxStore(): OutboxStore;
}
//# sourceMappingURL=TracedOutboxMessagingAdapter.d.ts.map