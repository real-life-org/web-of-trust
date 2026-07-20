/**
 * Relay Protocol Types
 *
 * JSON messages exchanged over WebSocket between clients and the relay server.
 * The relay is blind — it never inspects the payload (E2E-encrypted).
 *
 * `send` trägt eine von zwei Message-Familien (Sync 003 Z.328-341):
 * Old-World `MessageEnvelope` (Routing via `toDid`) oder ein WoT Transport
 * Envelope in DIDComm-Plaintext-Form (Routing via `to[0]`). Ein Transport
 * Envelope mit type `ack/1.0` wird nicht geroutet, sondern vom Relay
 * konsumiert (Queue-Slot-Räumung, Sync 003 §ack/1.0).
 *
 * Auth flow (Sync 003 Broker-Auth-Transcript):
 *   1. Client → { type: 'register', did, deviceId }
 *   2. Relay  → { type: 'challenge', nonce }            // 32 random bytes, canonical unpadded Base64URL
 *   3. Client → { type: 'challenge-response', did, deviceId, nonce, signature }
 *                                                       // signature over JCS(Broker-Auth-Transcript)
 *   4. Relay  → { type: 'registered', did, deviceId, isNewDevice, peers }
 */

/** Client → Relay */
export type ClientMessage =
  | { type: 'register'; did: string; deviceId: string }
  | { type: 'challenge-response'; did: string; deviceId: string; nonce: string; signature: string }
  | { type: 'send'; envelope: Record<string, unknown> }
  | { type: 'ack'; messageId: string }
  | { type: 'ping' }

/** Relay → Client */
export type RelayMessage =
  | { type: 'challenge'; nonce: string }
  | { type: 'registered'; did: string; deviceId: string; isNewDevice: boolean; peers: number }
  | { type: 'message'; envelope: Record<string, unknown> }
  | { type: 'receipt'; receipt: RelayReceipt }
  // `thid` (Slice SR / VE-C2): correlates a routed write-path error back to the exact
  // in-flight log-entry it rejects (thid == the rejected envelope id), so the sender's
  // LogSyncCoordinator can drive the reject-disposition action (e.g. the legitimate
  // lagger's KEY_GENERATION_STALE catch-up-and-re-emit). Optional: only write-path
  // rejects that correlate to a specific sent message set it.
  | { type: 'error'; code: string; message: string; clientHint?: string; thid?: string; currentGeneration?: number }
  | { type: 'pong' }

export interface RelayReceipt {
  messageId: string
  status: 'accepted' | 'delivered' | 'failed'
  timestamp: string
  reason?: string
}
