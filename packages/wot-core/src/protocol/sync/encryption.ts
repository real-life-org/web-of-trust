import { decodeBase64Url, encodeBase64Url } from '../crypto/encoding'
import type { ProtocolCryptoAdapter } from '../crypto/ports'

const ECIES_INFO = 'wot/ecies/v1'
const NONCE_LENGTH = 12
const X25519_KEY_LENGTH = 32
const AES_256_KEY_LENGTH = 32
const AES_GCM_TAG_LENGTH = 16

// Sync 001 fixes ECIES key sizes, AES-GCM nonces, and ciphertext+tag framing.
// Empty plaintext policy is conservative reference hardening; see wot-spec#33.

export interface EciesMessage {
  epk: string
  nonce: string
  ciphertext: string
}

export interface EciesMaterial {
  ephemeralPublicKey: Uint8Array
  sharedSecret: Uint8Array
  aesKey: Uint8Array
}

export interface DeriveEciesMaterialOptions {
  crypto: ProtocolCryptoAdapter
  ephemeralPrivateSeed: Uint8Array
  recipientPublicKey: Uint8Array
}

export interface EncryptEciesOptions extends DeriveEciesMaterialOptions {
  nonce: Uint8Array
  plaintext: Uint8Array
}

export interface DecryptEciesOptions {
  crypto: ProtocolCryptoAdapter
  recipientPrivateSeed: Uint8Array
  message: EciesMessage
}

export interface EncryptLogPayloadOptions {
  crypto: ProtocolCryptoAdapter
  spaceContentKey: Uint8Array
  deviceId: string
  seq: number
  plaintext: Uint8Array
}

export interface LogPayloadEncryptionResult {
  nonce: Uint8Array
  ciphertextTag: Uint8Array
  blob: Uint8Array
  blobBase64Url: string
}

export interface DecryptLogPayloadOptions {
  crypto: ProtocolCryptoAdapter
  spaceContentKey: Uint8Array
  blob: Uint8Array
}

export async function deriveEciesMaterial(options: DeriveEciesMaterialOptions): Promise<EciesMaterial> {
  assertLength(options.ephemeralPrivateSeed, X25519_KEY_LENGTH, 'ECIES ephemeral private seed')
  assertLength(options.recipientPublicKey, X25519_KEY_LENGTH, 'ECIES recipient public key')
  const ephemeralPublicKey = await options.crypto.x25519PublicFromSeed(options.ephemeralPrivateSeed)
  assertLength(ephemeralPublicKey, X25519_KEY_LENGTH, 'ECIES ephemeral public key')
  const sharedSecret = await options.crypto.x25519SharedSecret(options.ephemeralPrivateSeed, options.recipientPublicKey)
  assertLength(sharedSecret, X25519_KEY_LENGTH, 'ECIES shared secret')
  assertNotAllZero(sharedSecret, 'ECIES shared secret')
  const aesKey = await options.crypto.hkdfSha256(sharedSecret, ECIES_INFO, AES_256_KEY_LENGTH)
  assertLength(aesKey, AES_256_KEY_LENGTH, 'ECIES AES key')
  return { ephemeralPublicKey, sharedSecret, aesKey }
}

export async function encryptEcies(options: EncryptEciesOptions): Promise<EciesMessage> {
  assertLength(options.nonce, NONCE_LENGTH, 'ECIES nonce')
  // NEEDS CLARIFICATION(wot-spec#33): AES-GCM permits empty plaintext, but WoT ECIES carries meaningful signed inbox/control payloads.
  assertNonEmpty(options.plaintext, 'ECIES plaintext')
  const material = await deriveEciesMaterial(options)
  const ciphertext = await options.crypto.aes256GcmEncrypt(material.aesKey, options.nonce, options.plaintext)
  assertCiphertextTag(ciphertext, 'ECIES ciphertext')
  return {
    epk: encodeBase64Url(material.ephemeralPublicKey),
    nonce: encodeBase64Url(options.nonce),
    ciphertext: encodeBase64Url(ciphertext),
  }
}

export async function decryptEcies(options: DecryptEciesOptions): Promise<Uint8Array> {
  assertLength(options.recipientPrivateSeed, X25519_KEY_LENGTH, 'ECIES recipient private seed')
  assertEciesMessage(options.message)
  const ephemeralPublicKey = decodeRequiredBase64Url(options.message.epk, 'ECIES ephemeral public key')
  const nonce = decodeRequiredBase64Url(options.message.nonce, 'ECIES nonce')
  const ciphertext = decodeRequiredBase64Url(options.message.ciphertext, 'ECIES ciphertext')
  assertLength(ephemeralPublicKey, X25519_KEY_LENGTH, 'ECIES ephemeral public key')
  assertLength(nonce, NONCE_LENGTH, 'ECIES nonce')
  assertCiphertextTag(ciphertext, 'ECIES ciphertext')
  const sharedSecret = await options.crypto.x25519SharedSecret(options.recipientPrivateSeed, ephemeralPublicKey)
  assertLength(sharedSecret, X25519_KEY_LENGTH, 'ECIES shared secret')
  assertNotAllZero(sharedSecret, 'ECIES shared secret')
  const aesKey = await options.crypto.hkdfSha256(sharedSecret, ECIES_INFO, AES_256_KEY_LENGTH)
  assertLength(aesKey, AES_256_KEY_LENGTH, 'ECIES AES key')
  return options.crypto.aes256GcmDecrypt(aesKey, nonce, ciphertext)
}

export async function deriveLogPayloadNonce(
  cryptoAdapter: ProtocolCryptoAdapter,
  deviceId: string,
  seq: number,
): Promise<Uint8Array> {
  // Sync 001 derives log payload nonces as SHA-256(deviceId || "|" || seq)[0:12].
  if (!deviceId) throw new Error('Missing deviceId')
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid seq')
  const digest = await cryptoAdapter.sha256(new TextEncoder().encode(`${deviceId}|${seq}`))
  return digest.slice(0, NONCE_LENGTH)
}

export async function encryptLogPayload(options: EncryptLogPayloadOptions): Promise<LogPayloadEncryptionResult> {
  assertLength(options.spaceContentKey, AES_256_KEY_LENGTH, 'Space content key')
  // NEEDS CLARIFICATION(wot-spec#33): Sync 002 describes log data as a CRDT update; reject empty updates as conservative hardening.
  assertNonEmpty(options.plaintext, 'Log payload plaintext')
  const nonce = await deriveLogPayloadNonce(options.crypto, options.deviceId, options.seq)
  const ciphertextTag = await options.crypto.aes256GcmEncrypt(options.spaceContentKey, nonce, options.plaintext)
  assertCiphertextTag(ciphertextTag, 'Encrypted log payload ciphertext')
  const blob = concatBytes(nonce, ciphertextTag)
  return { nonce, ciphertextTag, blob, blobBase64Url: encodeBase64Url(blob) }
}

export async function decryptLogPayload(options: DecryptLogPayloadOptions): Promise<Uint8Array> {
  assertLength(options.spaceContentKey, AES_256_KEY_LENGTH, 'Space content key')
  assertEncryptedBlob(options.blob, 'encrypted log payload blob')
  const nonce = options.blob.slice(0, NONCE_LENGTH)
  const ciphertextTag = options.blob.slice(NONCE_LENGTH)
  return options.crypto.aes256GcmDecrypt(options.spaceContentKey, nonce, ciphertextTag)
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.length + second.length)
  result.set(first)
  result.set(second, first.length)
  return result
}

function assertLength(bytes: Uint8Array, expectedLength: number, name: string): void {
  if (bytes.length !== expectedLength) throw new Error(`${name} must be ${expectedLength} bytes`)
}

function assertNotAllZero(bytes: Uint8Array, name: string): void {
  // RFC 7748 low-order peer keys can produce all-zero X25519 outputs; never feed that into HKDF.
  let accumulator = 0
  for (const byte of bytes) accumulator |= byte
  if (accumulator === 0) throw new Error(`${name} must not be all zero bytes`)
}

function assertEciesMessage(value: unknown): asserts value is EciesMessage {
  // Sync 001 encrypted message format is the object { epk, nonce, ciphertext }.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid ECIES message')
  const message = value as Record<string, unknown>
  if (
    typeof message.epk !== 'string' ||
    typeof message.nonce !== 'string' ||
    typeof message.ciphertext !== 'string'
  ) {
    throw new Error('Invalid ECIES message')
  }
}

function assertNonEmpty(bytes: Uint8Array, name: string): void {
  if (bytes.length === 0) throw new Error(`${name} must not be empty`)
}

function assertCiphertextTag(bytes: Uint8Array, name: string): void {
  // NEEDS CLARIFICATION(wot-spec#33): require ciphertext bytes in addition to the 16-byte GCM tag.
  if (bytes.length <= AES_GCM_TAG_LENGTH) throw new Error(`${name} must include ciphertext and authentication tag`)
}

function assertEncryptedBlob(bytes: Uint8Array, name: string): void {
  // Sync 001 frames log data as nonce || ciphertext || tag; wot-spec#33 tracks whether zero ciphertext bytes are valid.
  if (bytes.length <= NONCE_LENGTH + AES_GCM_TAG_LENGTH) throw new Error(`Invalid ${name}`)
}

function decodeRequiredBase64Url(value: string, name: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty base64url string`)
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} must be a valid base64url string`)
  try {
    return decodeBase64Url(value)
  } catch {
    throw new Error(`${name} must be a valid base64url string`)
  }
}
