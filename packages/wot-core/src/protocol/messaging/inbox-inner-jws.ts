import { createJcsEd25519JwsWithSigner, decodeJws, type JcsEd25519SignFn } from '../crypto/jws'
import type { JsonValue } from '../crypto/jcs'
import type { ProtocolCryptoAdapter } from '../crypto/ports'
import type { DidResolver } from '../identity/did-document'
import { didOrKidToDid, ed25519MultibaseToPublicKeyBytes } from '../identity/did-key'

// Sync 003 Z.465: Replay-Fenster für created_time, "z.B. 24h".
export const INBOX_INNER_JWS_DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

// Obergrenze für zukunftsdatiertes created_time (Clock-Skew). Ohne sie bestünde
// eine Nachricht mit created_time weit in der Zukunft Pflichtprüfung 4
// unbegrenzt, während ihre id nur retention-lang (ab Erstsicht) in der
// Message-ID-History liegt — nach dem Prune wäre dieselbe Nachricht erneut
// zustellbar (Replay-Lücke).
export const INBOX_INNER_JWS_DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

/**
 * Pflichtfelder des inneren JWS-Payloads (Sync 003 Z.458-460 MUSS):
 * `from`, `to`, `type`, `id`, `created_time`. `body` trägt den eigentlichen
 * Klartext-Body (SpaceInviteBody, KeyRotationBody, MemberUpdateBody,
 * AttestationDeliveryBody); `type`/`id` binden den JWS an das äußere Envelope.
 */
export interface InboxInnerJwsPayload {
  from: string
  to: string
  type: string
  id: string
  created_time: number
  body: Record<string, unknown>
}

export interface CreateInboxInnerJwsOptions {
  payload: InboxInnerJwsPayload
  /** Identity-Key-Signer (Ed25519) des Senders. */
  sign: JcsEd25519SignFn
  /** kid-Konvention aus verification-workflow: `${fromDid}#sig-0`. */
  kid: string
}

export async function createInboxInnerJws(options: CreateInboxInnerJwsOptions): Promise<string> {
  assertInboxInnerJwsPayloadShape(options.payload)
  // Sync 003 Z.464: `from` MUSS mit dem JWS-Signierer übereinstimmen — ein kid
  // für eine fremde DID würde beim Empfänger zwingend scheitern, also schon
  // beim Erstellen ablehnen.
  if (didOrKidToDid(options.kid) !== options.payload.from) {
    throw new Error('Inner JWS kid DID does not match payload from')
  }
  return createJcsEd25519JwsWithSigner(
    { alg: 'EdDSA', kid: options.kid },
    options.payload as unknown as JsonValue,
    options.sign,
  )
}

export interface VerifyInboxInnerJwsOptions {
  crypto: ProtocolCryptoAdapter
  didResolver: DidResolver
  /** Pflichtprüfung 2 (Sync 003 Z.463): `to` MUSS die eigene DID sein. */
  ownDid: string
  /** Binding: payload.type MUSS dem `type` des äußeren Envelopes entsprechen. */
  expectedOuterType: string
  /** Binding: payload.id MUSS der `id` des äußeren Envelopes entsprechen. */
  expectedOuterId: string
  now?: () => Date
  /** Pflichtprüfung 4 (Sync 003 Z.465): Replay-Fenster, Default 24h. */
  maxAgeMs?: number
  /**
   * Obergrenze für created_time in der Zukunft (Clock-Skew), Default 5 min —
   * schließt die Replay-Lücke nach dem History-Prune (siehe Konstante oben).
   */
  maxClockSkewMs?: number
}

/**
 * Verifiziert den inneren JWS einer Inbox-Nachricht nach den vier puren
 * MUSS-Prüfungen aus Sync 003 Z.460-465:
 * 1. JWS-Signatur via DidResolver (Signer-Key aus `from` resolven)
 * 2. `to` === ownDid (Misdirection-Schutz)
 * 3. `from` === JWS-Signierer (kid-DID-Match, Sender-Spoofing-Schutz)
 * 4. `created_time` frisch (maxAgeMs) und nicht jenseits des Clock-Skew in
 *    der Zukunft (maxClockSkewMs)
 * Prüfung 5 (Message-ID-History) ist Sache des Aufrufers via
 * MessageIdHistoryPort — dieser Verifier ist pure, kein Storage.
 */
export async function verifyInboxInnerJws(
  jws: string,
  options: VerifyInboxInnerJwsOptions,
): Promise<InboxInnerJwsPayload> {
  const decoded = decodeJws(jws)
  if (typeof decoded.header !== 'object' || decoded.header === null) throw new Error('Invalid JWS header')
  const header = decoded.header as Record<string, unknown>
  if (header.alg !== 'EdDSA') throw new Error('Unsupported JWS alg')
  if (typeof header.kid !== 'string' || header.kid.length === 0) throw new Error('Missing JWS kid')
  const kidDid = didOrKidToDid(header.kid)

  assertInboxInnerJwsPayloadShape(decoded.payload)
  const payload = decoded.payload

  // Prüfung 3: Sender-Spoofing — from muss der Signer sein.
  if (payload.from !== kidDid) throw new Error('Inner JWS from does not match signer')
  // Prüfung 2: Misdirection — Nachricht muss für die eigene DID bestimmt sein.
  if (payload.to !== options.ownDid) throw new Error('Inner JWS to does not match own DID')
  // Outer-Binding (VE-4): type + id müssen das äußere Envelope spiegeln, sonst
  // ließe sich ein gültiger Inner-JWS unter fremdem Envelope wiederverwenden.
  if (payload.type !== options.expectedOuterType) throw new Error('Inner JWS type does not match envelope type')
  if (payload.id !== options.expectedOuterId) throw new Error('Inner JWS id does not match envelope id')
  // Prüfung 4: Replay-Fenster — beidseitig. Die Untergrenze weist veraltete
  // Nachrichten ab; die Obergrenze (Clock-Skew) verhindert, dass ein
  // zukunftsdatiertes created_time die Prüfung über die History-Retention
  // hinaus besteht und nach dem Prune erneut zustellbar wäre.
  const maxAgeMs = options.maxAgeMs ?? INBOX_INNER_JWS_DEFAULT_MAX_AGE_MS
  const maxClockSkewMs = options.maxClockSkewMs ?? INBOX_INNER_JWS_DEFAULT_MAX_CLOCK_SKEW_MS
  const nowMs = (options.now ?? (() => new Date()))().getTime()
  if (nowMs - payload.created_time * 1000 > maxAgeMs) throw new Error('Inner JWS created_time too old')
  if (payload.created_time * 1000 - nowMs > maxClockSkewMs) throw new Error('Inner JWS created_time too far in the future')

  // Prüfung 1: Signatur über den per DidResolver aufgelösten Signer-Key.
  const didDocument = await options.didResolver.resolve(kidDid)
  if (!didDocument) throw new Error('Unable to resolve DID')
  // Resolver-Binding wie in jws-did-verify.ts: ein fremdes Dokument, dessen
  // verificationMethod zufällig zur kid passt, darf nicht akzeptiert werden.
  if (didDocument.id !== kidDid) throw new Error('Resolved DID document does not match DID')
  const verificationMethod = didDocument.verificationMethod.find(
    (method) => method.id === header.kid || (method.id.startsWith('#') && `${kidDid}${method.id}` === header.kid),
  )
  if (!verificationMethod) throw new Error('Unable to resolve verification method')
  const publicKey = ed25519MultibaseToPublicKeyBytes(verificationMethod.publicKeyMultibase)
  const valid = await options.crypto.verifyEd25519(decoded.signingInput, decoded.signature, publicKey)
  if (!valid) throw new Error('Invalid JWS signature')

  return payload
}

function assertInboxInnerJwsPayloadShape(value: unknown): asserts value is InboxInnerJwsPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid inner JWS payload')
  }
  const payload = value as Record<string, unknown>
  for (const field of ['from', 'to', 'type', 'id'] as const) {
    if (typeof payload[field] !== 'string' || (payload[field] as string).length === 0) {
      throw new Error(`Invalid inner JWS payload ${field}`)
    }
  }
  if (!Number.isInteger(payload.created_time) || (payload.created_time as number) < 0) {
    throw new Error('Invalid inner JWS payload created_time')
  }
  if (payload.body === null || typeof payload.body !== 'object' || Array.isArray(payload.body)) {
    throw new Error('Invalid inner JWS payload body')
  }
}
