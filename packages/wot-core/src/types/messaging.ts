import type { ResourceRef } from './resource-ref'

export type MessageType =
  | 'verification'
  | 'attestation'
  | 'contact-request'
  | 'item-key'
  | 'space-invite'
  | 'key-rotation'
  | 'profile-update'
  | 'ack'
  | 'content'
  | 'member-update'
  | 'personal-sync'
  | 'space-sync-request'

/**
 * @deprecated Legacy / not DIDComm-compatible (v:1, fromDid, toDid, signature
 * top-level). Sync 003 (Z.343/410) specifies the DIDComm-v2-plaintext envelope;
 * the spec-compliant pendant is `DidcommPlaintextMessage` in
 * protocol/sync/membership-messages.ts (envelope carries no crypto, authenticity
 * lives in the body via Inner-JWS/ECIES). This type dies with the
 * Automerge-adapter-stack refactor in Phase 2+. See real-life-org/wot-spec#96.
 *
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
 * - failed: Delivery failed (reason in reason field)
 */
export interface DeliveryReceipt {
  messageId: string
  status: 'accepted' | 'delivered' | 'failed'
  timestamp: string
  reason?: string
}

export type MessagingState = 'disconnected' | 'connecting' | 'connected' | 'error'
