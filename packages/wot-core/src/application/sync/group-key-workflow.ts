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

/**
 * The fully-generated-but-NOT-yet-persisted key material for the next generation,
 * produced by {@link stageRotateSpaceKey} (Slice SR / VE-C1). It is byte-identical
 * to what {@link rotateSpaceKey} would persist, but held in memory / durable
 * staging until the two-phase removal commits via {@link commitStagedRotation}.
 *
 * `newGeneration`, `contentKey`, `capabilitySigningSeed`, `capabilityVerificationKey`
 * are the raw material a {@link StagedRemovalKeyMaterial} record carries; the
 * owner self-capability JWS is regenerated deterministically from the seed at
 * commit time, so it is NOT part of the durable staging record.
 */
export interface StagedRotationMaterial {
  /** The generation this staged material rotates to (current + 1). */
  newGeneration: number
  /** The NEW Space Content Key (32 bytes). */
  contentKey: Uint8Array
  /** The NEW capability Ed25519 signing seed (32 bytes, private). */
  capabilitySigningSeed: Uint8Array
  /** The NEW capability Ed25519 verification key (32 bytes, public). */
  capabilityVerificationKey: Uint8Array
}

export interface CommitStagedRotationOptions {
  crypto: ProtocolCryptoAdapter
  keyPort: KeyManagementPort
  spaceId: string
  /** Audience of the owner's self-capability (Sync 003 Z.234). */
  ownerDid: string
  /** The staged material to activate (from {@link stageRotateSpaceKey}). */
  staged: StagedRotationMaterial
  now?: () => Date
  /** Capability validity window; default 6 months (Sync 003 Z.249). */
  validityDurationMs?: number
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
  const capabilitySigningSeed = await options.crypto.randomBytes(SPACE_CONTENT_KEY_LENGTH)
  const capabilityVerificationKey = await options.crypto.ed25519PublicKeyFromSeed(capabilitySigningSeed)
  return provisionCapabilityForGeneration(
    options,
    { newGeneration: 0, contentKey, capabilitySigningSeed, capabilityVerificationKey },
    validityMs,
  )
}

/** Sync 005 Z.285: rotate to generation+1, keeping older keys retrievable; fresh capability key pair + self-capability. */
export async function rotateSpaceKey(options: RotateSpaceKeyOptions): Promise<CreateSpaceKeyResult> {
  const validityMs = resolveCapabilityValidityMs(options.validityDurationMs) // fail fast, see createSpaceKey
  const staged = await stageRotateSpaceKey(options)
  // Single-shot rotate = stage immediately followed by commit. The commit
  // persists the content key, the capability key pair, AND the owner's
  // self-capability — byte-identical to the pre-split behaviour.
  return commitStagedRotation({
    crypto: options.crypto,
    keyPort: options.keyPort,
    spaceId: options.spaceId,
    ownerDid: options.ownerDid,
    staged,
    now: options.now,
    validityDurationMs: validityMs,
  })
}

/**
 * Slice SR / VE-C1 — STAGE phase: generate the next-generation key material
 * WITHOUT persisting or activating anything. No `saveKey`, no
 * `saveCapabilityKeyPair`, no `saveOwnCapability` — so `getCurrentGeneration`
 * is UNCHANGED after a stage. The caller holds the returned
 * {@link StagedRotationMaterial} in a durable removal-staging record and only
 * activates it via {@link commitStagedRotation} once every home broker has
 * confirmed the space-rotate. Validity is validated up front (fail-fast) even
 * though it is only consumed at commit, so a bad value surfaces at stage time.
 */
export async function stageRotateSpaceKey(options: RotateSpaceKeyOptions): Promise<StagedRotationMaterial> {
  resolveCapabilityValidityMs(options.validityDurationMs) // fail fast, see createSpaceKey
  const currentGeneration = await options.keyPort.getCurrentGeneration(options.spaceId)
  if (currentGeneration < 0) throw new Error(`No key exists for space: ${options.spaceId}`)
  const newGeneration = currentGeneration + 1
  const contentKey = await options.crypto.randomBytes(SPACE_CONTENT_KEY_LENGTH)
  const capabilitySigningSeed = await options.crypto.randomBytes(SPACE_CONTENT_KEY_LENGTH)
  const capabilityVerificationKey = await options.crypto.ed25519PublicKeyFromSeed(capabilitySigningSeed)
  // Nothing is persisted here: staging must NOT advance the live generation
  // (that is the whole point of staging != commit).
  return { newGeneration, contentKey, capabilitySigningSeed, capabilityVerificationKey }
}

/**
 * Slice SR / VE-C1 — COMMIT phase: activate previously {@link stageRotateSpaceKey}d
 * material. Persists the content key + capability key pair + the owner's
 * self-capability for `staged.newGeneration`, advancing `getCurrentGeneration`
 * to it. Mirrors exactly what {@link rotateSpaceKey} persisted before the split.
 */
export async function commitStagedRotation(options: CommitStagedRotationOptions): Promise<CreateSpaceKeyResult> {
  const validityMs = resolveCapabilityValidityMs(options.validityDurationMs)
  const { spaceId, staged } = options
  // Activate the content key for this generation FIRST, then persist the
  // capability key pair + the owner self-capability (same order as the
  // pre-split rotateSpaceKey path).
  await options.keyPort.saveKey(spaceId, staged.newGeneration, staged.contentKey)
  return provisionCapabilityForGeneration(
    { crypto: options.crypto, keyPort: options.keyPort, spaceId, ownerDid: options.ownerDid, now: options.now },
    staged,
    validityMs,
  )
}

/**
 * Persist the Space Capability key pair + the owner's self-capability for a
 * generation and return the full {@link CreateSpaceKeyResult}. Shared by
 * {@link createSpaceKey} (generation 0) and {@link commitStagedRotation} (a
 * staged rotation commit) so both write byte-identical capability material.
 * The content key itself is persisted by the caller (it differs per path).
 */
async function provisionCapabilityForGeneration(
  options: Pick<CreateSpaceKeyOptions, 'crypto' | 'keyPort' | 'spaceId' | 'ownerDid' | 'now'>,
  material: StagedRotationMaterial,
  validityMs: number,
): Promise<CreateSpaceKeyResult> {
  const { spaceId, keyPort } = options
  const { newGeneration: generation, contentKey, capabilitySigningSeed, capabilityVerificationKey } = material
  await keyPort.saveCapabilityKeyPair(spaceId, generation, capabilitySigningSeed, capabilityVerificationKey)
  const now = (options.now ?? (() => new Date()))()
  const ownCapabilityJws = await createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId,
      audience: options.ownerDid,
      permissions: ['read', 'write'],
      generation,
      issuedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + validityMs).toISOString(),
    },
    signingSeed: capabilitySigningSeed,
  })
  await keyPort.saveOwnCapability(spaceId, generation, ownCapabilityJws)
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
