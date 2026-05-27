import type { CryptoAdapter, MasterKeyHandle, EncryptionKeyPair, EncryptedPayload } from '../../ports/CryptoAdapter'
import type { KeyPair } from '../../types'
import { encodeBase64Url, decodeBase64Url, toBuffer } from '../../crypto/encoding'
import { createDid, didToPublicKeyBytes } from '../../crypto/did'
import * as ed25519 from '@noble/ed25519'

/** Internal wrapper to satisfy the branded MasterKeyHandle type */
class WebCryptoMasterKey {
  readonly _brand = 'MasterKeyHandle' as const
  constructor(public readonly key: CryptoKey) {}
}

/** Internal wrapper to satisfy the branded EncryptionKeyPair type */
class WebCryptoEncryptionKeyPair {
  readonly _brand = 'EncryptionKeyPair' as const
  constructor(public readonly keyPair: CryptoKeyPair) {}
}

/** OID for X25519: 1.3.101.110 — wraps raw 32-byte key in PKCS8 DER */
function wrapX25519PrivateKey(rawKey: Uint8Array): Uint8Array {
  const prefix = new Uint8Array([
    0x30, 0x2e, // SEQUENCE (46 bytes)
    0x02, 0x01, 0x00, // INTEGER version = 0
    0x30, 0x05, // SEQUENCE (5 bytes)
    0x06, 0x03, 0x2b, 0x65, 0x6e, // OID 1.3.101.110 (X25519)
    0x04, 0x22, // OCTET STRING (34 bytes)
    0x04, 0x20, // OCTET STRING (32 bytes)
  ])
  const pkcs8 = new Uint8Array(prefix.length + rawKey.length)
  pkcs8.set(prefix)
  pkcs8.set(rawKey, prefix.length)
  return pkcs8
}

export class WebCryptoAdapter implements CryptoAdapter {
  async generateKeyPair(): Promise<KeyPair> {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify']
    ) as CryptoKeyPair
    return {
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    }
  }

  async exportKeyPair(keyPair: KeyPair): Promise<{ publicKey: string; privateKey: string }> {
    const [publicKeyRaw, privateKeyRaw] = await Promise.all([
      crypto.subtle.exportKey('raw', keyPair.publicKey),
      crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
    ])
    return {
      publicKey: encodeBase64Url(new Uint8Array(publicKeyRaw)),
      privateKey: encodeBase64Url(new Uint8Array(privateKeyRaw)),
    }
  }

  async importKeyPair(exported: { publicKey: string; privateKey: string }): Promise<KeyPair> {
    const pubBytes = decodeBase64Url(exported.publicKey)
    const privBytes = decodeBase64Url(exported.privateKey)
    const [publicKey, privateKey] = await Promise.all([
      crypto.subtle.importKey(
        'raw',
        toBuffer(pubBytes),
        { name: 'Ed25519' },
        true,
        ['verify']
      ),
      crypto.subtle.importKey(
        'pkcs8',
        toBuffer(privBytes),
        { name: 'Ed25519' },
        true,
        ['sign']
      ),
    ])
    return { publicKey, privateKey }
  }

  async exportPublicKey(publicKey: CryptoKey): Promise<string> {
    const raw = await crypto.subtle.exportKey('raw', publicKey)
    return encodeBase64Url(new Uint8Array(raw))
  }

  async importPublicKey(exported: string): Promise<CryptoKey> {
    const bytes = decodeBase64Url(exported)
    return crypto.subtle.importKey(
      'raw',
      toBuffer(bytes),
      { name: 'Ed25519' },
      true,
      ['verify']
    )
  }

  async createDid(publicKey: CryptoKey): Promise<string> {
    const raw = await crypto.subtle.exportKey('raw', publicKey)
    return createDid(new Uint8Array(raw))
  }

  async didToPublicKey(did: string): Promise<CryptoKey> {
    const publicKeyBytes = didToPublicKeyBytes(did)
    return crypto.subtle.importKey(
      'raw',
      toBuffer(publicKeyBytes),
      { name: 'Ed25519' },
      true,
      ['verify']
    )
  }

  async sign(data: Uint8Array, privateKey: CryptoKey): Promise<Uint8Array> {
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      toBuffer(data)
    )
    return new Uint8Array(signature)
  }

  async verify(data: Uint8Array, signature: Uint8Array, publicKey: CryptoKey): Promise<boolean> {
    return crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      toBuffer(signature),
      toBuffer(data)
    )
  }

  async signString(data: string, privateKey: CryptoKey): Promise<string> {
    const encoder = new TextEncoder()
    const signature = await this.sign(encoder.encode(data), privateKey)
    return encodeBase64Url(signature)
  }

  async verifyString(data: string, signature: string, publicKey: CryptoKey): Promise<boolean> {
    const encoder = new TextEncoder()
    return this.verify(encoder.encode(data), decodeBase64Url(signature), publicKey)
  }

  // Symmetric Encryption (AES-256-GCM for Group Spaces)

  async generateSymmetricKey(): Promise<Uint8Array> {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
    const raw = await crypto.subtle.exportKey('raw', key)
    return new Uint8Array(raw)
  }

  async encryptSymmetric(
    plaintext: Uint8Array,
    key: Uint8Array,
  ): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      toBuffer(key),
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    )
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      cryptoKey,
      toBuffer(plaintext)
    )
    return { ciphertext: new Uint8Array(encrypted), nonce }
  }

  async decryptSymmetric(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      toBuffer(key),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    )
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      cryptoKey,
      toBuffer(ciphertext)
    )
    return new Uint8Array(decrypted)
  }

  generateNonce(): string {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return encodeBase64Url(bytes)
  }

  async hashData(data: Uint8Array): Promise<Uint8Array> {
    const hash = await crypto.subtle.digest('SHA-256', toBuffer(data))
    return new Uint8Array(hash)
  }

  // --- Deterministic Key Derivation ---

  async importMasterKey(seed: Uint8Array): Promise<MasterKeyHandle> {
    const key = await crypto.subtle.importKey(
      'raw',
      toBuffer(seed),
      { name: 'HKDF' },
      false,
      ['deriveKey', 'deriveBits'],
    )
    return new WebCryptoMasterKey(key)
  }

  async deriveBits(masterKey: MasterKeyHandle, info: string, bits: number): Promise<Uint8Array> {
    const handle = masterKey as WebCryptoMasterKey
    const derived = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(),
        info: new TextEncoder().encode(info),
      },
      handle.key,
      bits,
    )
    return new Uint8Array(derived)
  }

  async deriveKeyPairFromSeed(seed: Uint8Array): Promise<KeyPair> {
    // Derive public key deterministically using @noble/ed25519
    const publicKeyBytes = await ed25519.getPublicKeyAsync(seed)

    // Import into WebCrypto via JWK
    const privateKeyJwk: JsonWebKey = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: encodeBase64Url(new Uint8Array(publicKeyBytes.buffer)),
      d: encodeBase64Url(new Uint8Array(seed.buffer)),
      ext: false,
      key_ops: ['sign'],
    }
    const publicKeyJwk: JsonWebKey = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: encodeBase64Url(new Uint8Array(publicKeyBytes.buffer)),
      ext: true,
      key_ops: ['verify'],
    }

    const [privateKey, publicKey] = await Promise.all([
      crypto.subtle.importKey('jwk', privateKeyJwk, 'Ed25519', false, ['sign']),
      crypto.subtle.importKey('jwk', publicKeyJwk, 'Ed25519', true, ['verify']),
    ])

    return { publicKey, privateKey }
  }

  // --- Asymmetric Encryption (ECIES) ---

  async deriveEncryptionKeyPair(seed: Uint8Array): Promise<EncryptionKeyPair> {
    const pkcs8 = wrapX25519PrivateKey(seed)
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'X25519' },
      false,
      ['deriveBits'],
    )

    // Derive public key: import extractable, export JWK, re-import public only
    const extractablePriv = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'X25519' },
      true,
      ['deriveBits'],
    )
    const jwk = await crypto.subtle.exportKey('jwk', extractablePriv)
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      { name: 'X25519' },
      true,
      [],
    )

    return new WebCryptoEncryptionKeyPair({ privateKey, publicKey })
  }

  private async deriveEciesKey(sharedBits: ArrayBuffer, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      sharedBits,
      { name: 'HKDF' },
      false,
      ['deriveKey'],
    )
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode('wot-ecies-v1'),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      [usage],
    )
  }

  async exportEncryptionPublicKey(keyPair: EncryptionKeyPair): Promise<Uint8Array> {
    const handle = keyPair as WebCryptoEncryptionKeyPair
    const raw = await crypto.subtle.exportKey('raw', handle.keyPair.publicKey)
    return new Uint8Array(raw)
  }

  async encryptAsymmetric(
    plaintext: Uint8Array,
    recipientPublicKeyBytes: Uint8Array,
  ): Promise<EncryptedPayload> {
    // 1. Generate ephemeral X25519 key pair
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'X25519' },
      true,
      ['deriveBits'],
    ) as CryptoKeyPair

    // 2. Import recipient's public key
    const recipientPub = await crypto.subtle.importKey(
      'raw',
      toBuffer(recipientPublicKeyBytes),
      { name: 'X25519' },
      true,
      [],
    )

    // 3. ECDH: ephemeral private x recipient public → shared secret
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: recipientPub },
      ephemeral.privateKey,
      256,
    )

    // 4. HKDF: shared secret → AES-GCM key
    const aesKey = await this.deriveEciesKey(sharedBits, 'encrypt')

    // 5. AES-GCM encrypt
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      toBuffer(plaintext),
    )

    // 6. Export ephemeral public key
    const ephemeralPubBytes = new Uint8Array(
      await crypto.subtle.exportKey('raw', ephemeral.publicKey),
    )

    return {
      ciphertext: new Uint8Array(ciphertext),
      nonce,
      ephemeralPublicKey: ephemeralPubBytes,
    }
  }

  async decryptAsymmetric(
    payload: EncryptedPayload,
    keyPair: EncryptionKeyPair,
  ): Promise<Uint8Array> {
    const handle = keyPair as WebCryptoEncryptionKeyPair
    if (!payload.ephemeralPublicKey) {
      throw new Error('Missing ephemeral public key')
    }

    // 1. Import sender's ephemeral public key
    const ephemeralPub = await crypto.subtle.importKey(
      'raw',
      toBuffer(payload.ephemeralPublicKey),
      { name: 'X25519' },
      true,
      [],
    )

    // 2. ECDH: own private x ephemeral public → same shared secret
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: ephemeralPub },
      handle.keyPair.privateKey,
      256,
    )

    // 3. HKDF: shared secret → AES-GCM key
    const aesKey = await this.deriveEciesKey(sharedBits, 'decrypt')

    // 4. AES-GCM decrypt
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: payload.nonce },
      aesKey,
      toBuffer(payload.ciphertext),
    )

    return new Uint8Array(decrypted)
  }

  // --- Utilities ---

  randomBytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length))
  }
}
