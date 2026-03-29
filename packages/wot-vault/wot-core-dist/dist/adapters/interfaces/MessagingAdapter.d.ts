import { MessageEnvelope, DeliveryReceipt, MessagingState } from '../../types/messaging';
/**
 * Messaging adapter interface for cross-user message delivery.
 *
 * Framework-agnostic: Can be implemented with WebSocket Relay (POC),
 * Matrix (production), or InMemory (tests).
 *
 * Follows the Empfänger-Prinzip: Messages are delivered to the recipient.
 * Handles attestation/verification delivery, contact requests,
 * item-key delivery, space invitations, and arbitrary DID-to-DID messages.
 */
export interface MessagingAdapter {
    connect(myDid: string): Promise<void>;
    disconnect(): Promise<void>;
    getState(): MessagingState;
    send(envelope: MessageEnvelope): Promise<DeliveryReceipt>;
    onMessage(callback: (envelope: MessageEnvelope) => void | Promise<void>): () => void;
    onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void;
    registerTransport(did: string, transportAddress: string): Promise<void>;
    resolveTransport(did: string): Promise<string | null>;
}
//# sourceMappingURL=MessagingAdapter.d.ts.map