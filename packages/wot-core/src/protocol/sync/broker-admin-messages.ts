import { decodeJws, type DecodedJws } from '../crypto/jws'
import type { JsonValue } from '../crypto/jcs'
import { createJcsEd25519Jws, createJcsEd25519JwsWithSigner, type JcsEd25519SignFn } from '../crypto/jws'
import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { didKeyToPublicKeyBytes, didOrKidToDid } from '../identity/did-key'
import type { BrokerErrorCode } from './broker-error'

/**
 * Sync 003 broker management Control-Frames (`space-register`, `space-rotate`,
 * `admin-add`, `admin-remove`).
 *
 * Spec refs:
 * - wot-spec Sync 003 `03-wot-sync/003-transport-und-broker.md#space-registrierung-space-register`
 * - wot-spec Sync 003 `03-wot-sync/003-transport-und-broker.md#capability-widerruf-über-rotation`
 * - wot-spec Sync 003 `03-wot-sync/003-transport-und-broker.md#admin-management`
 * - wot-spec Sync 003 `03-wot-sync/003-transport-und-broker.md#authentizitaet-pro-message-typ-normativ`
 * - wot-spec Sync 005 `03-wot-sync/005-gruppen.md#initiale-space-registrierung`
 *
 * Like every Broker management frame, these carry their claim as an **Inner-JWS**
 * (analogous to `device-revoke`): a closed outer frame `{ type, <x>Jws }` wraps a
 * JWS Compact Serialization whose payload is the field-exact management claim.
 * The JWS `kid` references the signing `adminDid` (generic fragment via
 * `didOrKidToDid`, no hardcoded `#sig-0`).
 *
 * These helpers are protocol-only: they parse the closed outer frame, decode the
 * inner JWS payload, and expose bytes for verification. TOFU/first-writer-wins
 * binding, the registered-admin-set lookup, cache invalidation, and runtime error
 * emission remain broker (relay-phase) responsibilities.
 */

export const SPACE_REGISTER_MESSAGE_TYPE = 'space-register' as const
export const SPACE_ROTATE_MESSAGE_TYPE = 'space-rotate' as const
export const ADMIN_ADD_MESSAGE_TYPE = 'admin-add' as const
export const ADMIN_REMOVE_MESSAGE_TYPE = 'admin-remove' as const

// ---------------------------------------------------------------------------
// Inner-JWS payload shapes (field-exact per Sync 003)
// ---------------------------------------------------------------------------

export interface SpaceRegisterPayload {
  type: typeof SPACE_REGISTER_MESSAGE_TYPE
  spaceId: string
  spaceCapabilityVerificationKey: string
  adminDids: string[]
}

export interface SpaceRotatePayload {
  type: typeof SPACE_ROTATE_MESSAGE_TYPE
  spaceId: string
  newSpaceCapabilityVerificationKey: string
  newGeneration: number
}

export interface AdminAddPayload {
  type: typeof ADMIN_ADD_MESSAGE_TYPE
  spaceId: string
  newAdminDid: string
}

export interface AdminRemovePayload {
  type: typeof ADMIN_REMOVE_MESSAGE_TYPE
  spaceId: string
  removedAdminDid: string
}

export type BrokerAdminPayload =
  | SpaceRegisterPayload
  | SpaceRotatePayload
  | AdminAddPayload
  | AdminRemovePayload

// ---------------------------------------------------------------------------
// Outer Control-Frame shapes (closed `{ type, <x>Jws }`)
// ---------------------------------------------------------------------------

export interface SpaceRegisterMessage {
  type: typeof SPACE_REGISTER_MESSAGE_TYPE
  registrationJws: string
}

export interface SpaceRotateMessage {
  type: typeof SPACE_ROTATE_MESSAGE_TYPE
  rotationJws: string
}

export interface AdminAddMessage {
  type: typeof ADMIN_ADD_MESSAGE_TYPE
  adminChangeJws: string
}

export interface AdminRemoveMessage {
  type: typeof ADMIN_REMOVE_MESSAGE_TYPE
  adminChangeJws: string
}

export type BrokerAdminMessage =
  | SpaceRegisterMessage
  | SpaceRotateMessage
  | AdminAddMessage
  | AdminRemoveMessage

export interface ParsedSpaceRegisterMessage extends SpaceRegisterMessage {
  header: Record<string, unknown>
  payload: SpaceRegisterPayload
  signingBytes: Uint8Array
  signatureBytes: Uint8Array
}

export interface ParsedSpaceRotateMessage extends SpaceRotateMessage {
  header: Record<string, unknown>
  payload: SpaceRotatePayload
  signingBytes: Uint8Array
  signatureBytes: Uint8Array
}

export interface ParsedAdminAddMessage extends AdminAddMessage {
  header: Record<string, unknown>
  payload: AdminAddPayload
  signingBytes: Uint8Array
  signatureBytes: Uint8Array
}

export interface ParsedAdminRemoveMessage extends AdminRemoveMessage {
  header: Record<string, unknown>
  payload: AdminRemovePayload
  signingBytes: Uint8Array
  signatureBytes: Uint8Array
}

// ---------------------------------------------------------------------------
// Create-factory option shapes
// ---------------------------------------------------------------------------

export interface CreateSpaceRegisterMessageOptions {
  spaceId: string
  spaceCapabilityVerificationKey: string
  adminDids: string[]
  /**
   * The signing `adminDid` verification-method id (`<did>#<vm>`). Its DID part
   * MUST be one of `adminDids` (TOFU, self-asserting).
   */
  kid: string
  /** Ed25519 signing seed of the signing admin (32 bytes). */
  signingSeed: Uint8Array
}

export interface CreateSpaceRotateMessageOptions {
  spaceId: string
  newSpaceCapabilityVerificationKey: string
  newGeneration: number
  /** The signing `adminDid` verification-method id (`<did>#<vm>`). */
  kid: string
  /** Ed25519 signing seed of the signing admin (32 bytes). */
  signingSeed: Uint8Array
}

export interface CreateAdminAddMessageOptions {
  spaceId: string
  newAdminDid: string
  /** The signing `adminDid` verification-method id (`<did>#<vm>`). */
  kid: string
  /** Ed25519 signing seed of the signing admin (32 bytes). */
  signingSeed: Uint8Array
}

export interface CreateAdminRemoveMessageOptions {
  spaceId: string
  removedAdminDid: string
  /** The signing `adminDid` verification-method id (`<did>#<vm>`). */
  kid: string
  /** Ed25519 signing seed of the signing admin (32 bytes). */
  signingSeed: Uint8Array
}

/**
 * Operation-shaped variant of {@link CreateSpaceRegisterMessageOptions}: instead
 * of a raw `signingSeed` the caller supplies a `sign` function that produces the
 * Ed25519 signature over the JWS signing input. Required when the admin's
 * Identity key lives behind an operation-shaped vault (no raw seed). The signer
 * MUST be the Identity key that `kid`'s `did:key` resolves to — otherwise the
 * relay's `verifySpaceRegisterMessage` rejects it (AUTH_INVALID). The kid's DID
 * MUST still be one of `adminDids`.
 */
export interface CreateSpaceRegisterMessageWithSignerOptions {
  spaceId: string
  spaceCapabilityVerificationKey: string
  adminDids: string[]
  /** The signing `adminDid` verification-method id (`<did>#<vm>`); DID part ∈ adminDids. */
  kid: string
  /** Signs the JWS signing input with the admin Identity Ed25519 key. */
  sign: JcsEd25519SignFn
}

/** Operation-shaped variant of {@link CreateSpaceRotateMessageOptions} (see WithSigner rationale). */
export interface CreateSpaceRotateMessageWithSignerOptions {
  spaceId: string
  newSpaceCapabilityVerificationKey: string
  newGeneration: number
  /** The signing `adminDid` verification-method id (`<did>#<vm>`). */
  kid: string
  /** Signs the JWS signing input with the admin Identity Ed25519 key. */
  sign: JcsEd25519SignFn
}

// ---------------------------------------------------------------------------
// Verify option shapes + result
// ---------------------------------------------------------------------------

export interface VerifySpaceRegisterMessageOptions {
  frame: unknown
  crypto: Pick<ProtocolCryptoAdapter, 'verifyEd25519'>
}

export interface VerifyAdminSignedFrameOptions {
  frame: unknown
  /**
   * The registered `adminDid` the broker is verifying against. The frame's
   * inner JWS `kid` DID MUST equal this DID, and the signature MUST verify
   * against `adminPublicKey`. The relay supplies a registered admin's DID +
   * its derived Ed25519 public key together.
   */
  adminDid: string
  adminPublicKey: Uint8Array
  crypto: Pick<ProtocolCryptoAdapter, 'verifyEd25519'>
}

export type BrokerAdminMessageVerificationResult<Frame, Payload> =
  | {
      disposition: 'accepted'
      frame: Frame
      header: Record<string, unknown>
      payload: Payload
      signingBytes: Uint8Array
      signatureBytes: Uint8Array
    }
  | {
      disposition: 'rejected'
      errorCode: Extract<BrokerErrorCode, 'MALFORMED_MESSAGE' | 'AUTH_INVALID'>
    }

// ===========================================================================
// space-register
// ===========================================================================

export async function createSpaceRegisterMessage(
  options: CreateSpaceRegisterMessageOptions,
): Promise<SpaceRegisterMessage> {
  const payload = parseSpaceRegisterPayload({
    type: SPACE_REGISTER_MESSAGE_TYPE,
    spaceId: options.spaceId,
    spaceCapabilityVerificationKey: options.spaceCapabilityVerificationKey,
    adminDids: options.adminDids,
  })
  assertAdminKidInList(options.kid, payload.adminDids)
  const registrationJws = await createJcsEd25519Jws(
    { alg: 'EdDSA', kid: options.kid },
    payload as unknown as JsonValue,
    options.signingSeed,
  )
  return { type: SPACE_REGISTER_MESSAGE_TYPE, registrationJws }
}

/**
 * Operation-shaped {@link createSpaceRegisterMessage}: signs the inner JWS via a
 * `sign` function (the admin Identity key behind an opaque vault) rather than a
 * raw seed. Identical wire output + identical TOFU constraint (kid-DID ∈
 * adminDids). Used by the replication adapters whose IdentitySession never
 * exposes the seed, so the JWS signature matches the kid-DID's `did:key` and the
 * real relay accepts the registration.
 */
export async function createSpaceRegisterMessageWithSigner(
  options: CreateSpaceRegisterMessageWithSignerOptions,
): Promise<SpaceRegisterMessage> {
  const payload = parseSpaceRegisterPayload({
    type: SPACE_REGISTER_MESSAGE_TYPE,
    spaceId: options.spaceId,
    spaceCapabilityVerificationKey: options.spaceCapabilityVerificationKey,
    adminDids: options.adminDids,
  })
  assertAdminKidInList(options.kid, payload.adminDids)
  const registrationJws = await createJcsEd25519JwsWithSigner(
    { alg: 'EdDSA', kid: options.kid },
    payload as unknown as JsonValue,
    options.sign,
  )
  return { type: SPACE_REGISTER_MESSAGE_TYPE, registrationJws }
}

export function parseSpaceRegisterMessage(value: unknown): ParsedSpaceRegisterMessage {
  const frame = assertRecord(value, 'space-register control-frame')
  assertTopLevelKeys(frame, ['type', 'registrationJws'], 'space-register control-frame')
  if (frame.type !== SPACE_REGISTER_MESSAGE_TYPE) {
    throw new Error('Invalid space-register control-frame type')
  }
  if (typeof frame.registrationJws !== 'string' || !isCompactJws(frame.registrationJws)) {
    throw new Error('Invalid space-register registrationJws')
  }
  const decoded = decodeInnerJws(frame.registrationJws, 'registrationJws')
  const payload = parseSpaceRegisterPayload(decoded.payload)
  return {
    type: SPACE_REGISTER_MESSAGE_TYPE,
    registrationJws: frame.registrationJws,
    header: decoded.header,
    payload,
    signingBytes: decoded.signingInput,
    signatureBytes: decoded.signature,
  }
}

export function assertSpaceRegisterMessage(value: unknown): asserts value is SpaceRegisterMessage {
  parseSpaceRegisterMessage(value)
}

/**
 * Verifies a `space-register` frame under TOFU/first-writer-wins: the inner JWS
 * `kid` DID MUST be one of the payload's self-asserted `adminDids`, and the
 * signature MUST verify against that kid-DID's Ed25519 key (the signer is
 * self-asserting at first register; the broker derives the key from the
 * `did:key` kid). first-writer-wins binding against an existing registration is
 * a broker (relay-phase) responsibility.
 */
export async function verifySpaceRegisterMessage(
  options: VerifySpaceRegisterMessageOptions,
): Promise<BrokerAdminMessageVerificationResult<SpaceRegisterMessage, SpaceRegisterPayload>> {
  assertVerifier(options.crypto)

  let parsed: ParsedSpaceRegisterMessage
  let signerPublicKey: Uint8Array
  try {
    parsed = parseSpaceRegisterMessage(options.frame)
  } catch {
    return { disposition: 'rejected', errorCode: 'MALFORMED_MESSAGE' }
  }

  const kidDid = adminAuthHeaderKidDid(parsed.header)
  if (kidDid === null || !parsed.payload.adminDids.includes(kidDid)) {
    return { disposition: 'rejected', errorCode: 'AUTH_INVALID' }
  }

  try {
    signerPublicKey = didKeyToPublicKeyBytes(kidDid)
  } catch {
    return { disposition: 'rejected', errorCode: 'AUTH_INVALID' }
  }

  return finishVerification(
    options.crypto,
    parsed.signingBytes,
    parsed.signatureBytes,
    signerPublicKey,
    { type: parsed.type, registrationJws: parsed.registrationJws },
    parsed.header,
    parsed.payload,
  )
}

// ===========================================================================
// space-rotate
// ===========================================================================

export async function createSpaceRotateMessage(
  options: CreateSpaceRotateMessageOptions,
): Promise<SpaceRotateMessage> {
  const payload = parseSpaceRotatePayload({
    type: SPACE_ROTATE_MESSAGE_TYPE,
    spaceId: options.spaceId,
    newSpaceCapabilityVerificationKey: options.newSpaceCapabilityVerificationKey,
    newGeneration: options.newGeneration,
  })
  assertAdminKid(options.kid)
  const rotationJws = await createJcsEd25519Jws(
    { alg: 'EdDSA', kid: options.kid },
    payload as unknown as JsonValue,
    options.signingSeed,
  )
  return { type: SPACE_ROTATE_MESSAGE_TYPE, rotationJws }
}

/**
 * Operation-shaped {@link createSpaceRotateMessage}: signs the inner JWS via a
 * `sign` function (the admin Identity key behind an opaque vault) rather than a
 * raw seed. Identical wire output. The relay's `resolveAdminSigner` derives the
 * signer from the JWS `kid` and requires the signature to verify against that
 * `did:key`, so the signer MUST be the admin's Identity key.
 */
export async function createSpaceRotateMessageWithSigner(
  options: CreateSpaceRotateMessageWithSignerOptions,
): Promise<SpaceRotateMessage> {
  const payload = parseSpaceRotatePayload({
    type: SPACE_ROTATE_MESSAGE_TYPE,
    spaceId: options.spaceId,
    newSpaceCapabilityVerificationKey: options.newSpaceCapabilityVerificationKey,
    newGeneration: options.newGeneration,
  })
  assertAdminKid(options.kid)
  const rotationJws = await createJcsEd25519JwsWithSigner(
    { alg: 'EdDSA', kid: options.kid },
    payload as unknown as JsonValue,
    options.sign,
  )
  return { type: SPACE_ROTATE_MESSAGE_TYPE, rotationJws }
}

export function parseSpaceRotateMessage(value: unknown): ParsedSpaceRotateMessage {
  const frame = assertRecord(value, 'space-rotate control-frame')
  assertTopLevelKeys(frame, ['type', 'rotationJws'], 'space-rotate control-frame')
  if (frame.type !== SPACE_ROTATE_MESSAGE_TYPE) {
    throw new Error('Invalid space-rotate control-frame type')
  }
  if (typeof frame.rotationJws !== 'string' || !isCompactJws(frame.rotationJws)) {
    throw new Error('Invalid space-rotate rotationJws')
  }
  const decoded = decodeInnerJws(frame.rotationJws, 'rotationJws')
  const payload = parseSpaceRotatePayload(decoded.payload)
  return {
    type: SPACE_ROTATE_MESSAGE_TYPE,
    rotationJws: frame.rotationJws,
    header: decoded.header,
    payload,
    signingBytes: decoded.signingInput,
    signatureBytes: decoded.signature,
  }
}

export function assertSpaceRotateMessage(value: unknown): asserts value is SpaceRotateMessage {
  parseSpaceRotateMessage(value)
}

export async function verifySpaceRotateMessage(
  options: VerifyAdminSignedFrameOptions,
): Promise<BrokerAdminMessageVerificationResult<SpaceRotateMessage, SpaceRotatePayload>> {
  return verifyAdminSignedFrame(options, parseSpaceRotateMessage, (parsed) => ({
    type: parsed.type,
    rotationJws: parsed.rotationJws,
  }))
}

// ===========================================================================
// admin-add
// ===========================================================================

export async function createAdminAddMessage(
  options: CreateAdminAddMessageOptions,
): Promise<AdminAddMessage> {
  const payload = parseAdminAddPayload({
    type: ADMIN_ADD_MESSAGE_TYPE,
    spaceId: options.spaceId,
    newAdminDid: options.newAdminDid,
  })
  assertAdminKid(options.kid)
  const adminChangeJws = await createJcsEd25519Jws(
    { alg: 'EdDSA', kid: options.kid },
    payload as unknown as JsonValue,
    options.signingSeed,
  )
  return { type: ADMIN_ADD_MESSAGE_TYPE, adminChangeJws }
}

export function parseAdminAddMessage(value: unknown): ParsedAdminAddMessage {
  const frame = assertRecord(value, 'admin-add control-frame')
  assertTopLevelKeys(frame, ['type', 'adminChangeJws'], 'admin-add control-frame')
  if (frame.type !== ADMIN_ADD_MESSAGE_TYPE) {
    throw new Error('Invalid admin-add control-frame type')
  }
  if (typeof frame.adminChangeJws !== 'string' || !isCompactJws(frame.adminChangeJws)) {
    throw new Error('Invalid admin-add adminChangeJws')
  }
  const decoded = decodeInnerJws(frame.adminChangeJws, 'adminChangeJws')
  const payload = parseAdminAddPayload(decoded.payload)
  return {
    type: ADMIN_ADD_MESSAGE_TYPE,
    adminChangeJws: frame.adminChangeJws,
    header: decoded.header,
    payload,
    signingBytes: decoded.signingInput,
    signatureBytes: decoded.signature,
  }
}

export function assertAdminAddMessage(value: unknown): asserts value is AdminAddMessage {
  parseAdminAddMessage(value)
}

export async function verifyAdminAddMessage(
  options: VerifyAdminSignedFrameOptions,
): Promise<BrokerAdminMessageVerificationResult<AdminAddMessage, AdminAddPayload>> {
  return verifyAdminSignedFrame(options, parseAdminAddMessage, (parsed) => ({
    type: parsed.type,
    adminChangeJws: parsed.adminChangeJws,
  }))
}

// ===========================================================================
// admin-remove
// ===========================================================================

export async function createAdminRemoveMessage(
  options: CreateAdminRemoveMessageOptions,
): Promise<AdminRemoveMessage> {
  const payload = parseAdminRemovePayload({
    type: ADMIN_REMOVE_MESSAGE_TYPE,
    spaceId: options.spaceId,
    removedAdminDid: options.removedAdminDid,
  })
  assertAdminKid(options.kid)
  const adminChangeJws = await createJcsEd25519Jws(
    { alg: 'EdDSA', kid: options.kid },
    payload as unknown as JsonValue,
    options.signingSeed,
  )
  return { type: ADMIN_REMOVE_MESSAGE_TYPE, adminChangeJws }
}

export function parseAdminRemoveMessage(value: unknown): ParsedAdminRemoveMessage {
  const frame = assertRecord(value, 'admin-remove control-frame')
  assertTopLevelKeys(frame, ['type', 'adminChangeJws'], 'admin-remove control-frame')
  if (frame.type !== ADMIN_REMOVE_MESSAGE_TYPE) {
    throw new Error('Invalid admin-remove control-frame type')
  }
  if (typeof frame.adminChangeJws !== 'string' || !isCompactJws(frame.adminChangeJws)) {
    throw new Error('Invalid admin-remove adminChangeJws')
  }
  const decoded = decodeInnerJws(frame.adminChangeJws, 'adminChangeJws')
  const payload = parseAdminRemovePayload(decoded.payload)
  return {
    type: ADMIN_REMOVE_MESSAGE_TYPE,
    adminChangeJws: frame.adminChangeJws,
    header: decoded.header,
    payload,
    signingBytes: decoded.signingInput,
    signatureBytes: decoded.signature,
  }
}

export function assertAdminRemoveMessage(value: unknown): asserts value is AdminRemoveMessage {
  parseAdminRemoveMessage(value)
}

export async function verifyAdminRemoveMessage(
  options: VerifyAdminSignedFrameOptions,
): Promise<BrokerAdminMessageVerificationResult<AdminRemoveMessage, AdminRemovePayload>> {
  return verifyAdminSignedFrame(options, parseAdminRemoveMessage, (parsed) => ({
    type: parsed.type,
    adminChangeJws: parsed.adminChangeJws,
  }))
}

// ===========================================================================
// Dispatchers
// ===========================================================================

export function parseBrokerAdminMessage(value: unknown): BrokerAdminMessage {
  const message = assertRecord(value, 'broker admin message')
  switch (message.type) {
    case SPACE_REGISTER_MESSAGE_TYPE: {
      const parsed = parseSpaceRegisterMessage(message)
      return { type: parsed.type, registrationJws: parsed.registrationJws }
    }
    case SPACE_ROTATE_MESSAGE_TYPE: {
      const parsed = parseSpaceRotateMessage(message)
      return { type: parsed.type, rotationJws: parsed.rotationJws }
    }
    case ADMIN_ADD_MESSAGE_TYPE: {
      const parsed = parseAdminAddMessage(message)
      return { type: parsed.type, adminChangeJws: parsed.adminChangeJws }
    }
    case ADMIN_REMOVE_MESSAGE_TYPE: {
      const parsed = parseAdminRemoveMessage(message)
      return { type: parsed.type, adminChangeJws: parsed.adminChangeJws }
    }
    default:
      throw new Error('Invalid broker admin message type')
  }
}

export function assertBrokerAdminMessage(value: unknown): asserts value is BrokerAdminMessage {
  parseBrokerAdminMessage(value)
}

// ===========================================================================
// Internal: shared verify path for admin-signed frames (rotate/add/remove)
// ===========================================================================

async function verifyAdminSignedFrame<
  Parsed extends {
    header: Record<string, unknown>
    signingBytes: Uint8Array
    signatureBytes: Uint8Array
  },
  Frame,
>(
  options: VerifyAdminSignedFrameOptions,
  parse: (value: unknown) => Parsed,
  toFrame: (parsed: Parsed) => Frame,
): Promise<
  BrokerAdminMessageVerificationResult<
    Frame,
    Parsed extends { payload: infer P } ? P : never
  >
> {
  assertVerifier(options.crypto)
  assertEd25519PublicKey(options.adminPublicKey)
  if (typeof options.adminDid !== 'string' || options.adminDid.length === 0) {
    throw new Error('Invalid broker admin message adminDid')
  }

  let parsed: Parsed
  try {
    parsed = parse(options.frame)
  } catch {
    return { disposition: 'rejected', errorCode: 'MALFORMED_MESSAGE' }
  }

  // Generic kid binding: the inner JWS signer (kid-DID) MUST be the registered
  // admin the broker is verifying against — analogous to device-revoke's
  // `didOrKidToDid(kid) === payload.did`, but the admin DID lives in the kid
  // (the management payloads do not carry the signer DID).
  const kidDid = adminAuthHeaderKidDid(parsed.header)
  if (kidDid === null || kidDid !== options.adminDid) {
    return { disposition: 'rejected', errorCode: 'AUTH_INVALID' }
  }

  return finishVerification(
    options.crypto,
    parsed.signingBytes,
    parsed.signatureBytes,
    options.adminPublicKey,
    toFrame(parsed),
    parsed.header,
    (parsed as unknown as { payload: Parsed extends { payload: infer P } ? P : never }).payload,
  )
}

async function finishVerification<Frame, Payload>(
  crypto: Pick<ProtocolCryptoAdapter, 'verifyEd25519'>,
  signingBytes: Uint8Array,
  signatureBytes: Uint8Array,
  publicKey: Uint8Array,
  frame: Frame,
  header: Record<string, unknown>,
  payload: Payload,
): Promise<BrokerAdminMessageVerificationResult<Frame, Payload>> {
  let signatureValid: boolean
  try {
    signatureValid = await crypto.verifyEd25519(signingBytes, signatureBytes, publicKey)
  } catch {
    return { disposition: 'rejected', errorCode: 'AUTH_INVALID' }
  }
  if (!signatureValid) {
    return { disposition: 'rejected', errorCode: 'AUTH_INVALID' }
  }
  return {
    disposition: 'accepted',
    frame,
    header,
    payload,
    signingBytes,
    signatureBytes,
  }
}

// ===========================================================================
// Payload parsers (field-exact)
// ===========================================================================

function parseSpaceRegisterPayload(value: unknown): SpaceRegisterPayload {
  const payload = assertRecord(value, 'space-register payload')
  assertExactKeys(
    payload,
    ['type', 'spaceId', 'spaceCapabilityVerificationKey', 'adminDids'],
    'space-register payload',
  )
  if (payload.type !== SPACE_REGISTER_MESSAGE_TYPE) throw new Error('Invalid space-register payload type')
  const spaceId = parseCanonicalUuidV4(payload.spaceId, 'space-register payload spaceId')
  const spaceCapabilityVerificationKey = parseNonEmptyString(
    payload.spaceCapabilityVerificationKey,
    'space-register payload spaceCapabilityVerificationKey',
  )
  const adminDids = parseAdminDids(payload.adminDids, 'space-register payload adminDids')
  return { type: SPACE_REGISTER_MESSAGE_TYPE, spaceId, spaceCapabilityVerificationKey, adminDids }
}

function parseSpaceRotatePayload(value: unknown): SpaceRotatePayload {
  const payload = assertRecord(value, 'space-rotate payload')
  assertExactKeys(
    payload,
    ['type', 'spaceId', 'newSpaceCapabilityVerificationKey', 'newGeneration'],
    'space-rotate payload',
  )
  if (payload.type !== SPACE_ROTATE_MESSAGE_TYPE) throw new Error('Invalid space-rotate payload type')
  const spaceId = parseCanonicalUuidV4(payload.spaceId, 'space-rotate payload spaceId')
  const newSpaceCapabilityVerificationKey = parseNonEmptyString(
    payload.newSpaceCapabilityVerificationKey,
    'space-rotate payload newSpaceCapabilityVerificationKey',
  )
  const newGeneration = parseNonNegativeSafeInteger(
    payload.newGeneration,
    'space-rotate payload newGeneration',
  )
  return { type: SPACE_ROTATE_MESSAGE_TYPE, spaceId, newSpaceCapabilityVerificationKey, newGeneration }
}

function parseAdminAddPayload(value: unknown): AdminAddPayload {
  const payload = assertRecord(value, 'admin-add payload')
  assertExactKeys(payload, ['type', 'spaceId', 'newAdminDid'], 'admin-add payload')
  if (payload.type !== ADMIN_ADD_MESSAGE_TYPE) throw new Error('Invalid admin-add payload type')
  const spaceId = parseCanonicalUuidV4(payload.spaceId, 'admin-add payload spaceId')
  const newAdminDid = parseDid(payload.newAdminDid, 'admin-add payload newAdminDid')
  return { type: ADMIN_ADD_MESSAGE_TYPE, spaceId, newAdminDid }
}

function parseAdminRemovePayload(value: unknown): AdminRemovePayload {
  const payload = assertRecord(value, 'admin-remove payload')
  assertExactKeys(payload, ['type', 'spaceId', 'removedAdminDid'], 'admin-remove payload')
  if (payload.type !== ADMIN_REMOVE_MESSAGE_TYPE) throw new Error('Invalid admin-remove payload type')
  const spaceId = parseCanonicalUuidV4(payload.spaceId, 'admin-remove payload spaceId')
  const removedAdminDid = parseDid(payload.removedAdminDid, 'admin-remove payload removedAdminDid')
  return { type: ADMIN_REMOVE_MESSAGE_TYPE, spaceId, removedAdminDid }
}

// ===========================================================================
// Internal helpers
// ===========================================================================

function isCompactJws(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 3 && parts.every((part) => part.length > 0)
}

function decodeInnerJws(
  jws: string,
  field: string,
): DecodedJws<Record<string, unknown>, Record<string, unknown>> {
  let decoded: DecodedJws<Record<string, unknown>, Record<string, unknown>>
  try {
    decoded = decodeJws<Record<string, unknown>, Record<string, unknown>>(jws)
  } catch {
    throw new Error(`Invalid broker admin ${field}`)
  }
  if (typeof decoded.header !== 'object' || decoded.header === null) {
    throw new Error(`Invalid broker admin ${field}`)
  }
  return decoded
}

/**
 * Returns the kid-DID of an admin auth header (alg=EdDSA, generic `<did>#<vm>`
 * kid), or null if the header is not a valid admin auth header. No hardcoded
 * fragment — the DID is extracted via `didOrKidToDid`.
 */
function adminAuthHeaderKidDid(header: Record<string, unknown>): string | null {
  if (header.alg !== 'EdDSA') return null
  if (typeof header.kid !== 'string' || header.kid.length === 0) return null
  if (!header.kid.includes('#')) return null
  return didOrKidToDid(header.kid)
}

function assertAdminKid(kid: unknown): asserts kid is string {
  if (typeof kid !== 'string' || kid.length === 0 || !kid.includes('#')) {
    throw new Error('Invalid broker admin message kid')
  }
  if (!didOrKidToDid(kid).startsWith('did:')) {
    throw new Error('Invalid broker admin message kid')
  }
}

function assertAdminKidInList(kid: unknown, adminDids: readonly string[]): asserts kid is string {
  assertAdminKid(kid)
  if (!adminDids.includes(didOrKidToDid(kid as string))) {
    throw new Error('space-register kid DID is not one of adminDids')
  }
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertTopLevelKeys(
  frame: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const expected = new Set(allowed)
  for (const key of Reflect.ownKeys(frame)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`Invalid ${name} property: ${String(key)}`)
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(frame, key)) throw new Error(`Invalid ${name} ${key}`)
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const expected = new Set(allowed)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`Invalid ${name} property: ${String(key)}`)
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`Invalid ${name} ${key}`)
  }
}

function parseCanonicalUuidV4(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new Error(`Invalid ${name}`)
  }
  return value
}

function parseNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${name}`)
  return value
}

function parseDid(value: unknown, name: string): string {
  const did = parseNonEmptyString(value, name)
  if (!did.startsWith('did:')) throw new Error(`Invalid ${name}`)
  return did
}

function parseAdminDids(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Invalid ${name}`)
  const seen = new Set<string>()
  const dids: string[] = []
  for (const entry of value) {
    const did = parseDid(entry, `${name} entry`)
    if (seen.has(did)) throw new Error(`Duplicate ${name} entry`)
    seen.add(did)
    dids.push(did)
  }
  return dids
}

function parseNonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${name}`)
  return value as number
}

function assertEd25519PublicKey(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error('Invalid broker admin message admin public key')
  }
}

function assertVerifier(value: unknown): asserts value is Pick<ProtocolCryptoAdapter, 'verifyEd25519'> {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Pick<ProtocolCryptoAdapter, 'verifyEd25519'>).verifyEd25519 !== 'function'
  ) {
    throw new Error('Invalid broker admin message verifier')
  }
}
