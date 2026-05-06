import { decodeBase64Url, encodeBase64Url } from '../crypto/encoding'
import type { ProtocolCryptoAdapter } from '../crypto/ports'

const ECIES_INFO = 'wot/ecies/v1'
const NONCE_LENGTH = 12
const X25519_KEY_LENGTH = 32
const AES_256_KEY_LENGTH = 32
const AES_GCM_TAG_LENGTH = 16

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
  const sharedSecret = await options.crypto.x25519SharedSecret(options.ephemeralPrivateSeed, options.recipientPublicKey)
  const aesKey = await options.crypto.hkdfSha256(sharedSecret, ECIES_INFO, 32)
  assertLength(ephemeralPublicKey, X25519_KEY_LENGTH, 'ECIES ephemeral public key')
  assertLength(sharedSecret, X25519_KEY_LENGTH, 'ECIES shared secret')
  assertLength(aesKey, AES_256_KEY_LENGTH, 'ECIES AES key')
  return { ephemeralPublicKey, sharedSecret, aesKey }
}

export async function encryptEcies(options: EncryptEciesOptions): Promise<EciesMessage> {
  assertLength(options.nonce, NONCE_LENGTH, 'ECIES nonce')
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
  const ephemeralPublicKey = decodeRequiredBase64Url(options.message.epk, 'ECIES ephemeral public key')
  const nonce = decodeRequiredBase64Url(options.message.nonce, 'ECIES nonce')
  const ciphertext = decodeRequiredBase64Url(options.message.ciphertext, 'ECIES ciphertext')
  assertLength(ephemeralPublicKey, X25519_KEY_LENGTH, 'ECIES ephemeral public key')
  assertLength(nonce, NONCE_LENGTH, 'ECIES nonce')
  assertCiphertextTag(ciphertext, 'ECIES ciphertext')
  const sharedSecret = await options.crypto.x25519SharedSecret(options.recipientPrivateSeed, ephemeralPublicKey)
  const aesKey = await options.crypto.hkdfSha256(sharedSecret, ECIES_INFO, 32)
  assertLength(aesKey, AES_256_KEY_LENGTH, 'ECIES AES key')
  return options.crypto.aes256GcmDecrypt(aesKey, nonce, ciphertext)
}

export async function deriveLogPayloadNonce(
  cryptoAdapter: ProtocolCryptoAdapter,
  deviceId: string,
  seq: number,
): Promise<Uint8Array> {
  if (!deviceId) throw new Error('Missing deviceId')
  if (!Number.isInteger(seq) || seq < 0) throw new Error('Invalid seq')
  const digest = await cryptoAdapter.sha256(new TextEncoder().encode(`${deviceId}|${seq}`))
  return digest.slice(0, NONCE_LENGTH)
}

export async function encryptLogPayload(options: EncryptLogPayloadOptions): Promise<LogPayloadEncryptionResult> {
  assertLength(options.spaceContentKey, AES_256_KEY_LENGTH, 'Space content key')
  assertNonEmpty(options.plaintext, 'Log payload plaintext')
  const nonce = await deriveLogPayloadNonce(options.crypto, options.deviceId, options.seq)
  const ciphertextTag = await options.crypto.aes256GcmEncrypt(options.spaceContentKey, nonce, options.plaintext)
  assertCiphertextTag(ciphertextTag, 'Encrypted log payload ciphertext')
  const blob = concatBytes(nonce, ciphertextTag)
  return { nonce, ciphertextTag, blob, blobBase64Url: encodeBase64Url(blob) }
}

export async function decryptLogPayload(options: DecryptLogPayloadOptions): Promise<Uint8Array> {
  assertLength(options.spaceContentKey, AES_256_KEY_LENGTH, 'Space content key')
  assertEncryptedBlob(options.blob, 'Encrypted log payload blob')
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

function assertNonEmpty(bytes: Uint8Array, name: string): void {
  if (bytes.length === 0) throw new Error(`${name} must not be empty`)
}

function assertCiphertextTag(bytes: Uint8Array, name: string): void {
  if (bytes.length <= AES_GCM_TAG_LENGTH) throw new Error(`${name} must include ciphertext and authentication tag`)
}

function assertEncryptedBlob(bytes: Uint8Array, name: string): void {
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
