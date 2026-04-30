import { decodeBase64Url, encodeBase64Url } from '../crypto/encoding'
import type { ProtocolCryptoAdapter } from '../crypto/ports'

const ECIES_INFO = 'wot/ecies/v1'
const NONCE_LENGTH = 12

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
  const ephemeralPublicKey = await options.crypto.x25519PublicFromSeed(options.ephemeralPrivateSeed)
  const sharedSecret = await options.crypto.x25519SharedSecret(options.ephemeralPrivateSeed, options.recipientPublicKey)
  const aesKey = await options.crypto.hkdfSha256(sharedSecret, ECIES_INFO, 32)
  return { ephemeralPublicKey, sharedSecret, aesKey }
}

export async function encryptEcies(options: EncryptEciesOptions): Promise<EciesMessage> {
  assertLength(options.nonce, NONCE_LENGTH, 'ECIES nonce')
  const material = await deriveEciesMaterial(options)
  const ciphertext = await options.crypto.aes256GcmEncrypt(material.aesKey, options.nonce, options.plaintext)
  return {
    epk: encodeBase64Url(material.ephemeralPublicKey),
    nonce: encodeBase64Url(options.nonce),
    ciphertext: encodeBase64Url(ciphertext),
  }
}

export async function decryptEcies(options: DecryptEciesOptions): Promise<Uint8Array> {
  const ephemeralPublicKey = decodeBase64Url(options.message.epk)
  const nonce = decodeBase64Url(options.message.nonce)
  const ciphertext = decodeBase64Url(options.message.ciphertext)
  assertLength(nonce, NONCE_LENGTH, 'ECIES nonce')
  const sharedSecret = await options.crypto.x25519SharedSecret(options.recipientPrivateSeed, ephemeralPublicKey)
  const aesKey = await options.crypto.hkdfSha256(sharedSecret, ECIES_INFO, 32)
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
  assertLength(options.spaceContentKey, 32, 'Space content key')
  const nonce = await deriveLogPayloadNonce(options.crypto, options.deviceId, options.seq)
  const ciphertextTag = await options.crypto.aes256GcmEncrypt(options.spaceContentKey, nonce, options.plaintext)
  const blob = concatBytes(nonce, ciphertextTag)
  return { nonce, ciphertextTag, blob, blobBase64Url: encodeBase64Url(blob) }
}

export async function decryptLogPayload(options: DecryptLogPayloadOptions): Promise<Uint8Array> {
  assertLength(options.spaceContentKey, 32, 'Space content key')
  if (options.blob.length <= NONCE_LENGTH) throw new Error('Invalid encrypted log payload blob')
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
