import type { ProtocolCryptoAdapter } from '../../protocol/crypto/ports'
import type { KeyManagementPort } from '../../ports/key-management'
import {
  evaluateKeyRotationDisposition,
  type KeyRotationDisposition,
} from '../../protocol/sync/key-rotation-disposition'

const SPACE_CONTENT_KEY_LENGTH = 32

export interface CreateSpaceKeyOptions {
  crypto: ProtocolCryptoAdapter
  keyPort: KeyManagementPort
  spaceId: string
}

export type RotateSpaceKeyOptions = CreateSpaceKeyOptions

export interface ApplyKeyRotationOptions {
  keyPort: KeyManagementPort
  spaceId: string
  incomingGeneration: number
  incomingKey: Uint8Array
}

export type ApplyKeyRotationResult = KeyRotationDisposition

/** Sync 001 Z.96/Z.187: a fresh random 32-byte Space Content Key at generation 0. */
export async function createSpaceKey(options: CreateSpaceKeyOptions): Promise<Uint8Array> {
  const key = await options.crypto.randomBytes(SPACE_CONTENT_KEY_LENGTH)
  await options.keyPort.saveKey(options.spaceId, 0, key)
  return key
}

/** Sync 005 Z.285: rotate to generation+1, keeping older keys retrievable. */
export async function rotateSpaceKey(options: RotateSpaceKeyOptions): Promise<Uint8Array> {
  const currentGeneration = await options.keyPort.getCurrentGeneration(options.spaceId)
  if (currentGeneration < 0) throw new Error(`No key exists for space: ${options.spaceId}`)
  const newKey = await options.crypto.randomBytes(SPACE_CONTENT_KEY_LENGTH)
  await options.keyPort.saveKey(options.spaceId, currentGeneration + 1, newKey)
  return newKey
}

/**
 * Apply an incoming key-rotation per the Sync 005 Z.295-299 classifier.
 *
 * An unknown local generation means the initial key has not arrived yet
 * (rotation-before-invite reordering). Per Sync 005 Z.299 this is a future
 * rotation the caller must buffer and catch up on via Sync 002 sources — never
 * applied before the gap is closed, and never an error (the classifier itself
 * requires a non-negative local generation).
 */
export async function applyKeyRotation(options: ApplyKeyRotationOptions): Promise<ApplyKeyRotationResult> {
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
