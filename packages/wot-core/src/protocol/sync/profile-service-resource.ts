import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { decodeJws } from '../crypto/jws'
import type { DidDocument, DidResolver } from '../identity/did-document'
import { didOrKidToDid, ed25519MultibaseToPublicKeyBytes } from '../identity/did-key'

const DID_PATTERN = /^did:[a-z0-9]+:.+/
const RFC3339_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const FORBIDDEN_PROFILE_METADATA_KEYS = ['encryptionPublicKey'] as const

export interface ProfileServiceResourcePayload {
  did: string
  version: number
  didDocument: DidDocument
  profile: {
    name: string
    [key: string]: unknown
  }
  updatedAt: string
}

export type ProfileServiceListResourceKind = 'verifications' | 'attestations'

export type ProfileServiceResourceKind = 'profile' | ProfileServiceListResourceKind

export type ProfileServiceListResourcePayload =
  | {
      did: string
      version: number
      verifications: string[]
      attestations?: never
      updatedAt: string
    }
  | {
      did: string
      version: number
      verifications?: never
      attestations: string[]
      updatedAt: string
    }

export type ProfileServiceAnyResourcePayload = ProfileServiceResourcePayload | ProfileServiceListResourcePayload

export interface ValidateProfileServiceResourcePayloadOptions {
  expectedDid: string
}

export interface ValidateProfileServiceListResourcePayloadOptions extends ValidateProfileServiceResourcePayloadOptions {
  resourceKind: ProfileServiceListResourceKind
}

export interface VerifyProfileServiceResourceJwsOptions extends ValidateProfileServiceResourcePayloadOptions {
  resourceKind?: ProfileServiceResourceKind
  didResolver: DidResolver
  crypto: ProtocolCryptoAdapter
}

export interface ProfileResourcePutAcceptanceOptions {
  incomingVersion: number
  storedVersion?: number
}

export type ProfileResourcePutAcceptance =
  | { accept: true }
  | { accept: false; conflictVersion: number }

export interface ProfileResourceRollbackOptions {
  fetchedVersion: number
  lastSeenVersion?: number
}

// Sync 004 `/p/{did}` profile-resource invariants mirrored here: DID/path
// consistency, non-negative version rules, required profile.name, forbidden
// key material, and ISO/date-time updatedAt. Identity 002 boundary mirrored
// here: generic compact EdDSA JWS verification over the exact received signing
// input. NEEDS CLARIFICATION(real-life-org/wot-spec#34): resource-specific JWS
// `typ`, dedicated list schemas, vector ownership, and additional-property
// ownership remain spec-owned and are intentionally not invented in this slice.
export function validateProfileServiceResourcePayload(
  payload: unknown,
  options: ValidateProfileServiceResourcePayloadOptions,
): ProfileServiceResourcePayload {
  const record = assertRecord(payload, 'Invalid profile resource payload')

  if (typeof record.did !== 'string' || !DID_PATTERN.test(record.did)) {
    throw new Error('Invalid profile resource DID')
  }
  if (record.did !== options.expectedDid) throw new Error('Profile resource DID does not match path DID')
  assertVersion(record.version, 'profile resource version')

  assertDidDocument(record.didDocument, record.did)

  const profile = assertRecord(record.profile, 'Invalid profile resource profile metadata')
  if (typeof profile.name !== 'string' || profile.name.length === 0) {
    throw new Error('Invalid profile resource profile name')
  }
  for (const key of FORBIDDEN_PROFILE_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(profile, key)) {
      throw new Error(`Profile resource profile metadata must not contain ${key}`)
    }
  }

  if (!isRfc3339DateTime(record.updatedAt)) throw new Error('Invalid profile resource updatedAt')

  return record as unknown as ProfileServiceResourcePayload
}

export function validateProfileServiceListResourcePayload(
  payload: unknown,
  options: ValidateProfileServiceListResourcePayloadOptions,
): ProfileServiceListResourcePayload {
  const record = assertRecord(payload, 'Invalid profile service list resource payload')

  if (hasOwn(record, 'didDocument') || hasOwn(record, 'profile')) {
    throw new Error('Profile service list resource must not contain didDocument or profile')
  }

  if (typeof record.did !== 'string' || !DID_PATTERN.test(record.did)) {
    throw new Error('Invalid profile service list resource DID')
  }
  if (record.did !== options.expectedDid) {
    throw new Error('Profile service list resource DID does not match path DID')
  }
  assertVersion(record.version, 'profile service list resource version')

  if (!isRfc3339DateTime(record.updatedAt)) throw new Error('Invalid profile service list resource updatedAt')

  const presentListFields = (['verifications', 'attestations'] as const).filter((field) => hasOwn(record, field))
  if (presentListFields.length !== 1) {
    throw new Error('Profile service list resource must contain exactly one list field')
  }

  const listField = presentListFields[0]
  if (listField !== options.resourceKind) {
    throw new Error('Profile service list resource kind does not match payload list field')
  }

  const entries = record[listField]
  if (!Array.isArray(entries) || entries.some((entry) => !isCompactJwsString(entry))) {
    throw new Error('Profile service list resource entries must be compact JWS strings')
  }

  return record as unknown as ProfileServiceListResourcePayload
}

export function decideProfileResourcePutAcceptance(
  options: ProfileResourcePutAcceptanceOptions,
): ProfileResourcePutAcceptance {
  assertVersion(options.incomingVersion, 'incoming profile resource version')
  if (options.storedVersion === undefined) return { accept: true }
  assertVersion(options.storedVersion, 'stored profile resource version')
  if (options.incomingVersion > options.storedVersion) return { accept: true }
  return { accept: false, conflictVersion: options.storedVersion }
}

export function detectProfileResourceRollback(options: ProfileResourceRollbackOptions): boolean {
  assertVersion(options.fetchedVersion, 'fetched profile resource version')
  if (options.lastSeenVersion === undefined) return false
  assertVersion(options.lastSeenVersion, 'last seen profile resource version')
  return options.fetchedVersion < options.lastSeenVersion
}

export async function verifyProfileServiceResourceJws(
  jws: string,
  options: VerifyProfileServiceResourceJwsOptions & { resourceKind: ProfileServiceListResourceKind },
): Promise<ProfileServiceListResourcePayload>
export async function verifyProfileServiceResourceJws(
  jws: string,
  options: VerifyProfileServiceResourceJwsOptions & { resourceKind?: 'profile' },
): Promise<ProfileServiceResourcePayload>
export async function verifyProfileServiceResourceJws(
  jws: string,
  options: VerifyProfileServiceResourceJwsOptions,
): Promise<ProfileServiceAnyResourcePayload>
export async function verifyProfileServiceResourceJws(
  jws: string,
  options: VerifyProfileServiceResourceJwsOptions,
): Promise<ProfileServiceAnyResourcePayload> {
  const decoded = decodeJws(jws)
  const header = assertRecord(decoded.header, 'Invalid JWS header')
  if (header.alg !== 'EdDSA') throw new Error('Unsupported JWS alg')
  if (typeof header.kid !== 'string' || header.kid.length === 0) throw new Error('Missing JWS kid')

  const payload =
    options.resourceKind === 'verifications' || options.resourceKind === 'attestations'
      ? validateProfileServiceListResourcePayload(decoded.payload, {
          expectedDid: options.expectedDid,
          resourceKind: options.resourceKind,
        })
      : validateProfileServiceResourcePayload(decoded.payload, { expectedDid: options.expectedDid })
  if (didOrKidToDid(header.kid) !== payload.did) {
    throw new Error('Profile service resource JWS kid DID does not match payload DID')
  }

  const publicKey = await resolveVerificationPublicKey(header.kid, options.didResolver)
  const valid = await options.crypto.verifyEd25519(decoded.signingInput, decoded.signature, publicKey)
  if (!valid) throw new Error('Invalid JWS signature')
  return payload
}

async function resolveVerificationPublicKey(kid: string, didResolver: DidResolver): Promise<Uint8Array> {
  const did = didOrKidToDid(kid)
  const didDocument = await didResolver.resolve(did)
  if (!didDocument) throw new Error('Unable to resolve profile resource DID')
  assertResolvedDidDocument(didDocument, did)

  const verificationMethod = didDocument.verificationMethod.find((method) => methodIdMatchesKid(method.id, did, kid))
  if (!verificationMethod) throw new Error('Unable to resolve profile resource verification method')
  return ed25519MultibaseToPublicKeyBytes(verificationMethod.publicKeyMultibase)
}

function assertRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function assertVersion(value: unknown, name: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${name}`)
}

function assertDidDocument(value: unknown, expectedDid: string): asserts value is DidDocument {
  const document = assertRecord(value, 'Invalid profile resource DID document')
  if (document.id !== expectedDid) throw new Error('Profile resource DID document id does not match payload DID')
  assertDidDocumentStructure(document, 'Invalid profile resource DID document')
}

function assertResolvedDidDocument(value: unknown, expectedDid: string): asserts value is DidDocument {
  const document = assertRecord(value, 'Invalid resolved profile resource DID document')
  if (document.id !== expectedDid) throw new Error('Resolved profile resource DID document id does not match resolved DID')
  assertDidDocumentStructure(document, 'Invalid resolved profile resource DID document')
}

function assertDidDocumentStructure(document: Record<string, unknown>, message: string): void {
  assertVerificationMethods(document.verificationMethod, message)
  assertStringArray(document.authentication, message)
  assertStringArray(document.assertionMethod, message)
  assertVerificationMethods(document.keyAgreement, message)
  if (document.service !== undefined) assertServices(document.service, message)
}

function assertVerificationMethods(value: unknown, message: string): void {
  if (!Array.isArray(value)) throw new Error(message)
  for (const entry of value) {
    const method = assertRecord(entry, message)
    assertString(method.id, message)
    assertString(method.type, message)
    assertString(method.controller, message)
    assertString(method.publicKeyMultibase, message)
  }
}

function assertServices(value: unknown, message: string): void {
  if (!Array.isArray(value)) throw new Error(message)
  for (const entry of value) {
    const service = assertRecord(entry, message)
    assertString(service.id, message)
    assertString(service.type, message)
    assertString(service.serviceEndpoint, message)
  }
}

function assertStringArray(value: unknown, message: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(message)
}

function assertString(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(message)
}

function isRfc3339DateTime(value: unknown): value is string {
  return typeof value === 'string' && RFC3339_DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
}

function isCompactJwsString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('.')
  return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
}

function methodIdMatchesKid(methodId: string, did: string, kid: string): boolean {
  return methodId === kid || (methodId.startsWith('#') && `${did}${methodId}` === kid)
}
