import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createIdentityVaultUnlockHandle } from '../src/application/identity/identity-vault-handle'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

vi.mock('@noble/ed25519', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/ed25519')>()
  return {
    ...actual,
    signAsync: vi.fn(async () => {
      throw new Error('IdentityVaultUnlockHandle must sign through WebCrypto CryptoKey handles')
    }),
  }
})

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

describe('IdentityVaultUnlockHandle opaque WebCrypto key posture', () => {
  it('does not retain known raw seed variables or route operations through raw-key helpers', () => {
    const source = readFileSync('src/application/identity/identity-vault-handle.ts', 'utf8')
    const forbiddenTokens = ['sealedSeed', 'ed25519Seed', 'x25519Seed', 'ed25519.signAsync', 'decryptEcies']
    const retainedTokens = forbiddenTokens.filter((token) => source.includes(token))

    expect(retainedTokens).toEqual([])
  })

  it('keeps signing available without @noble/ed25519.signAsync on the per-signature path', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(64))
    const handle = await createIdentityVaultUnlockHandle(seed, cryptoAdapter)
    const challenge = new TextEncoder().encode('webcrypto signing posture')

    const signature = await handle.signEd25519(challenge)

    await expect(
      cryptoAdapter.verifyEd25519(challenge, signature, handle.ed25519PublicKey),
    ).resolves.toBe(true)
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
