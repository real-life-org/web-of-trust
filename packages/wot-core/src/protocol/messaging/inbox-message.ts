import {
  DIDCOMM_PLAINTEXT_TYP,
  KEY_ROTATION_MESSAGE_TYPE,
  MEMBER_UPDATE_MESSAGE_TYPE,
  SPACE_INVITE_MESSAGE_TYPE,
  assertPlaintextMessage,
  type DidcommPlaintextMessage,
} from '../sync/membership-messages'
import type { EciesMessage } from '../sync/encryption'
import { isRfc3339DateTime } from '../sync/profile-service-resource'

export const INBOX_MESSAGE_TYPE = 'https://web-of-trust.de/protocols/inbox/1.0' as const

// Sync 003 Z.420-426 (Authentizitätsmatrix): genau diese vier Transport-Typen
// sind Inbox-Nachrichten mit Envelope-Form "Encrypted (ECIES)" + Inner-JWS.
export const ENCRYPTED_INBOX_MESSAGE_TYPES = [
  INBOX_MESSAGE_TYPE,
  SPACE_INVITE_MESSAGE_TYPE,
  MEMBER_UPDATE_MESSAGE_TYPE,
  KEY_ROTATION_MESSAGE_TYPE,
] as const

export type EncryptedInboxMessageType = (typeof ENCRYPTED_INBOX_MESSAGE_TYPES)[number]

export function isEncryptedInboxMessageType(value: string): value is EncryptedInboxMessageType {
  return (ENCRYPTED_INBOX_MESSAGE_TYPES as readonly string[]).includes(value)
}

/**
 * Wire-Body ALLER vier Inbox-Typen: der ECIES-Container aus Sync 001
 * §Verschlüsseltes Nachrichtenformat — exakt die `EciesMessage`-Felder aus
 * protocol/sync/encryption.ts ({ epk, nonce, ciphertext }, Base64URL) plus
 * optionale Extension-Felder (z.B. encryptedDocSnapshot — selbst
 * verschlüsselt, kein Autoritätsträger, reist NICHT im Inner-JWS).
 */
export interface InboxEncryptedBody extends EciesMessage {
  [extension: string]: unknown
}

export const INBOX_ECIES_BODY_FIELDS = ['epk', 'nonce', 'ciphertext'] as const

/**
 * Wire-Validator für die encrypted Outer-Form eines Inbox-Envelopes (K4).
 * Prüft DIDComm-Plaintext-Form + exakte Type-URI + ECIES-Body-Shape.
 * Die logische (entschlüsselte) Form validieren die assert*Message-Funktionen
 * in membership-messages.ts — die existiert auf dem Wire nie.
 */
export function assertEncryptedInboxEnvelope(
  value: unknown,
  expectedType: string,
): asserts value is DidcommPlaintextMessage<InboxEncryptedBody> {
  assertPlaintextMessage(value)
  if (value.type !== expectedType) throw new Error('Invalid inbox envelope type')
  // Sync 003 Z.378/384: Inbox-Nachrichten MÜSSEN `to` setzen.
  if (!Array.isArray(value.to) || value.to.length === 0) throw new Error('Missing inbox envelope to')
  assertInboxEncryptedBody(value.body)
}

export function assertInboxEncryptedBody(value: unknown): asserts value is InboxEncryptedBody {
  const body = assertRecord(value, 'inbox encrypted body')
  for (const field of INBOX_ECIES_BODY_FIELDS) {
    assertBase64Url(body[field], `inbox encrypted body ${field}`)
  }
}

/** Extension-Felder (alles außer dem ECIES-Container) aus einem Inbox-Wire-Body ziehen. */
export function extractInboxExtensionFields(body: InboxEncryptedBody): Record<string, unknown> {
  const extensions: Record<string, unknown> = {}
  const reserved = new Set<string>(INBOX_ECIES_BODY_FIELDS)
  for (const [key, fieldValue] of Object.entries(body)) {
    if (!reserved.has(key)) extensions[key] = fieldValue
  }
  return extensions
}

/**
 * Klartext-Body für `inbox/1.0`-Attestation-Delivery (K2): minimal `{ vcJws }`.
 * Alle lokalen Attestation-Felder (id/from/to/claim/createdAt) werden nach
 * VC-JWS-Verifikation aus dem VC-Payload abgeleitet (jti/iss/sub/
 * credentialSubject.claim/nbf), nicht aus dem Wire-Body.
 * SPEC-UNKLAR: Trust 001/Sync 003 definieren kein Body-Schema für
 * Attestation-Delivery über inbox/1.0 — minimales Schema bis zur Spec-Klärung
 * (wot-spec-Issue, siehe PR).
 */
export interface AttestationDeliveryBody {
  vcJws: string
}

export function assertAttestationDeliveryBody(value: unknown): asserts value is AttestationDeliveryBody {
  const body = assertRecord(value, 'attestation delivery body')
  for (const key of Object.keys(body)) {
    if (key !== 'vcJws') throw new Error(`Invalid attestation delivery body property: ${key}`)
  }
  assertCompactJws(body.vcJws, 'attestation delivery body vcJws')
}

/**
 * Body-Discriminator für den optionalen App-Level Empfangs-Ack (Variante A,
 * "zweites Häkchen"): reist als NORMALE `inbox/1.0`-Nachricht (E2EE, kein
 * eigener äußerer DIDComm-Typ — der äußere Typ wird in den Inner-JWS gebunden
 * und beim Empfang geprüft, siehe inbox-inner-jws.ts). Der Empfänger einer
 * Attestation schickt ihn nach erfolgreichem Verify+Store an die `iss`-DID des
 * Ausstellers zurück; `jti` referenziert die bestätigte Attestation
 * (Attestation-ID = VC-jti). OPTIONAL: Sender MÜSSEN ohne ihn funktionieren
 * (das zweite Häkchen bleibt dann einfach aus, kein Fehler).
 *
 * Der Discriminator (`kind`) unterscheidet den Ack-Body VOR
 * `assertAttestationDeliveryBody()` vom Attestation-Body (`{ vcJws }`) — beide
 * teilen sich den `inbox/1.0`-Empfangspfad ohne Routing-/Relay-Änderung.
 */
export const ATTESTATION_RECEIPT_BODY_KIND = 'attestation-receipt' as const

/**
 * Als `type` (nicht `interface`) deklariert, damit der Body die implizite
 * Index-Signatur erhält und ohne Cast als `Record<string, unknown>` an
 * `deliverInboxMessage` übergeben werden kann.
 */
export type AttestationReceiptBody = {
  kind: typeof ATTESTATION_RECEIPT_BODY_KIND
  /** Attestation-ID (= VC-jti) der bestätigten Attestation. */
  jti: string
  status: 'received'
}

/**
 * Non-throwing Discriminator-Guard: erkennt einen Empfangs-Ack-Body, damit der
 * gemeinsame `inbox/1.0`-Empfangspfad ihn vom Attestation-Body abzweigen kann.
 *
 * EXACT-SHAPE (genau { kind, jti, status }): ein Attestation-Body ({ vcJws })
 * oder ein Hybrid mit zusätzlichem `vcJws` wird NIE als Receipt klassifiziert —
 * der Receipt-Branch läuft VOR `assertAttestationDeliveryBody`, ein zu laxer
 * Guard würde sonst einen Attestation-Body in den Receipt-Pfad umleiten.
 */
export function isAttestationReceiptBody(value: unknown): value is AttestationReceiptBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return (
    Object.keys(body).length === 3 &&
    body.kind === ATTESTATION_RECEIPT_BODY_KIND &&
    typeof body.jti === 'string' &&
    body.jti.length > 0 &&
    body.status === 'received'
  )
}

/**
 * Body-Discriminator für eine Profiländerung an die eigenen Kontakte
 * (wot#386): reist wie der Empfangs-Ack als NORMALE, verschlüsselte
 * `inbox/1.0`-Nachricht an jeden Kontakt einzeln — kein eigener äußerer Typ,
 * keine Relay-Änderung. Sie ersetzt den Old-World-`profile-update`-Umschlag,
 * den das Relay per Whitelist verwirft, und trägt das Profil SELBST, damit
 * Kontakte ohne öffentlichen Profil-Dienst auf dem Stand bleiben.
 *
 * Kein `did` im Body: der Absender ist der verifizierte Inner-JWS-Signer.
 * Ausgelöst nur durch eine bewusste Profiländerung des Nutzers.
 *
 * Träger: Sync 003 `inbox/1.0` (ECIES + Inner-JWS, wie {@link ATTESTATION_RECEIPT_BODY_KIND}).
 * Der `kind`-Vertrag dieses Bodys steht noch NICHT in der Spec — Nachtrag zu
 * Sync 003 ausstehend (gemeinsam mit `attestation-receipt`).
 */
export const PROFILE_UPDATE_BODY_KIND = 'profile-update' as const

/** Obergrenzen gegen aufgeblähte Nachrichten (Avatar als Data-URL, ~200×200 px in der App). */
export const PROFILE_UPDATE_AVATAR_MAX_LENGTH = 512 * 1024
const PROFILE_UPDATE_NAME_MAX_LENGTH = 200
const PROFILE_UPDATE_BIO_MAX_LENGTH = 2000
const PROFILE_UPDATE_LIST_MAX_ENTRIES = 100
const PROFILE_UPDATE_LIST_ENTRY_MAX_LENGTH = 200
const PROFILE_UPDATE_PROFILE_KEYS = new Set(['name', 'bio', 'avatar', 'offers', 'needs', 'updatedAt'])

export type ProfileUpdateProfile = {
  name: string
  bio?: string
  /** `data:image/…`-URL — nie eine externe Adresse (kein Tracking-Pixel). */
  avatar?: string
  offers?: string[]
  needs?: string[]
  /** Zeitpunkt der Profiländerung beim Absender; der Empfänger übernimmt nur Neueres. */
  updatedAt: string
}

/** Als `type` deklariert: implizite Index-Signatur für `deliverInboxMessage` (wie AttestationReceiptBody). */
export type ProfileUpdateBody = {
  kind: typeof PROFILE_UPDATE_BODY_KIND
  profile: ProfileUpdateProfile
}

/** Baut den Body aus einem Profil; leere optionale Felder entfallen, `did` bleibt draußen. */
export function createProfileUpdateBody(profile: {
  did?: string
  name: string
  bio?: string
  avatar?: string
  offers?: string[]
  needs?: string[]
  updatedAt: string
}): ProfileUpdateBody {
  const body: ProfileUpdateBody = {
    kind: PROFILE_UPDATE_BODY_KIND,
    profile: {
      name: profile.name,
      ...(profile.bio ? { bio: profile.bio } : {}),
      ...(profile.avatar ? { avatar: profile.avatar } : {}),
      ...(profile.offers?.length ? { offers: [...profile.offers] } : {}),
      ...(profile.needs?.length ? { needs: [...profile.needs] } : {}),
      updatedAt: profile.updatedAt,
    },
  }
  assertProfileUpdateBody(body)
  return body
}

/**
 * Non-throwing Discriminator: zweigt den Body im gemeinsamen
 * `inbox/1.0`-Empfangspfad ab. Die Form prüft danach
 * {@link assertProfileUpdateBody} — ein Body mit diesem `kind`, aber
 * kaputter Form ist deterministisch ungültig, kein Attestation-Body.
 */
export function isProfileUpdateBody(value: unknown): value is { kind: typeof PROFILE_UPDATE_BODY_KIND } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === PROFILE_UPDATE_BODY_KIND
}

export function assertProfileUpdateBody(value: unknown): asserts value is ProfileUpdateBody {
  const body = assertRecord(value, 'profile-update body')
  if (Object.keys(body).length !== 2 || body.kind !== PROFILE_UPDATE_BODY_KIND) {
    throw new Error('Invalid profile-update body')
  }
  const profile = assertRecord(body.profile, 'profile-update profile')
  for (const key of Object.keys(profile)) {
    if (!PROFILE_UPDATE_PROFILE_KEYS.has(key)) throw new Error(`Invalid profile-update profile key ${key}`)
  }
  assertBoundedString(profile.name, PROFILE_UPDATE_NAME_MAX_LENGTH, 'profile-update name')
  if (profile.bio !== undefined) assertBoundedString(profile.bio, PROFILE_UPDATE_BIO_MAX_LENGTH, 'profile-update bio')
  if (profile.avatar !== undefined) {
    if (typeof profile.avatar !== 'string' || !profile.avatar.startsWith('data:image/')
      || profile.avatar.length > PROFILE_UPDATE_AVATAR_MAX_LENGTH) {
      throw new Error('Invalid profile-update avatar')
    }
  }
  for (const list of ['offers', 'needs'] as const) {
    const entries = profile[list]
    if (entries === undefined) continue
    if (!Array.isArray(entries) || entries.length > PROFILE_UPDATE_LIST_MAX_ENTRIES) {
      throw new Error(`Invalid profile-update ${list}`)
    }
    for (const entry of entries) assertBoundedString(entry, PROFILE_UPDATE_LIST_ENTRY_MAX_LENGTH, `profile-update ${list} entry`)
  }
  // Strict RFC 3339 with timezone: recipients compare it to order updates, so its
  // meaning must not depend on the recipient's local timezone.
  if (!isRfc3339DateTime(profile.updatedAt)) throw new Error('Invalid profile-update updatedAt')
}

function assertBoundedString(value: unknown, maxLength: number, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`Invalid ${name}`)
  }
}

/**
 * Familien-Guard (VE-8): discriminiert die DIDComm-Transport-Envelope-Familie
 * (Sync 003) von Old-World `MessageEnvelope` ({ v: 1, ... }) über das
 * `typ`-Feld. Kein Typ existiert in beiden Familien.
 */
export function isDidcommMessage(value: unknown): value is DidcommPlaintextMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).typ === DIDCOMM_PLAINTEXT_TYP
  )
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertBase64Url(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${name}`)
  }
}

function assertCompactJws(value: unknown, name: string): void {
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
  const parts = value.split('.')
  if (parts.length !== 3) throw new Error(`Invalid ${name}`)
  for (const part of parts) assertBase64Url(part, name)
}
