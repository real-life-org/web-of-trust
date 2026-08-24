import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as ed25519 from '@noble/ed25519'
import {
  WebCryptoProtocolCryptoAdapter,
  clearProtocolCryptoKeyCache,
  PROTOCOL_CRYPTO_KEY_CACHE_MAX_ENTRIES_PER_SLOT,
} from '../src/adapters/protocol-crypto'

/**
 * Cold-Start PR2 (#353): the WebCrypto adapter memoizes imported CryptoKeys.
 * These tests measure the effect through a counting wrapper around
 * crypto.subtle.importKey and pin the structural guarantees: material-,
 * algorithm- and usage-separation, a bounded (LRU) cache, and clear().
 */

const adapter = new WebCryptoProtocolCryptoAdapter()

type ImportKeyFn = SubtleCrypto['importKey']

const subtle = globalThis.crypto.subtle
const originalImportKey = subtle.importKey.bind(subtle) as ImportKeyFn

let importKeyCalls = 0

/** importKey calls observed since the last resetImportCount(). */
function importCount(): number {
  return importKeyCalls
}

function resetImportCount(): void {
  importKeyCalls = 0
}

function installImportKeyCounter(): void {
  const counting = (...args: unknown[]): Promise<CryptoKey | CryptoKeyPair> => {
    importKeyCalls += 1
    return (originalImportKey as unknown as (...a: unknown[]) => Promise<CryptoKey | CryptoKeyPair>)(...args)
  }
  Object.defineProperty(subtle, 'importKey', { configurable: true, writable: true, value: counting })
}

function restoreImportKey(): void {
  Object.defineProperty(subtle, 'importKey', { configurable: true, writable: true, value: originalImportKey })
}

function aesKey(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill)
}

beforeEach(() => {
  clearProtocolCryptoKeyCache()
  resetImportCount()
  installImportKeyCounter()
})

afterEach(() => {
  restoreImportKey()
  clearProtocolCryptoKeyCache()
})

describe('WebCryptoProtocolCryptoAdapter — bounded CryptoKey cache (#353)', () => {
  it('N verifyEd25519 calls with the same public key trigger exactly one importKey', async () => {
    const seed = ed25519.utils.randomSecretKey()
    const publicKey = await adapter.ed25519PublicKeyFromSeed(seed)
    const message = new TextEncoder().encode('cold start')
    const signature = await ed25519.signAsync(message, seed)

    resetImportCount()
    for (let i = 0; i < 25; i++) {
      expect(await adapter.verifyEd25519(message, signature, publicKey)).toBe(true)
    }
    expect(importCount()).toBe(1)

    // Still correct after the cache hit: a tampered signature does NOT verify.
    const tampered = new Uint8Array(signature)
    tampered[0] ^= 0xff
    expect(await adapter.verifyEd25519(message, tampered, publicKey)).toBe(false)
    expect(importCount()).toBe(1)
  })

  it('different public keys import separately and never cross-verify', async () => {
    const seedA = ed25519.utils.randomSecretKey()
    const seedB = ed25519.utils.randomSecretKey()
    const publicA = await adapter.ed25519PublicKeyFromSeed(seedA)
    const publicB = await adapter.ed25519PublicKeyFromSeed(seedB)
    const message = new TextEncoder().encode('two authors')
    const signatureA = await ed25519.signAsync(message, seedA)

    resetImportCount()
    expect(await adapter.verifyEd25519(message, signatureA, publicA)).toBe(true)
    // Different material → a separate import, and A's signature must not verify under B.
    expect(await adapter.verifyEd25519(message, signatureA, publicB)).toBe(false)
    expect(importCount()).toBe(2)

    // Both are now cached: repeats add no imports.
    expect(await adapter.verifyEd25519(message, signatureA, publicA)).toBe(true)
    expect(await adapter.verifyEd25519(message, signatureA, publicB)).toBe(false)
    expect(importCount()).toBe(2)
  })

  it('N aes256GcmDecrypt calls with the same content key trigger exactly one importKey', async () => {
    const key = aesKey(7)
    const nonces = Array.from({ length: 10 }, (_, i) => new Uint8Array(12).fill(i + 1))
    const plaintexts = nonces.map((_, i) => new Uint8Array([i, i + 1, i + 2]))
    const ciphertexts: Uint8Array[] = []
    for (let i = 0; i < nonces.length; i++) {
      ciphertexts.push(await adapter.aes256GcmEncrypt(key, nonces[i], plaintexts[i]))
    }

    resetImportCount()
    for (let i = 0; i < nonces.length; i++) {
      const decrypted = await adapter.aes256GcmDecrypt(key, nonces[i], ciphertexts[i])
      expect(Array.from(decrypted)).toEqual(Array.from(plaintexts[i]))
    }
    expect(importCount()).toBe(1)
  })

  it('encrypt and decrypt usages of the same key material live in separate slots', async () => {
    const key = aesKey(9)
    const nonce = new Uint8Array(12).fill(3)

    resetImportCount()
    const ciphertext = await adapter.aes256GcmEncrypt(key, nonce, new Uint8Array([1, 2, 3]))
    expect(importCount()).toBe(1)
    // Same material, different usage → its own import (never a cross-usage hit).
    const plaintext = await adapter.aes256GcmDecrypt(key, nonce, ciphertext)
    expect(importCount()).toBe(2)
    expect(Array.from(plaintext)).toEqual([1, 2, 3])

    // Both slots are warm now.
    await adapter.aes256GcmEncrypt(key, nonce, new Uint8Array([1, 2, 3]))
    await adapter.aes256GcmDecrypt(key, nonce, ciphertext)
    expect(importCount()).toBe(2)
  })

  it('identical bytes used under different algorithms import separately', async () => {
    // The same 32 bytes as an Ed25519 verification key and as an AES-GCM content key.
    const seed = ed25519.utils.randomSecretKey()
    const material = await adapter.ed25519PublicKeyFromSeed(seed)
    const message = new TextEncoder().encode('shared bytes')
    const signature = await ed25519.signAsync(message, seed)

    resetImportCount()
    expect(await adapter.verifyEd25519(message, signature, material)).toBe(true)
    await adapter.aes256GcmEncrypt(material, new Uint8Array(12).fill(1), new Uint8Array([0]))
    await adapter.hkdfSha256(material, 'wot/test/v1', 32)
    // Three algorithms, three imports — no slot ever hands back a foreign key.
    expect(importCount()).toBe(3)
  })

  it('the cache is bounded: the least recently used entry of a slot is evicted', async () => {
    const limit = PROTOCOL_CRYPTO_KEY_CACHE_MAX_ENTRIES_PER_SLOT
    const nonce = new Uint8Array(12).fill(1)
    const plaintext = new Uint8Array([1])
    const keys = Array.from({ length: limit }, (_, i) => {
      const key = new Uint8Array(32)
      key[0] = i & 0xff
      key[1] = (i >> 8) & 0xff
      return key
    })

    // Fill the encrypt slot exactly to the limit.
    resetImportCount()
    for (const key of keys) await adapter.aes256GcmEncrypt(key, nonce, plaintext)
    expect(importCount()).toBe(limit)

    // All of them are cached.
    for (const key of keys) await adapter.aes256GcmEncrypt(key, nonce, plaintext)
    expect(importCount()).toBe(limit)

    // Touch the oldest so it becomes the most recent (LRU recency, not FIFO).
    await adapter.aes256GcmEncrypt(keys[0], nonce, plaintext)
    expect(importCount()).toBe(limit)

    // One more distinct key overflows the slot → evicts keys[1] (now the oldest).
    const overflow = new Uint8Array(32).fill(0xab)
    await adapter.aes256GcmEncrypt(overflow, nonce, plaintext)
    expect(importCount()).toBe(limit + 1)

    resetImportCount()
    await adapter.aes256GcmEncrypt(keys[1], nonce, plaintext) // evicted → re-imported
    expect(importCount()).toBe(1)
    await adapter.aes256GcmEncrypt(keys[0], nonce, plaintext) // refreshed → still cached
    await adapter.aes256GcmEncrypt(overflow, nonce, plaintext) // newest → still cached
    expect(importCount()).toBe(1)
  })

  it('clear() drops every memoized key (adapter method and exported function)', async () => {
    const key = aesKey(5)
    const nonce = new Uint8Array(12).fill(2)

    resetImportCount()
    await adapter.aes256GcmEncrypt(key, nonce, new Uint8Array([1]))
    await adapter.aes256GcmEncrypt(key, nonce, new Uint8Array([1]))
    expect(importCount()).toBe(1)

    adapter.clearKeyCache()
    await adapter.aes256GcmEncrypt(key, nonce, new Uint8Array([1]))
    expect(importCount()).toBe(2)

    clearProtocolCryptoKeyCache()
    await adapter.aes256GcmEncrypt(key, nonce, new Uint8Array([1]))
    expect(importCount()).toBe(3)
  })

  it('concurrent calls with the same key share a single in-flight import', async () => {
    const key = aesKey(21)
    const nonce = new Uint8Array(12).fill(4)

    resetImportCount()
    await Promise.all(
      Array.from({ length: 20 }, () => adapter.aes256GcmEncrypt(key, nonce, new Uint8Array([1, 2]))),
    )
    expect(importCount()).toBe(1)
  })

  it('a failed import is not cached: a later call retries the import', async () => {
    const invalidKey = new Uint8Array(17).fill(1) // not a valid AES-256 key length
    const nonce = new Uint8Array(12).fill(1)

    resetImportCount()
    await expect(adapter.aes256GcmEncrypt(invalidKey, nonce, new Uint8Array([1]))).rejects.toBeTruthy()
    await expect(adapter.aes256GcmEncrypt(invalidKey, nonce, new Uint8Array([1]))).rejects.toBeTruthy()
    expect(importCount()).toBe(2)
  })

  it('memoization does not change x25519 / hkdf results', async () => {
    const seedA = new Uint8Array(32).fill(3)
    const seedB = new Uint8Array(32).fill(4)
    const publicA = await adapter.x25519PublicFromSeed(seedA)
    const publicB = await adapter.x25519PublicFromSeed(seedB)

    resetImportCount()
    const sharedAB = await adapter.x25519SharedSecret(seedA, publicB)
    const sharedBA = await adapter.x25519SharedSecret(seedB, publicA)
    expect(Array.from(sharedAB)).toEqual(Array.from(sharedBA))

    // Repeated derivations with the same seeds are stable and import nothing new.
    const importsAfterFirst = importCount()
    expect(Array.from(await adapter.x25519SharedSecret(seedA, publicB))).toEqual(Array.from(sharedAB))
    expect(importCount()).toBe(importsAfterFirst)

    const derived = await adapter.hkdfSha256(seedA, 'wot/test/v1', 32)
    expect(Array.from(await adapter.hkdfSha256(seedA, 'wot/test/v1', 32))).toEqual(Array.from(derived))
    // A different info under the SAME cached HKDF key must derive different bits.
    const other = await adapter.hkdfSha256(seedA, 'wot/test/v2', 32)
    expect(Array.from(other)).not.toEqual(Array.from(derived))
  })
})
