import { describe, it, expect, beforeEach } from 'vitest'
import { WotIdentity } from '../src/identity/WotIdentity'

describe('Asymmetric Encryption (X25519 ECDH + AES-GCM)', () => {
  let alice: WotIdentity
  let bob: WotIdentity

  beforeEach(async () => {
    alice = new WotIdentity()
    bob = new WotIdentity()
    await alice.create('alice-pass', false)
    await bob.create('bob-pass', false)
  })

  describe('deriveEncryptionKeyPair()', () => {
    it('should return an X25519 key pair', async () => {
      const keyPair = await alice.getEncryptionKeyPair()
      expect(keyPair.publicKey.algorithm.name).toBe('X25519')
      expect(keyPair.privateKey.algorithm.name).toBe('X25519')
    })

    it('should be deterministic (same identity = same public key)', async () => {
      const kp1 = await alice.getEncryptionKeyPair()
      const kp2 = await alice.getEncryptionKeyPair()
      const pub1 = await crypto.subtle.exportKey('raw', kp1.publicKey)
      const pub2 = await crypto.subtle.exportKey('raw', kp2.publicKey)
      expect(new Uint8Array(pub1)).toEqual(new Uint8Array(pub2))
    })

    it('should be different from Ed25519 identity key', async () => {
      const encPub = await alice.getEncryptionKeyPair()
      const signPub = await alice.getPublicKey()
      const encBytes = new Uint8Array(await crypto.subtle.exportKey('raw', encPub.publicKey))
      const signJwk = await crypto.subtle.exportKey('jwk', signPub)
      // Different algorithms, different keys
      expect(encPub.publicKey.algorithm.name).toBe('X25519')
      expect(signPub.algorithm.name).toBe('Ed25519')
      // Raw bytes should differ (different curve representations)
      expect(encBytes.length).toBe(32)
      expect(signJwk.x).toBeDefined()
    })

    it('should produce different keys for different identities', async () => {
      const aliceKp = await alice.getEncryptionKeyPair()
      const bobKp = await bob.getEncryptionKeyPair()
      const alicePub = new Uint8Array(await crypto.subtle.exportKey('raw', aliceKp.publicKey))
      const bobPub = new Uint8Array(await crypto.subtle.exportKey('raw', bobKp.publicKey))
      expect(alicePub).not.toEqual(bobPub)
    })

    it('should throw when identity is locked', async () => {
      const locked = new WotIdentity()
      await expect(locked.getEncryptionKeyPair()).rejects.toThrow()
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

    it('should handle empty plaintext', async () => {
      const bobPubBytes = await bob.getEncryptionPublicKeyBytes()
      const plaintext = new Uint8Array(0)

      const encrypted = await alice.encryptForRecipient(plaintext, bobPubBytes)
      const decrypted = await bob.decryptForMe(encrypted)
      expect(decrypted).toEqual(plaintext)
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

    it('should throw when identity is locked', async () => {
      const locked = new WotIdentity()
      const bobPubBytes = await bob.getEncryptionPublicKeyBytes()

      await expect(locked.encryptForRecipient(
        new TextEncoder().encode('test'),
        bobPubBytes
      )).rejects.toThrow()

      await expect(locked.decryptForMe({
        ciphertext: new Uint8Array(32),
        nonce: new Uint8Array(12),
        ephemeralPublicKey: new Uint8Array(32),
      })).rejects.toThrow()
    })
  })

  describe('getEncryptionPublicKeyBytes()', () => {
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
