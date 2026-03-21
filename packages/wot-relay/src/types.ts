/**
 * Relay Protocol Types
 *
 * JSON messages exchanged over WebSocket between clients and the relay server.
 * The relay is blind — it never inspects the payload (E2E-encrypted).
 */

// Re-export the types we need from wot-core's messaging types
// We inline them here to avoid a dependency on wot-core in the relay server.
// The relay only needs to forward envelopes — it doesn't need to understand them.

/** Client → Relay */
export type ClientMessage =
  | { type: 'register'; did: string }
  | { type: 'send'; envelope: Record<string, unknown> }
  | { type: 'ack'; messageId: string }
  | { type: 'ping' }

/** Relay → Client */
export type RelayMessage =
  | { type: 'registered'; did: string; peers: number }
  | { type: 'message'; envelope: Record<string, unknown> }
  | { type: 'receipt'; receipt: RelayReceipt }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }

export interface RelayReceipt {
  messageId: string
  status: 'accepted' | 'delivered' | 'failed'
  timestamp: string
  reason?: string
}
