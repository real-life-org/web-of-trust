/**
 * Control-frame transport contract (VE-9/VE-11, wot-sync@0.1).
 *
 * The Sync 003 top-level CLOSED control frames — `present-capability`,
 * `space-register`, `space-rotate`, `device-revoke` — are NOT `send` envelopes:
 * they travel as their own `{ type, <x>Jws }` JSON frames and the relay answers
 * with a closed `{ type:'receipt', receipt }` (success) or `{ type:'error',
 * code, message }` (reject). The legacy {@link MessagingAdapter.send} surface
 * only carries DIDComm/Old-World envelopes, so this is a separate channel.
 *
 * `MessagingAdapter` gains an OPTIONAL {@link MessagingAdapter.sendControlFrame}
 * so the WebSocket + InMemory adapters can implement it without forcing every
 * historical mock to. The {@link LogSyncCoordinator} feature-detects it and
 * fails loudly if a coordinator is wired against a transport that cannot carry
 * control frames.
 *
 * Receipt correlation is intentionally NOT solved here: because the relay sets
 * `receipt.messageId == spaceId(=docId)` for every control-frame family, the
 * id is ambiguous across families. The coordinator therefore drives control
 * frames per `(socket, docId)` strictly sequentially and treats the single
 * pending frame's resolution as its receipt. The transport only has to deliver
 * the frame and surface the next `receipt`/`error` for that docId.
 */

import type { BrokerErrorCode } from './broker-error'

/**
 * A closed top-level control frame: `{ type, <x>Jws }`. Modeled as just
 * `{ type: string }` so the concrete frame shapes
 * (`PresentCapabilityControlFrame`, `SpaceRegisterMessage`, …) assign directly;
 * implementations serialize the whole object (the extra `*Jws` keys ride along).
 */
export interface ControlFrame {
  type: string
}

/** Success receipt for a control frame (Sync 003 `{ type:'receipt', receipt }`). */
export interface ControlFrameReceipt {
  /** Always the docId (= spaceId / personal-doc-id) the frame targeted. */
  messageId: string
  status: 'delivered'
  timestamp: string
}

/** Reject result for a control frame (Sync 003 `{ type:'error', code, message }`). */
export interface ControlFrameError {
  code: BrokerErrorCode
  message: string
  /** Structured broker state carried by a `GENERATION_GAP` rejection. */
  currentGeneration?: number
}

/**
 * Thrown by {@link MessagingAdapter.sendControlFrame} (and re-thrown by the
 * coordinator) when the relay rejects a control frame. Carries the structured
 * broker error so the coordinator's reject-disposition table can match on
 * `code` (never on a free-text `message`).
 */
export class ControlFrameRejectedError extends Error {
  readonly code: BrokerErrorCode
  readonly currentGeneration?: number
  constructor(error: ControlFrameError) {
    super(`Control frame rejected: ${error.code} — ${error.message}`)
    this.name = 'ControlFrameRejectedError'
    this.code = error.code
    this.currentGeneration = error.currentGeneration
  }
}
