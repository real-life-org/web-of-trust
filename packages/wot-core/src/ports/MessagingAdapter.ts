import type {
  DeliveryReceipt,
  MessagingState,
} from '../types/messaging'
import type { DidcommPlaintextMessage } from '../protocol/sync/membership-messages'
import type { ControlFrame, ControlFrameReceipt } from '../protocol/sync/control-frame-transport'

/**
 * Sync 003 Z.328-341: die DIDComm-Transport-Envelopes (Inbox-Familie,
 * log-entry, sync-request/-response, ack). Die Old-World-Familie
 * (`MessageEnvelope`) ist entfernt (wot#386) — das Relay ließ sie nie durch.
 */
export type WireMessage = DidcommPlaintextMessage<object>

/** Routing-Empfänger: DIDComm `to[0]`. */
export function wireMessageRecipient(message: WireMessage): string | undefined {
  const to = message.to
  return Array.isArray(to) ? to[0] : undefined
}

/** Routing-Absender: DIDComm `from`. */
export function wireMessageSender(message: WireMessage): string | undefined {
  return typeof message.from === 'string' ? message.from : undefined
}

/**
 * Messaging adapter interface for cross-user message delivery.
 *
 * Framework-agnostic: Can be implemented with WebSocket Relay (POC),
 * Matrix (production), or InMemory (tests).
 *
 * Follows the Empfänger-Prinzip: Messages are delivered to the recipient.
 * Trägt die DIDComm-Familie (Sync 003): Inbox (inbox/1.0, space-invite,
 * member-update, key-rotation), log-entry/sync-request und ack.
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
   * These frames are NOT `send` envelopes (no DIDComm wrapping).
   *
   * Optional so historical mocks need not implement it; the LogSyncCoordinator
   * feature-detects it. Receipt correlation by `messageId == docId` is ambiguous
   * across families, so the caller drives control frames per (socket, docId)
   * strictly sequentially — the transport need only deliver and surface the next
   * receipt/error for that docId.
   */
  sendControlFrame?(frame: ControlFrame): Promise<ControlFrameReceipt>

  /**
   * VE-11 (Durable Wiring): re-bind this transport to a NEW deviceId for the SAME
   * identity and re-register it at the broker, resolving only once the new device
   * is `registered`. A restore-clone mints a fresh deviceId (a fresh nonce
   * namespace) and MUST re-register it before the next log-entry, or the relay
   * rejects writes DEVICE_NOT_REGISTERED.
   *
   * The relay forbids re-registering a different device on an EXISTING socket
   * (one WS = one session), so the implementation opens a FRESH socket that
   * re-runs the existing challenge-response handshake with the new deviceId — NO
   * relay-protocol change. Optional + feature-detected (historical / in-process
   * test doubles whose broker needs no re-register simply omit it); the
   * restore-clone controller awaits it only when present.
   */
  rebindDeviceId?(newDeviceId: string): Promise<void>

  // Receiving — callback may be async; inbox ACK ownership lies with the
  // reception host / replication adapter (K1), never with the transport
  onMessage(callback: (envelope: WireMessage) => void | Promise<void>): () => void

  // Receipt Updates (async: delivered comes later)
  onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void

  // Transport Resolution (how to find the recipient?)
  // Separate from DID concept: this is about transport addresses,
  // not DID resolution. In Matrix migration this becomes Room IDs.
  registerTransport(did: string, transportAddress: string): Promise<void>
  resolveTransport(did: string): Promise<string | null>
}
