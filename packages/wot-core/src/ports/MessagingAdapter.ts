import type {
  MessageEnvelope,
  DeliveryReceipt,
  MessagingState,
} from '../types/messaging'

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
  // Connection Lifecycle
  connect(myDid: string): Promise<void>
  disconnect(): Promise<void>
  getState(): MessagingState

  // State Changes — notifies when connection state changes (connected/disconnected/reconnecting)
  onStateChange(callback: (state: MessagingState) => void): () => void

  // Sending — takes an envelope, returns receipt
  send(envelope: MessageEnvelope): Promise<DeliveryReceipt>

  // Receiving — callback may be async (ACK is deferred until callback resolves)
  onMessage(callback: (envelope: MessageEnvelope) => void | Promise<void>): () => void

  // Receipt Updates (async: delivered/acknowledged come later)
  onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void

  // Transport Resolution (how to find the recipient?)
  // Separate from DID concept: this is about transport addresses,
  // not DID resolution. In Matrix migration this becomes Room IDs.
  registerTransport(did: string, transportAddress: string): Promise<void>
  resolveTransport(did: string): Promise<string | null>
}
