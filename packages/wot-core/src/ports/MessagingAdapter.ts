import type {
  MessageEnvelope,
  DeliveryReceipt,
  MessagingState,
} from '../types/messaging'
import type { DidcommPlaintextMessage } from '../protocol/sync/membership-messages'
import type { ControlFrame, ControlFrameReceipt } from '../protocol/sync/control-frame-transport'

/**
 * VE-8: Zwei normative Message-Familien bis zum Sync-002-Slice (Sync 003
 * Z.328-341) — Old-World `MessageEnvelope` für den CRDT-Sync-Kanal
 * (content/personal-sync/space-sync-request/profile-update) und
 * DIDComm-Transport-Envelopes für die Inbox-Familie. Kein Typ existiert in
 * beiden Familien; discriminiert wird über `isDidcommMessage` (typ-Feld).
 */
export type WireMessage = MessageEnvelope | DidcommPlaintextMessage<object>

/** Routing-Empfänger beider Familien: Old-World `toDid`, DIDComm `to[0]`. */
export function wireMessageRecipient(message: WireMessage): string | undefined {
  if ('toDid' in message && typeof message.toDid === 'string') return message.toDid
  const to = (message as DidcommPlaintextMessage).to
  return Array.isArray(to) ? to[0] : undefined
}

/** Routing-Absender beider Familien: Old-World `fromDid`, DIDComm `from`. */
export function wireMessageSender(message: WireMessage): string | undefined {
  if ('fromDid' in message && typeof message.fromDid === 'string') return message.fromDid
  const from = (message as DidcommPlaintextMessage).from
  return typeof from === 'string' ? from : undefined
}

/**
 * Messaging adapter interface for cross-user message delivery.
 *
 * Framework-agnostic: Can be implemented with WebSocket Relay (POC),
 * Matrix (production), or InMemory (tests).
 *
 * Follows the Empfänger-Prinzip: Messages are delivered to the recipient.
 * Trägt beide Familien (VE-8): die DIDComm-Inbox-Familie (inbox/1.0,
 * space-invite, member-update, key-rotation) und die Old-World-Envelopes
 * des CRDT-Sync-Kanals.
 */
export interface MessagingAdapter {
  // Connection Lifecycle
  connect(myDid: string): Promise<void>
  disconnect(): Promise<void>
  getState(): MessagingState

  // State Changes — notifies when connection state changes (connected/disconnected/reconnecting)
  onStateChange(callback: (state: MessagingState) => void): () => void

  // Sending — takes an envelope (either family), returns receipt
  send(envelope: WireMessage): Promise<DeliveryReceipt>

  /**
   * VE-9/VE-11: send a Sync 003 CLOSED top-level control frame
   * (`present-capability` / `space-register` / `space-rotate` / `device-revoke`)
   * and resolve with its `{ type:'receipt' }` (success) or reject with a
   * {@link ControlFrameRejectedError} carrying the broker `{ type:'error' }` code.
   * These frames are NOT `send` envelopes (no DIDComm/Old-World wrapping).
   *
   * Optional so historical mocks need not implement it; the LogSyncCoordinator
   * feature-detects it. Receipt correlation by `messageId == docId` is ambiguous
   * across families, so the caller drives control frames per (socket, docId)
   * strictly sequentially — the transport need only deliver and surface the next
   * receipt/error for that docId.
   */
  sendControlFrame?(frame: ControlFrame): Promise<ControlFrameReceipt>

  // Receiving — callback may be async (Old-World-ACK is deferred until callback
  // resolves; DIDComm-Inbox-ACK ownership lies with the reception host, K1)
  onMessage(callback: (envelope: WireMessage) => void | Promise<void>): () => void

  // Receipt Updates (async: delivered comes later)
  onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void

  // Transport Resolution (how to find the recipient?)
  // Separate from DID concept: this is about transport addresses,
  // not DID resolution. In Matrix migration this becomes Room IDs.
  registerTransport(did: string, transportAddress: string): Promise<void>
  resolveTransport(did: string): Promise<string | null>
}
