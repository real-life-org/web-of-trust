import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ed25519 from '@noble/ed25519'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentityVaultUnlockHandle, encryptForRecipientUsingX25519 } from '../src/application/identity/identity-vault-handle'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

vi.mock('@noble/ed25519', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/ed25519')>()
  return {
    ...actual,
    getPublicKeyAsync: vi.fn(actual.getPublicKeyAsync),
    signAsync: vi.fn(async () => {
      throw new Error('IdentityVaultUnlockHandle must sign through WebCrypto CryptoKey handles')
    }),
  }
})

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/application/identity/identity-vault-handle.ts')

describe('IdentityVaultUnlockHandle opaque WebCrypto key posture', () => {
  beforeEach(() => {
    vi.mocked(ed25519.getPublicKeyAsync).mockClear()
    vi.mocked(ed25519.signAsync).mockClear()
  })

  it('does not retain known raw seed variables or route operations through raw-key helpers', () => {
    const source = readFileSync(sourcePath, 'utf8')
    const forbiddenTokens = ['sealedSeed', 'ed25519Seed', 'x25519Seed', 'ed25519.signAsync', 'decryptEcies']
    const retainedTokens = forbiddenTokens.filter((token) => source.includes(token))

    expect(retainedTokens).toEqual([])
  })

  it('keeps signing available without @noble/ed25519.signAsync on the per-signature path', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(64))
    const handle = await createIdentityVaultUnlockHandle(seed, cryptoAdapter)
    const challenge = new TextEncoder().encode('webcrypto signing posture')

    const signature = await handle.signEd25519(challenge)
    await handle.signEd25519(new TextEncoder().encode('second signature'))

    await expect(
      cryptoAdapter.verifyEd25519(challenge, signature, handle.ed25519PublicKey),
    ).resolves.toBe(true)
    expect(ed25519.getPublicKeyAsync).toHaveBeenCalledTimes(1)
    expect(ed25519.signAsync).not.toHaveBeenCalled()
  })

  it('derives deterministic framework keys for identical inputs through the opaque handle', async () => {
    const seed = new Uint8Array(64).fill(7)
    const handle = await createIdentityVaultUnlockHandle(seed, cryptoAdapter)

    const first = await handle.deriveFrameworkKey('framework-label', 32)
    const second = await handle.deriveFrameworkKey('framework-label', 32)

    expect(first).toEqual(second)
    await expect(cryptoAdapter.hkdfSha256(seed, 'framework-label', 32)).resolves.toEqual(first)
  })

  it('decrypts payloads encrypted for the handle public X25519 key', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(64))
    const handle = await createIdentityVaultUnlockHandle(seed, cryptoAdapter)
    const plaintext = new TextEncoder().encode('opaque decrypt roundtrip')

    const encrypted = await encryptForRecipientUsingX25519(cryptoAdapter, plaintext, handle.x25519PublicKey)

    await expect(handle.decryptForMe(encrypted)).resolves.toEqual(plaintext)
  })

  it('rejects direct adapter identity vault handles for malformed BIP39 seed lengths', async () => {
    await expect(
      cryptoAdapter.createIdentityVaultCryptoHandle(new Uint8Array(63)),
    ).rejects.toThrow('Invalid identity seed format')
  })

  it('rejects decrypt payloads with malformed ECIES nonce length', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(64))
    const handle = await createIdentityVaultUnlockHandle(seed, cryptoAdapter)

    await expect(handle.decryptForMe({
      ephemeralPublicKey: new Uint8Array(32),
      nonce: new Uint8Array(11),
      ciphertext: new Uint8Array(17),
    })).rejects.toThrow('ECIES nonce must be 12 bytes')
  })

  it('rejects decrypt payloads with tag-only ECIES ciphertext', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(64))
    const handle = await createIdentityVaultUnlockHandle(seed, cryptoAdapter)

    await expect(handle.decryptForMe({
      ephemeralPublicKey: new Uint8Array(32),
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array(16),
    })).rejects.toThrow('ECIES ciphertext must include ciphertext and authentication tag')
  })
})
