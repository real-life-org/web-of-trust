import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ed25519 from '@noble/ed25519'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbIdentitySeedVault } from '../src/adapters/storage/IndexedDbIdentitySeedVault'
import { createIdentityVaultUnlockHandle } from '../src/application/identity/identity-vault-handle'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'

// B1.2 — Non-extractable key posture (ADR-0001 Layer-3: implementations SHOULD
// use non-extractable key handles where the platform supports it). This file
// confirms the posture that is already correct in the code but was previously
// untested.
//
// NOTE on scope: the literal `extractable: false` flag on the Ed25519/X25519
// *identity* keys lives in src/protocol-adapters/web-crypto.ts, which is owned
// by the crypto slice and out of scope for the identity slice per the crypto
// boundary rule. We therefore prove identity-key non-extractability
// behaviorally (no-export surface + WebCrypto-only signing path), and assert the
// literal extractable flag only on the at-rest AES-GCM key — which is adapter
// territory and observable through the adapter's own IndexedDB session record.

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

// signAsync is mocked to throw so that any code path attempting to sign through
// the @noble raw-key helper fails loudly. A passing signature therefore proves
// signing runs through a non-extractable WebCrypto CryptoKey instead.
vi.mock('@noble/ed25519', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/ed25519')>()
  return {
    ...actual,
    getPublicKeyAsync: vi.fn(actual.getPublicKeyAsync),
    signAsync: vi.fn(async () => {
      throw new Error('Identity signing must use non-extractable WebCrypto CryptoKey handles')
    }),
  }
})

const SESSION_DB_NAME = 'wot-identity'
const SESSION_DB_VERSION = 2
const SESSION_STORE = 'session'
const SESSION_RECORD_KEY = 'session-key'

const handleSourcePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/application/identity/identity-vault-handle.ts',
)

async function resetVault(): Promise<void> {
  const vault = new IndexedDbIdentitySeedVault()
  await vault.deleteSeed()
}

function readPersistedSessionKey(): Promise<CryptoKey | null> {
  return new Promise((resolvePromise, reject) => {
    const openRequest = indexedDB.open(SESSION_DB_NAME, SESSION_DB_VERSION)
    openRequest.onerror = () => reject(openRequest.error)
    openRequest.onsuccess = () => {
      const db = openRequest.result
      const tx = db.transaction([SESSION_STORE], 'readonly')
      const getRequest = tx.objectStore(SESSION_STORE).get(SESSION_RECORD_KEY)
      getRequest.onerror = () => {
        db.close()
        reject(getRequest.error)
      }
      getRequest.onsuccess = () => {
        const record = getRequest.result as { key: CryptoKey } | undefined
        db.close()
        resolvePromise(record?.key ?? null)
      }
    }
  })
}

describe('IdentitySeedVault non-extractable key posture', () => {
  beforeEach(() => {
    vi.mocked(ed25519.signAsync).mockClear()
  })

  afterEach(async () => {
    await resetVault()
  })

  it('persists the at-rest AES-GCM session key as a non-extractable CryptoKey', async () => {
    const vault = new IndexedDbIdentitySeedVault({ crypto: cryptoAdapter })
    const seed = crypto.getRandomValues(new Uint8Array(64))
    await vault.saveSeed(seed, 'passphrase')

    // Unlocking caches the derived AES-GCM session key in the session store.
    await vault.unlockWithPassphrase('passphrase')

    const sessionKey = await readPersistedSessionKey()
    expect(sessionKey).not.toBeNull()
    // Literal posture: the at-rest encryption key is non-extractable and
    // usage-restricted to encrypt/decrypt — no exportKey path can read it out.
    expect(sessionKey!.extractable).toBe(false)
    expect(sessionKey!.algorithm.name).toBe('AES-GCM')
    expect([...sessionKey!.usages].sort()).toEqual(['decrypt', 'encrypt'])
    await expect(crypto.subtle.exportKey('raw', sessionKey!)).rejects.toThrow()
  })

  it('signs through a non-extractable WebCrypto CryptoKey, never the @noble raw-key helper', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(64))
    const handle = await createIdentityVaultUnlockHandle(seed, cryptoAdapter)
    const challenge = new TextEncoder().encode('non-extractable signing posture')

    const signature = await handle.signEd25519(challenge)

    await expect(
      cryptoAdapter.verifyEd25519(challenge, signature, handle.ed25519PublicKey),
    ).resolves.toBe(true)
    // signAsync (raw-key path) is mocked to throw; a valid signature proves the
    // signing key is a non-extractable WebCrypto CryptoKey handle.
    expect(ed25519.signAsync).not.toHaveBeenCalled()
  })

  it('exposes no surface to export raw key or seed material from the unlock handle', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(64))
    const handle = await createIdentityVaultUnlockHandle(seed, cryptoAdapter)

    const forbidden = ['getSeed', 'exportSeed', 'exportKey', 'rawKey', 'extractable']
    for (const token of forbidden) {
      expect((handle as unknown as Record<string, unknown>)[token]).toBeUndefined()
    }
    for (const key of Object.keys(handle)) {
      expect(key).not.toMatch(/seed|rawKey|exportKey|extractable/i)
    }
  })

  it('builds the handle without retaining raw-seed variables or routing through raw-key helpers', () => {
    // Source-level guard mirroring the unlock-handle posture test: the handle
    // builder must not keep named raw-seed material around or sign via the raw
    // @noble helper.
    const source = readFileSync(handleSourcePath, 'utf8')
    const forbiddenTokens = ['sealedSeed', 'ed25519Seed', 'x25519Seed', 'ed25519.signAsync', 'decryptEcies']
    const retained = forbiddenTokens.filter((token) => source.includes(token))
    expect(retained).toEqual([])
  })
})
