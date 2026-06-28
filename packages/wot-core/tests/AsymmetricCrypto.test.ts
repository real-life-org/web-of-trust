import { describe, it, expect, beforeEach } from 'vitest'
import type { PublicIdentitySession } from '../src/application/identity'
import { createTestIdentity } from './helpers/identity-session'

describe('Asymmetric Encryption (X25519 ECDH + AES-GCM)', () => {
  let alice: PublicIdentitySession
  let bob: PublicIdentitySession

  beforeEach(async () => {
    alice = (await createTestIdentity('alice-pass')).identity
    bob = (await createTestIdentity('bob-pass')).identity
  })

  describe('getEncryptionPublicKeyBytes()', () => {
    it('should be deterministic (same identity = same public key)', async () => {
      const pub1 = await alice.getEncryptionPublicKeyBytes()
      const pub2 = await alice.getEncryptionPublicKeyBytes()
      expect(pub1).toEqual(pub2)
    })

    it('should be different from Ed25519 identity key', async () => {
      const encBytes = await alice.getEncryptionPublicKeyBytes()
      expect(encBytes.length).toBe(32)
      expect(encBytes).not.toEqual(alice.ed25519PublicKey)
    })

    it('should produce different keys for different identities', async () => {
      const alicePub = await alice.getEncryptionPublicKeyBytes()
      const bobPub = await bob.getEncryptionPublicKeyBytes()
      expect(alicePub).not.toEqual(bobPub)
    })
  })

  describe('encryptForRecipient() + decryptForMe()', () => {
    it('should round-trip encrypt and decrypt', async () => {
      const bobPubBytes = await bob.getEncryptionPublicKeyBytes()
      const plaintext = new TextEncoder().encode('Hello Bob, this is Alice!')

      const encrypted = await alice.encryptForRecipient(plaintext, bobPubBytes)

      expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array)
      expect(encrypted.nonce).toBeInstanceOf(Uint8Array)
      expect(encrypted.ephemeralPublicKey).toBeInstanceOf(Uint8Array)
      expect(encrypted.ephemeralPublicKey!.length).toBe(32)

      const decrypted = await bob.decryptForMe(encrypted)
      expect(decrypted).toEqual(plaintext)
    })

    it('should fail when wrong recipient tries to decrypt', async () => {
      const bobPubBytes = await bob.getEncryptionPublicKeyBytes()
      const plaintext = new TextEncoder().encode('Secret for Bob only')

      const encrypted = await alice.encryptForRecipient(plaintext, bobPubBytes)

      // Alice tries to decrypt something meant for Bob
      await expect(alice.decryptForMe(encrypted)).rejects.toThrow()
    })

    it('should produce different ciphertexts for same plaintext (ephemeral key)', async () => {
      const bobPubBytes = await bob.getEncryptionPublicKeyBytes()
      const plaintext = new TextEncoder().encode('Same message')

      const enc1 = await alice.encryptForRecipient(plaintext, bobPubBytes)
      const enc2 = await alice.encryptForRecipient(plaintext, bobPubBytes)

      expect(enc1.ciphertext).not.toEqual(enc2.ciphertext)
      expect(enc1.ephemeralPublicKey).not.toEqual(enc2.ephemeralPublicKey)
    })

    it('should fail with tampered ciphertext', async () => {
      const bobPubBytes = await bob.getEncryptionPublicKeyBytes()
      const plaintext = new TextEncoder().encode('Do not tamper')

      const encrypted = await alice.encryptForRecipient(plaintext, bobPubBytes)
      const tampered = new Uint8Array(encrypted.ciphertext)
      tampered[0] ^= 0xff

      await expect(bob.decryptForMe({
        ...encrypted,
        ciphertext: tampered,
      })).rejects.toThrow()
    })

    it('should fail with tampered ephemeral public key', async () => {
      const bobPubBytes = await bob.getEncryptionPublicKeyBytes()
      const plaintext = new TextEncoder().encode('Do not tamper')

      const encrypted = await alice.encryptForRecipient(plaintext, bobPubBytes)
      const tampered = new Uint8Array(encrypted.ephemeralPublicKey!)
      tampered[0] ^= 0xff

      await expect(bob.decryptForMe({
        ...encrypted,
        ephemeralPublicKey: tampered,
      })).rejects.toThrow()
    })

    it('should reject empty plaintext', async () => {
      const bobPubBytes = await bob.getEncryptionPublicKeyBytes()
      const plaintext = new Uint8Array(0)

      await expect(alice.encryptForRecipient(plaintext, bobPubBytes)).rejects.toThrow('plaintext must not be empty')
    })

    it('should handle large plaintext (1MB)', { timeout: 30_000 }, async () => {
      const bobPubBytes = await bob.getEncryptionPublicKeyBytes()
      // crypto.getRandomValues has a 65KB limit per call, so fill in chunks
      const plaintext = new Uint8Array(1024 * 1024)
      for (let i = 0; i < plaintext.length; i += 65536) {
        crypto.getRandomValues(plaintext.subarray(i, i + 65536))
      }

      const encrypted = await alice.encryptForRecipient(plaintext, bobPubBytes)
      const decrypted = await bob.decryptForMe(encrypted)
      expect(decrypted).toEqual(plaintext)
    })

    it('should return 12-byte nonce', async () => {
      const bobPubBytes = await bob.getEncryptionPublicKeyBytes()
      const plaintext = new TextEncoder().encode('Test')

      const encrypted = await alice.encryptForRecipient(plaintext, bobPubBytes)
      expect(encrypted.nonce.length).toBe(12)
    })
  })

  describe('encryption public key', () => {
    it('should return 32 bytes', async () => {
      const pubBytes = await alice.getEncryptionPublicKeyBytes()
      expect(pubBytes).toBeInstanceOf(Uint8Array)
      expect(pubBytes.length).toBe(32)
    })

    it('should be deterministic', async () => {
      const pub1 = await alice.getEncryptionPublicKeyBytes()
      const pub2 = await alice.getEncryptionPublicKeyBytes()
      expect(pub1).toEqual(pub2)
    })
  })
})
