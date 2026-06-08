import * as ed25519 from '@noble/ed25519'
import type { ProtocolCryptoAdapter, ProtocolIdentityVaultCryptoHandle } from '../protocol/crypto/ports'
import { decodeBase64Url, encodeBase64Url } from '../protocol/crypto/encoding'

const IDENTITY_INFO = 'wot/identity/ed25519/v1'
const ENCRYPTION_INFO = 'wot/encryption/x25519/v1'
const ECIES_INFO = 'wot/ecies/v1'
const BIP39_SEED_LENGTH = 64
const NONCE_LENGTH = 12
const X25519_KEY_LENGTH = 32
const AES_256_KEY_LENGTH = 32
const AES_GCM_TAG_LENGTH = 16

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function wrapX25519PrivateKey(rawKey: Uint8Array): Uint8Array {
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
  ])
  const pkcs8 = new Uint8Array(prefix.length + rawKey.length)
  pkcs8.set(prefix)
  pkcs8.set(rawKey, prefix.length)
  return pkcs8
}

function assertLength(bytes: Uint8Array, expectedLength: number, name: string): void {
  if (bytes.length !== expectedLength) throw new Error(`${name} must be ${expectedLength} bytes`)
}

function assertNotAllZero(bytes: Uint8Array, name: string): void {
  let accumulator = 0
  for (const byte of bytes) accumulator |= byte
  if (accumulator === 0) throw new Error(`${name} must not be all zero bytes`)
}

function assertCiphertextTag(bytes: Uint8Array, name: string): void {
  if (bytes.length <= AES_GCM_TAG_LENGTH) throw new Error(`${name} must include ciphertext and authentication tag`)
}

export class WebCryptoProtocolCryptoAdapter implements ProtocolCryptoAdapter {
  async verifyEd25519(input: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
    const key = await crypto.subtle.importKey('raw', toBuffer(publicKey), { name: 'Ed25519' }, false, ['verify'])
    return crypto.subtle.verify('Ed25519', key, toBuffer(signature), toBuffer(input))
  }

  async sha256(input: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', toBuffer(input)))
  }

  async hkdfSha256(input: Uint8Array, info: string, length: number): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', toBuffer(input), 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode(info),
      },
      key,
      length * 8,
    )
    return new Uint8Array(bits)
  }

  async x25519PublicFromSeed(seed: Uint8Array): Promise<Uint8Array> {
    const privateKey = await crypto.subtle.importKey('pkcs8', toBuffer(wrapX25519PrivateKey(seed)), { name: 'X25519' }, true, ['deriveBits'])
    const jwk = await crypto.subtle.exportKey('jwk', privateKey)
    if (!jwk.x) throw new Error('X25519 public key export failed')
    return decodeBase64Url(jwk.x)
  }

  async x25519SharedSecret(privateSeed: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      toBuffer(wrapX25519PrivateKey(privateSeed)),
      { name: 'X25519' },
      false,
      ['deriveBits'],
    )
    const peerPublicKey = await crypto.subtle.importKey('raw', toBuffer(publicKey), { name: 'X25519' }, false, [])
    const sharedSecret = await crypto.subtle.deriveBits({ name: 'X25519', public: peerPublicKey }, privateKey, 256)
    return new Uint8Array(sharedSecret)
  }

  async aes256GcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey('raw', toBuffer(key), { name: 'AES-GCM' }, false, ['encrypt'])
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuffer(nonce), tagLength: 128 }, cryptoKey, toBuffer(plaintext))
    return new Uint8Array(ciphertext)
  }

  async aes256GcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey('raw', toBuffer(key), { name: 'AES-GCM' }, false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuffer(nonce), tagLength: 128 }, cryptoKey, toBuffer(ciphertext))
    return new Uint8Array(plaintext)
  }

  async randomBytes(length: number): Promise<Uint8Array> {
    // Sync 001 Z.103-105: OneShot nonces MUST be cryptographically random.
    // The nonce source lives on the crypto adapter so a caller can never
    // substitute a deterministic value for a random-nonce payload.
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new Error('randomBytes length must be a positive safe integer')
    }
    // Web Crypto getRandomValues rejects requests > 65536 bytes per call
    // (QuotaExceededError). OneShot nonces are 12 bytes, but the primitive is
    // general — reject oversized requests explicitly instead of failing opaquely.
    if (length > 65_536) {
      throw new Error('randomBytes length must be at most 65536 bytes')
    }
    return globalThis.crypto.getRandomValues(new Uint8Array(length))
  }

  async createIdentityVaultCryptoHandle(bip39Seed: Uint8Array): Promise<ProtocolIdentityVaultCryptoHandle> {
    if (bip39Seed.length !== BIP39_SEED_LENGTH) throw new Error('Invalid identity seed format')
    const masterKey = await crypto.subtle.importKey('raw', toBuffer(bip39Seed), 'HKDF', false, ['deriveBits'])
    const signatureSeed = await this.deriveFromHkdfKey(masterKey, IDENTITY_INFO, 32)
    const signaturePublicKey = new Uint8Array(await ed25519.getPublicKeyAsync(signatureSeed))
    const signingKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'OKP',
        crv: 'Ed25519',
        d: encodeBase64Url(signatureSeed),
        x: encodeBase64Url(signaturePublicKey),
        key_ops: ['sign'],
        ext: false,
      },
      { name: 'Ed25519' },
      false,
      ['sign'],
    )

    const agreementSeed = await this.deriveFromHkdfKey(masterKey, ENCRYPTION_INFO, 32)
    const agreementPublicKey = await this.x25519PublicFromSeed(agreementSeed)
    const agreementKey = await crypto.subtle.importKey(
      'pkcs8',
      toBuffer(wrapX25519PrivateKey(agreementSeed)),
      { name: 'X25519' },
      false,
      ['deriveBits'],
    )

    return new WebCryptoIdentityVaultCryptoHandle(
      masterKey,
      signingKey,
      signaturePublicKey,
      agreementKey,
      agreementPublicKey,
    )
  }

  private async deriveFromHkdfKey(key: CryptoKey, info: string, length: number): Promise<Uint8Array> {
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode(info),
      },
      key,
      length * 8,
    )
    return new Uint8Array(bits)
  }
}

class WebCryptoIdentityVaultCryptoHandle implements ProtocolIdentityVaultCryptoHandle {
  readonly ed25519PublicKey: Uint8Array
  readonly x25519PublicKey: Uint8Array
  private readonly masterKey: CryptoKey
  private readonly signingKey: CryptoKey
  private readonly agreementKey: CryptoKey

  constructor(
    masterKey: CryptoKey,
    signingKey: CryptoKey,
    ed25519PublicKey: Uint8Array,
    agreementKey: CryptoKey,
    x25519PublicKey: Uint8Array,
  ) {
    this.masterKey = masterKey
    this.signingKey = signingKey
    this.ed25519PublicKey = new Uint8Array(ed25519PublicKey)
    this.agreementKey = agreementKey
    this.x25519PublicKey = new Uint8Array(x25519PublicKey)
  }

  async signEd25519(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign('Ed25519', this.signingKey, toBuffer(data)))
  }

  async decryptForMe(ephemeralPublicKey: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    assertLength(ephemeralPublicKey, X25519_KEY_LENGTH, 'ECIES ephemeral public key')
    assertLength(nonce, NONCE_LENGTH, 'ECIES nonce')
    assertCiphertextTag(ciphertext, 'ECIES ciphertext')
    const peerPublicKey = await crypto.subtle.importKey('raw', toBuffer(ephemeralPublicKey), { name: 'X25519' }, false, [])
    const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: peerPublicKey }, this.agreementKey, 256))
    assertLength(sharedSecret, X25519_KEY_LENGTH, 'ECIES shared secret')
    assertNotAllZero(sharedSecret, 'ECIES shared secret')
    const aesKeyBytes = await this.deriveTemporaryHkdf(sharedSecret, ECIES_INFO, AES_256_KEY_LENGTH)
    const aesKey = await crypto.subtle.importKey('raw', toBuffer(aesKeyBytes), { name: 'AES-GCM' }, false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuffer(nonce), tagLength: 128 }, aesKey, toBuffer(ciphertext))
    return new Uint8Array(plaintext)
  }

  deriveFrameworkKey(info: string, length: number): Promise<Uint8Array> {
    return this.deriveFromMaster(info, length)
  }

  private async deriveFromMaster(info: string, length: number): Promise<Uint8Array> {
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode(info),
      },
      this.masterKey,
      length * 8,
    )
    return new Uint8Array(bits)
  }

  private async deriveTemporaryHkdf(input: Uint8Array, info: string, length: number): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', toBuffer(input), 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode(info),
      },
      key,
      length * 8,
    )
    return new Uint8Array(bits)
  }
}
