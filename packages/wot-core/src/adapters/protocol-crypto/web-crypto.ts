import * as ed25519 from '@noble/ed25519'
import type { ProtocolCryptoAdapter, ProtocolIdentityVaultCryptoHandle } from '../../protocol/crypto/ports'
import { encodeBase64Url } from '../../protocol/crypto/encoding'

const IDENTITY_INFO = 'wot/identity/ed25519/v1'
const ENCRYPTION_INFO = 'wot/encryption/x25519/v1'
const ECIES_INFO = 'wot/ecies/v1'
const BIP39_SEED_LENGTH = 64
const NONCE_LENGTH = 12
const X25519_KEY_LENGTH = 32
// X25519 basepoint (u = 9), little-endian.
const X25519_BASEPOINT = Uint8Array.of(9, ...new Array(31).fill(0))
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

// ── bounded CryptoKey cache (#353, Cold-Start PR2) ───────────────────────────
//
// Cold-start restore is dominated by crypto.subtle.importKey: ~2.500 log entries
// produced 7.054 importKey calls (139 s) although only a few dozen DISTINCT keys
// exist — every verify/decrypt re-imported the same bytes.
//
// The cache is keyed by (slot, raw key material). A slot is the literal
// algorithm + import format + usages tuple of one call site, so a hit can
// structurally never hand back a CryptoKey for a different algorithm, a
// different import format or wider usages than the caller asked for: different
// tuples live in different maps and never share an entry.
//
// It caches the in-flight Promise, not the resolved key, so N concurrent
// imports of the same material still perform exactly one importKey; a rejected
// import is evicted so a later call retries.
export const PROTOCOL_CRYPTO_KEY_CACHE_MAX_ENTRIES_PER_SLOT = 64

/** Import slots: <algorithm>:<format>:<usages>. One constant per call site. */
const SLOT_ED25519_VERIFY = 'Ed25519:raw:verify'
const SLOT_HKDF_DERIVE_BITS = 'HKDF:raw:deriveBits'
const SLOT_X25519_PRIVATE_DERIVE_BITS = 'X25519:pkcs8:deriveBits'
const SLOT_X25519_PUBLIC = 'X25519:raw:'
const SLOT_AES_GCM_ENCRYPT = 'AES-GCM:raw:encrypt'
const SLOT_AES_GCM_DECRYPT = 'AES-GCM:raw:decrypt'

const importCaches = new Map<string, Map<string, Promise<CryptoKey>>>()

const HEX_OCTETS = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'))

function materialCacheKey(material: Uint8Array): string {
  let hex = ''
  for (const byte of material) hex += HEX_OCTETS[byte]
  return hex
}

/**
 * Memoize `importKey` per (slot, material) with a per-slot LRU bound.
 *
 * The bound matters because a ProtocolCryptoAdapter is long-lived (and used
 * from a module-level singleton), so an unbounded map would grow across login
 * boundaries. Note that clearing is pure memory hygiene, NOT a correctness
 * condition: because the cache key contains the key material itself, a stale
 * entry can only ever be re-handed to a caller presenting the very same bytes.
 */
function importCachedKey(slot: string, material: Uint8Array, load: () => Promise<CryptoKey>): Promise<CryptoKey> {
  let cache = importCaches.get(slot)
  if (!cache) {
    cache = new Map()
    importCaches.set(slot, cache)
  }
  const id = materialCacheKey(material)
  const hit = cache.get(id)
  if (hit) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves the
    // entry to the young end and the oldest key is always the eviction victim.
    cache.delete(id)
    cache.set(id, hit)
    return hit
  }
  const localCache = cache
  const pending = load().catch((error: unknown) => {
    localCache.delete(id)
    throw error
  })
  cache.set(id, pending)
  for (const oldest of cache.keys()) {
    if (cache.size <= PROTOCOL_CRYPTO_KEY_CACHE_MAX_ENTRIES_PER_SLOT) break
    cache.delete(oldest)
  }
  return pending
}

/**
 * Drop every memoized CryptoKey. Memory hygiene for identity teardown (logout)
 * — the cached handles are non-extractable and material-bound, so keeping them
 * would never produce a wrong result, it would only retain key handles of a
 * session that ended.
 *
 * Intended call site: IdentityWorkflow.lockIdentity() / deleteStoredIdentity()
 * in src/application/identity/identity-workflow.ts. That file is outside this
 * slice's scope (#353 PR2), so the wiring is left to a follow-up; until then
 * the exported function is the documented teardown hook.
 */
export function clearProtocolCryptoKeyCache(): void {
  importCaches.clear()
}

export class WebCryptoProtocolCryptoAdapter implements ProtocolCryptoAdapter {
  async verifyEd25519(input: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
    const key = await importCachedKey(SLOT_ED25519_VERIFY, publicKey, () =>
      crypto.subtle.importKey('raw', toBuffer(publicKey), { name: 'Ed25519' }, false, ['verify']),
    )
    return crypto.subtle.verify('Ed25519', key, toBuffer(signature), toBuffer(input))
  }

  /** Drop every memoized CryptoKey (see clearProtocolCryptoKeyCache). */
  clearKeyCache(): void {
    clearProtocolCryptoKeyCache()
  }

  async ed25519PublicKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await ed25519.getPublicKeyAsync(seed))
  }

  async sha256(input: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', toBuffer(input)))
  }

  async hkdfSha256(input: Uint8Array, info: string, length: number): Promise<Uint8Array> {
    const key = await importCachedKey(SLOT_HKDF_DERIVE_BITS, input, () =>
      crypto.subtle.importKey('raw', toBuffer(input), 'HKDF', false, ['deriveBits']),
    )
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
    // X25519(scalar, basepoint) is by definition the public key. Reading it out of
    // exportKey('jwk') instead needs the private key to be extractable and relies on
    // the engine computing the public component during PKCS#8 import. Node (OpenSSL),
    // Chrome (BoringSSL) and current Firefox do; the Gecko build shipped in Tor
    // Browser does not and rejects that export with OperationError. Deriving against
    // the basepoint uses only primitives all of them support.
    const privateKey = await importCachedKey(SLOT_X25519_PRIVATE_DERIVE_BITS, seed, () =>
      crypto.subtle.importKey('pkcs8', toBuffer(wrapX25519PrivateKey(seed)), { name: 'X25519' }, false, ['deriveBits']),
    )
    const basepoint = await importCachedKey(SLOT_X25519_PUBLIC, X25519_BASEPOINT, () =>
      crypto.subtle.importKey('raw', toBuffer(X25519_BASEPOINT), { name: 'X25519' }, false, []),
    )
    const publicKey = await crypto.subtle.deriveBits({ name: 'X25519', public: basepoint }, privateKey, X25519_KEY_LENGTH * 8)
    return new Uint8Array(publicKey)
  }

  async x25519SharedSecret(privateSeed: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
    const privateKey = await importCachedKey(SLOT_X25519_PRIVATE_DERIVE_BITS, privateSeed, () =>
      crypto.subtle.importKey('pkcs8', toBuffer(wrapX25519PrivateKey(privateSeed)), { name: 'X25519' }, false, [
        'deriveBits',
      ]),
    )
    const peerPublicKey = await importCachedKey(SLOT_X25519_PUBLIC, publicKey, () =>
      crypto.subtle.importKey('raw', toBuffer(publicKey), { name: 'X25519' }, false, []),
    )
    const sharedSecret = await crypto.subtle.deriveBits({ name: 'X25519', public: peerPublicKey }, privateKey, 256)
    return new Uint8Array(sharedSecret)
  }

  async aes256GcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await importCachedKey(SLOT_AES_GCM_ENCRYPT, key, () =>
      crypto.subtle.importKey('raw', toBuffer(key), { name: 'AES-GCM' }, false, ['encrypt']),
    )
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuffer(nonce), tagLength: 128 }, cryptoKey, toBuffer(plaintext))
    return new Uint8Array(ciphertext)
  }

  async aes256GcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await importCachedKey(SLOT_AES_GCM_DECRYPT, key, () =>
      crypto.subtle.importKey('raw', toBuffer(key), { name: 'AES-GCM' }, false, ['decrypt']),
    )
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
    // Deliberately NOT memoized (#353): the ephemeral public key and the derived
    // AES key are fresh per message, so caching them could never hit — it would
    // only evict the reusable content/verification keys from their slots.
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
