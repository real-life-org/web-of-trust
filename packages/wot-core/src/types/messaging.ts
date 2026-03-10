import type { ResourceRef } from './resource-ref'

export type MessageType =
  | 'verification'
  | 'attestation'
  | 'contact-request'
  | 'item-key'
  | 'space-invite'
  | 'group-key-rotation'
  | 'profile-update'
  | 'attestation-ack'
  | 'ack'
  | 'content'
  | 'member-update'

/**
 * Standardized envelope format for all cross-user messages.
 * Signature is separate from payload — independently verifiable.
 */
export interface MessageEnvelope {
  v: 1
  id: string
  type: MessageType
  fromDid: string
  toDid: string
  createdAt: string        // ISO 8601
  encoding: 'json' | 'cbor' | 'base64'
  payload: string          // Encoded payload (depends on encoding)
  signature: string        // Ed25519 signature over canonical fields
  ref?: ResourceRef        // Optional pointer to the resource
}

/**
 * Multi-stage delivery receipts:
 * - accepted: Relay has accepted the message
 * - delivered: Recipient device has received it
 * - acknowledged: Recipient app has processed it (e.g. attestation saved)
 * - failed: Delivery failed (reason in reason field)
 */
export interface DeliveryReceipt {
  messageId: string
  status: 'accepted' | 'delivered' | 'acknowledged' | 'failed'
  timestamp: string
  reason?: string
}

export type MessagingState = 'disconnected' | 'connecting' | 'connected' | 'error'
