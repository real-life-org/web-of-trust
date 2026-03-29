import { ResourceRef } from './resource-ref';
export type MessageType = 'verification' | 'attestation' | 'contact-request' | 'item-key' | 'space-invite' | 'group-key-rotation' | 'profile-update' | 'attestation-ack' | 'ack' | 'content' | 'member-update' | 'personal-sync';
/**
 * Standardized envelope format for all cross-user messages.
 * Signature is separate from payload — independently verifiable.
 */
export interface MessageEnvelope {
    v: 1;
    id: string;
    type: MessageType;
    fromDid: string;
    toDid: string;
    createdAt: string;
    encoding: 'json' | 'cbor' | 'base64';
    payload: string;
    signature: string;
    ref?: ResourceRef;
}
/**
 * Multi-stage delivery receipts:
 * - accepted: Relay has accepted the message
 * - delivered: Recipient device has received it
 * - acknowledged: Recipient app has processed it (e.g. attestation saved)
 * - failed: Delivery failed (reason in reason field)
 */
export interface DeliveryReceipt {
    messageId: string;
    status: 'accepted' | 'delivered' | 'acknowledged' | 'failed';
    timestamp: string;
    reason?: string;
}
export type MessagingState = 'disconnected' | 'connecting' | 'connected' | 'error';
//# sourceMappingURL=messaging.d.ts.map