import type { ProtocolCryptoAdapter } from '../../protocol/crypto/ports'
import type { KeyManagementPort } from '../../ports/key-management'
import { createSpaceCapabilityJws } from '../../protocol/sync/space-capability'
import {
  evaluateKeyRotationDisposition,
  type KeyRotationDisposition,
} from '../../protocol/sync/key-rotation-disposition'

const SPACE_CONTENT_KEY_LENGTH = 32
/** Sync 003 Z.249: default capability validity for normal spaces. */
export const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000

/**
 * Resolve a caller-provided capability validity window. `0`, negative, `NaN` or
 * `Infinity` would mint immediately-expired or invalid capabilities — fail fast
 * instead of letting a bad value reach `validUntil` arithmetic.
 */
export function resolveCapabilityValidityMs(validityDurationMs?: number): number {
  if (validityDurationMs === undefined) return SIX_MONTHS_MS
  if (!Number.isFinite(validityDurationMs) || validityDurationMs <= 0) {
    throw new Error('validityDurationMs must be a positive finite number of milliseconds')
  }
  return validityDurationMs
}

export interface CreateSpaceKeyResult {
  contentKey: Uint8Array
  capabilitySigningSeed: Uint8Array
  capabilityVerificationKey: Uint8Array
  ownCapabilityJws: string
}

export interface CreateSpaceKeyOptions {
  crypto: ProtocolCryptoAdapter
  keyPort: KeyManagementPort
  spaceId: string
  /** Audience of the owner's self-capability (Sync 003 Z.234). */
  ownerDid: string
  now?: () => Date
  /** Capability validity window; default 6 months (Sync 003 Z.249). */
  validityDurationMs?: number
}

export type RotateSpaceKeyOptions = CreateSpaceKeyOptions

export interface ApplyKeyRotationOptions {
  keyPort: KeyManagementPort
  spaceId: string
  incomingGeneration: number
  incomingKey: Uint8Array
}

export type ApplyKeyRotationResult = KeyRotationDisposition

/**
 * Sync 001 Z.96/Z.187 + Sync 003 Z.234: a fresh Space Content Key at generation 0,
 * plus a fresh Space Capability key pair and the owner's self-capability.
 */
export async function createSpaceKey(options: CreateSpaceKeyOptions): Promise<CreateSpaceKeyResult> {
  // Validate the validity window BEFORE persisting anything — a bad value must not
  // leave a content key without capability material behind.
  const validityMs = resolveCapabilityValidityMs(options.validityDurationMs)
  // Fail-fast for an existing space: overwriting generation 0 while higher
  // generations remain would corrupt key history (Sync 001 Z.96: one key per
  // docId per generation). A space key is created exactly once; advance
  // generations via rotateSpaceKey.
  const existingGeneration = await options.keyPort.getCurrentGeneration(options.spaceId)
  if (existingGeneration >= 0) {
    throw new Error(`Space key already exists for space: ${options.spaceId}`)
  }
  const contentKey = await options.crypto.randomBytes(SPACE_CONTENT_KEY_LENGTH)
  await options.keyPort.saveKey(options.spaceId, 0, contentKey)
  return provisionCapabilityForGeneration(options, 0, contentKey, validityMs)
}

/** Sync 005 Z.285: rotate to generation+1, keeping older keys retrievable; fresh capability key pair + self-capability. */
export async function rotateSpaceKey(options: RotateSpaceKeyOptions): Promise<CreateSpaceKeyResult> {
  const validityMs = resolveCapabilityValidityMs(options.validityDurationMs) // fail fast, see createSpaceKey
  const currentGeneration = await options.keyPort.getCurrentGeneration(options.spaceId)
  if (currentGeneration < 0) throw new Error(`No key exists for space: ${options.spaceId}`)
  const newGeneration = currentGeneration + 1
  const newKey = await options.crypto.randomBytes(SPACE_CONTENT_KEY_LENGTH)
  await options.keyPort.saveKey(options.spaceId, newGeneration, newKey)
  return provisionCapabilityForGeneration(options, newGeneration, newKey, validityMs)
}

/** Generate + persist the Space Capability key pair and the owner's self-capability for a generation. */
async function provisionCapabilityForGeneration(
  options: CreateSpaceKeyOptions,
  generation: number,
  contentKey: Uint8Array,
  validityMs: number,
): Promise<CreateSpaceKeyResult> {
  const capabilitySigningSeed = await options.crypto.randomBytes(SPACE_CONTENT_KEY_LENGTH)
  const capabilityVerificationKey = await options.crypto.ed25519PublicKeyFromSeed(capabilitySigningSeed)
  await options.keyPort.saveCapabilityKeyPair(options.spaceId, generation, capabilitySigningSeed, capabilityVerificationKey)

  const now = (options.now ?? (() => new Date()))()
  const ownCapabilityJws = await createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: options.spaceId,
      audience: options.ownerDid,
      permissions: ['read', 'write'],
      generation,
      issuedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + validityMs).toISOString(),
    },
    signingSeed: capabilitySigningSeed,
  })
  await options.keyPort.saveOwnCapability(options.spaceId, generation, ownCapabilityJws)
  return { contentKey, capabilitySigningSeed, capabilityVerificationKey, ownCapabilityJws }
}

/**
 * Apply an incoming key-rotation per the Sync 005 Z.295-299 classifier.
 *
 * An unknown local generation means the initial key has not arrived yet
 * (rotation-before-invite reordering). Per Sync 005 Z.299 a *valid* future
 * rotation for an unknown space is buffered (the caller catches up via Sync 002
 * sources), never applied before the gap is closed. A malformed
 * incomingGeneration is rejected up front, whether or not the space is known.
 */
export async function applyKeyRotation(options: ApplyKeyRotationOptions): Promise<ApplyKeyRotationResult> {
  // Reject a malformed generation before the unknown-space early return below,
  // so a bad wire value can never be classified as bufferable.
  if (!Number.isSafeInteger(options.incomingGeneration) || options.incomingGeneration < 0) {
    throw new Error('Invalid key-rotation generation')
  }
  const localGeneration = await options.keyPort.getCurrentGeneration(options.spaceId)
  if (localGeneration < 0) return 'future-buffer'
  const disposition = evaluateKeyRotationDisposition({
    localGeneration,
    incomingGeneration: options.incomingGeneration,
  })
  if (disposition === 'apply') {
    await options.keyPort.saveKey(options.spaceId, options.incomingGeneration, options.incomingKey)
  }
  return disposition
}

/** Store a key received out-of-band (e.g. a space-invite) at its generation. */
export async function importKey(
  keyPort: KeyManagementPort,
  spaceId: string,
  generation: number,
  key: Uint8Array,
): Promise<void> {
  await keyPort.saveKey(spaceId, generation, key)
}
