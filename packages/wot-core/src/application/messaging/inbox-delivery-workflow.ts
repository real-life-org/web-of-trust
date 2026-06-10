import type { ProtocolCryptoAdapter } from '../../protocol/crypto/ports'
import type { JcsEd25519SignFn } from '../../protocol/crypto/jws'
import { encryptEcies } from '../../protocol/sync/encryption'
import { createPlaintextMessage, type DidcommPlaintextMessage } from '../../protocol/sync/membership-messages'
import { createInboxInnerJws } from '../../protocol/messaging/inbox-inner-jws'
import {
  INBOX_ECIES_BODY_FIELDS,
  assertEncryptedInboxEnvelope,
  type InboxEncryptedBody,
} from '../../protocol/messaging/inbox-message'

const X25519_SEED_LENGTH = 32
const ECIES_NONCE_LENGTH = 12

export interface DeliverInboxMessageOptions {
  /** Type-URI der Nachricht (inbox/1.0, space-invite/1.0, member-update/1.0, key-rotation/1.0). */
  type: string
  /** Klartext-Body — Schema-validiert vom Aufrufer (assert*Body). */
  body: Record<string, unknown>
  from: string
  to: string
  /** X25519 Encryption Public Key des Empfängers (Sync 001 Encryption Key Discovery). */
  recipientEncryptionPublicKey: Uint8Array
  /** Identity-Key-Signer (Ed25519) des Senders. */
  sign: JcsEd25519SignFn
  crypto: ProtocolCryptoAdapter
  randomId?: () => string
  now?: () => Date
  /**
   * Zusätzliche Wire-Body-Felder neben dem ECIES-Container, z.B.
   * encryptedDocSnapshot (VE-5) — selbst verschlüsselt, kein Autoritätsträger,
   * reist deshalb NICHT im Inner-JWS.
   */
  extensionFields?: Record<string, unknown>
}

/**
 * Generischer Inbox-Sender (Sync 003 Z.450-456): Klartext-Body → Inner-JWS
 * (Pflichtfelder from/to/type/id/created_time) → ECIES für den Empfänger-Key →
 * DIDComm-Plaintext-Envelope mit body = { epk, nonce, ciphertext, ...extensions }.
 */
export async function deliverInboxMessage(
  options: DeliverInboxMessageOptions,
): Promise<DidcommPlaintextMessage<InboxEncryptedBody>> {
  const reserved = new Set<string>(INBOX_ECIES_BODY_FIELDS)
  for (const key of Object.keys(options.extensionFields ?? {})) {
    if (reserved.has(key)) throw new Error(`Inbox extension field collides with ECIES container: ${key}`)
  }

  const id = (options.randomId ?? (() => crypto.randomUUID()))()
  const createdTime = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000)

  const innerJws = await createInboxInnerJws({
    payload: {
      from: options.from,
      to: options.to,
      type: options.type,
      id,
      created_time: createdTime,
      body: options.body,
    },
    sign: options.sign,
    // kid-Konvention aus verification-workflow / identity-vault-handle.
    kid: `${options.from}#sig-0`,
  })

  const eciesContainer = await encryptEcies({
    crypto: options.crypto,
    ephemeralPrivateSeed: await options.crypto.randomBytes(X25519_SEED_LENGTH),
    recipientPublicKey: options.recipientEncryptionPublicKey,
    nonce: await options.crypto.randomBytes(ECIES_NONCE_LENGTH),
    plaintext: new TextEncoder().encode(innerJws),
  })

  const envelope = createPlaintextMessage({
    id,
    type: options.type,
    from: options.from,
    to: [options.to],
    createdTime,
    body: { ...eciesContainer, ...options.extensionFields },
  })
  assertEncryptedInboxEnvelope(envelope, options.type)
  return envelope
}
