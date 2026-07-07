import type { ResourceRef } from './resource-ref'

// VE-6: 'verification', 'contact-request' und 'item-key' wurden entfernt —
// 0 produktive Sender (RED-PRE-CHECK 2026-06-10). 'attestation', 'space-invite',
// 'key-rotation' und 'member-update' haben nach der Inbox-Wire-Migration ebenfalls
// keine Old-World-Sender mehr; die Werte sterben mit dem CRDT-Sync-Slice (wot-spec#96).
export type MessageType =
  | 'attestation'
  | 'space-invite'
  | 'key-rotation'
  | 'profile-update'
  | 'ack'
  | 'content'
  | 'member-update'
  | 'personal-sync'
  | 'space-sync-request'

/**
 * Old-World space CRDT-sync request (#236). Exported as a constant so the outbox
 * NEVER_QUEUE set and the Yjs sender share one definition instead of scattered
 * string literals. Its retry authority is the adapter's own requestSync trigger;
 * the vNext relay rejects it as not queue-eligible (no receipt), so store-and-
 * forward queueing it only produces undeliverable outbox orphans.
 */
export const SPACE_SYNC_REQUEST_MESSAGE_TYPE = 'space-sync-request' as const

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
