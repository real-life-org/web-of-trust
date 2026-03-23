/**
 * Relay Protocol Types
 *
 * JSON messages exchanged over WebSocket between clients and the relay server.
 * The relay is blind — it never inspects the payload (E2E-encrypted).
 *
 * Auth flow:
 *   1. Client → { type: 'register', did }
 *   2. Relay  → { type: 'challenge', nonce }
 *   3. Client → { type: 'challenge-response', did, nonce, signature }
 *   4. Relay  → { type: 'registered', did, peers }  (or error)
 */

/** Client → Relay */
export type ClientMessage =
  | { type: 'register'; did: string }
  | { type: 'challenge-response'; did: string; nonce: string; signature: string }
  | { type: 'send'; envelope: Record<string, unknown> }
  | { type: 'ack'; messageId: string }
  | { type: 'ping' }

/** Relay → Client */
export type RelayMessage =
  | { type: 'challenge'; nonce: string }
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
