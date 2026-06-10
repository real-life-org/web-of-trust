import type { ProtocolCryptoAdapter } from '../../protocol/crypto/ports'
import type { DidResolver } from '../../protocol/identity/did-document'
import type { EciesMessage } from '../../protocol/sync/encryption'
import { assertPlaintextMessage } from '../../protocol/sync/membership-messages'
import { verifyInboxInnerJws } from '../../protocol/messaging/inbox-inner-jws'
import {
  assertInboxEncryptedBody,
  extractInboxExtensionFields,
} from '../../protocol/messaging/inbox-message'
import type { MessageIdHistoryPort } from '../../ports/MessageIdHistory'

export interface ReceiveInboxMessageOptions {
  /** Rohe eingehende Nachricht (unvalidiertes Wire-Objekt). */
  message: unknown
  ownDid: string
  /** Identity-Decrypt (X25519) — z.B. via IdentityVault decryptForMe. */
  decryptEcies: (message: EciesMessage) => Promise<Uint8Array>
  crypto: ProtocolCryptoAdapter
  didResolver: DidResolver
  messageIdHistory: MessageIdHistoryPort
  now?: () => Date
  maxAgeMs?: number
}

export type ReceiveInboxMessageResult =
  | {
      decision: 'accept'
      type: string
      /**
       * Sync 003 Z.460-464: senderDid aus dem verifizierten Inner-JWS, nicht aus
       * Envelope-Routing (`from`). Löst #189-SPEC-DEFERRED S1 auf — alle
       * nachgelagerten Authority-Checks bekommen DIESEN Wert.
       */
      senderDid: string
      body: Record<string, unknown>
      outerId: string
      extensionFields: Record<string, unknown>
      /**
       * Sync 003 Z.466 + Z.620-622: "id DARF nicht bereits VERARBEITET worden
       * sein" — verarbeitet heißt angewendet, durabel gepuffert oder
       * deterministisch ungültig verworfen (ACK-Vorbedingung 4). Der Aufrufer
       * ruft recordProcessed() genau an diesem konklusiven Dispositions-Punkt
       * auf. Bis dahin bleibt die id aus der History: die Relay-Redelivery ist
       * der Recovery-Pfad und darf nicht als Replay mit duplicate-known-ack
       * enden — sonst räumt der Broker den Slot und die Nachricht ist verloren.
       */
      recordProcessed: () => Promise<void>
    }
  | {
      decision: 'reject'
      reason: 'malformed-envelope' | 'decrypt-failed' | 'invalid-inner-jws' | 'replay'
    }

/**
 * Generischer Inbox-Empfänger: DIDComm-Form prüfen → ECIES-Decrypt →
 * Inner-JWS verifizieren (Sync 003 Z.460-465, Prüfungen 1-4) →
 * Message-ID-History lesend (Prüfung 5, Replay) → accept mit authentifiziertem
 * Sender; das Recorden macht der Aufrufer bei konklusivem Ausgang über
 * recordProcessed (Sync 003 Z.466 + Z.620-622).
 * Wire-Eingaben rejecten statt zu werfen (P2-Konvention aus #189).
 */
export async function receiveInboxMessage(options: ReceiveInboxMessageOptions): Promise<ReceiveInboxMessageResult> {
  let envelope
  try {
    assertPlaintextMessage(options.message)
    envelope = options.message
    // Sync 003 Z.378: Inbox-Nachrichten MÜSSEN `to` setzen.
    if (!Array.isArray(envelope.to) || envelope.to.length === 0) throw new Error('Missing inbox envelope to')
    assertInboxEncryptedBody(envelope.body)
  } catch {
    return { decision: 'reject', reason: 'malformed-envelope' }
  }
  const body = envelope.body

  let innerJws: string
  try {
    const plaintext = await options.decryptEcies({
      epk: body.epk,
      nonce: body.nonce,
      ciphertext: body.ciphertext,
    })
    innerJws = new TextDecoder().decode(plaintext)
  } catch {
    return { decision: 'reject', reason: 'decrypt-failed' }
  }

  let payload
  try {
    payload = await verifyInboxInnerJws(innerJws, {
      crypto: options.crypto,
      didResolver: options.didResolver,
      ownDid: options.ownDid,
      expectedOuterType: envelope.type,
      expectedOuterId: envelope.id,
      now: options.now,
      maxAgeMs: options.maxAgeMs,
    })
  } catch {
    return { decision: 'reject', reason: 'invalid-inner-jws' }
  }

  // Pflichtprüfung 5 NACH der Signatur-Verifikation (lesend), damit ein
  // Angreifer die History nicht mit unauthentifizierten IDs vergiften kann.
  // Sync 003 Z.466 + Z.620-622: recorded wird erst bei konklusiver Verarbeitung
  // über recordProcessed — nie schon bei der Reception, sonst verliert ein
  // nicht-konklusiver Ausgang die Redelivery als vermeintlichen Replay.
  const now = options.now ?? (() => new Date())
  if (await options.messageIdHistory.has(payload.id, now().toISOString())) {
    return { decision: 'reject', reason: 'replay' }
  }

  return {
    decision: 'accept',
    type: envelope.type,
    senderDid: payload.from,
    body: payload.body,
    outerId: envelope.id,
    extensionFields: extractInboxExtensionFields(body),
    recordProcessed: async () => {
      await options.messageIdHistory.checkAndRecord(payload.id, now().toISOString())
    },
  }
}
