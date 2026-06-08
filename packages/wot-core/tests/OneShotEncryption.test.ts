import { describe, expect, it } from 'vitest'
import { decodeBase64Url, decryptOneShot, encryptOneShot } from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

// Sync 001 §Symmetrische Verschlüsselung + Nonce-Konstruktion:
// OneShot payloads (snapshots, messaging, personal-doc one-shots, invites) are
// encrypted under a Space Content Key with a cryptographically RANDOM 12-byte
// nonce (Z.103-105), framed as `Nonce ‖ Ciphertext+Tag` (Z.67-75), and MUST
// reject empty plaintext / tag-only ciphertext (Z.75).

const crypto = new WebCryptoProtocolCryptoAdapter()

const NONCE_LENGTH = 12
const AES_GCM_TAG_LENGTH = 16

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('encryptOneShot / decryptOneShot (Sync 001 OneShot random-nonce payloads)', () => {
  const spaceContentKey = new Uint8Array(32).fill(7)
  const plaintext = new TextEncoder().encode('hello one-shot snapshot')

  it('round-trips plaintext through encrypt + decrypt', async () => {
    const result = await encryptOneShot({ crypto, spaceContentKey, plaintext })
    const decrypted = await decryptOneShot({ crypto, spaceContentKey, blob: result.blob })
    expect(bytesToHex(decrypted)).toBe(bytesToHex(plaintext))
  })

  it('frames the blob as nonce(12) ‖ ciphertext+tag and exposes base64url', async () => {
    const result = await encryptOneShot({ crypto, spaceContentKey, plaintext })
    expect(result.nonce.length).toBe(NONCE_LENGTH)
    expect(result.ciphertextTag.length).toBeGreaterThan(AES_GCM_TAG_LENGTH)
    expect(result.blob.length).toBe(result.nonce.length + result.ciphertextTag.length)
    expect(bytesToHex(result.blob.slice(0, NONCE_LENGTH))).toBe(bytesToHex(result.nonce))
    expect(bytesToHex(result.blob.slice(NONCE_LENGTH))).toBe(bytesToHex(result.ciphertextTag))
    expect(bytesToHex(decodeBase64Url(result.blobBase64Url))).toBe(bytesToHex(result.blob))
  })

  it('uses a fresh random nonce on every call (Sync 001 Z.103-105 MUSS)', async () => {
    const a = await encryptOneShot({ crypto, spaceContentKey, plaintext })
    const b = await encryptOneShot({ crypto, spaceContentKey, plaintext })
    expect(bytesToHex(a.nonce)).not.toBe(bytesToHex(b.nonce))
    expect(bytesToHex(a.blob)).not.toBe(bytesToHex(b.blob))
  })

  it('rejects empty plaintext (Sync 001 Z.75)', async () => {
    await expect(
      encryptOneShot({ crypto, spaceContentKey, plaintext: new Uint8Array(0) }),
    ).rejects.toThrow()
  })

  it('rejects a space content key that is not 32 bytes', async () => {
    await expect(
      encryptOneShot({ crypto, spaceContentKey: new Uint8Array(31), plaintext }),
    ).rejects.toThrow()
    const result = await encryptOneShot({ crypto, spaceContentKey, plaintext })
    await expect(
      decryptOneShot({ crypto, spaceContentKey: new Uint8Array(31), blob: result.blob }),
    ).rejects.toThrow()
  })

  it('rejects a tag-only / too-short blob on decrypt (Sync 001 Z.75)', async () => {
    await expect(
      decryptOneShot({ crypto, spaceContentKey, blob: new Uint8Array(NONCE_LENGTH + AES_GCM_TAG_LENGTH) }),
    ).rejects.toThrow()
  })

  it('fails authentication when decrypting with the wrong key', async () => {
    const result = await encryptOneShot({ crypto, spaceContentKey, plaintext })
    const wrongKey = new Uint8Array(32).fill(9)
    await expect(
      decryptOneShot({ crypto, spaceContentKey: wrongKey, blob: result.blob }),
    ).rejects.toThrow()
  })

  it('round-trips binary payloads with zero and high bytes', async () => {
    const binary = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 0, 42])
    const result = await encryptOneShot({ crypto, spaceContentKey, plaintext: binary })
    const decrypted = await decryptOneShot({ crypto, spaceContentKey, blob: result.blob })
    expect(bytesToHex(decrypted)).toBe(bytesToHex(binary))
  })

  it('rejects a tampered ciphertext (AES-GCM authentication failure)', async () => {
    const result = await encryptOneShot({ crypto, spaceContentKey, plaintext })
    const tampered = new Uint8Array(result.blob)
    // Flip a byte inside the ciphertext+tag segment (past the 12-byte nonce).
    tampered[tampered.length - 1] ^= 0xff
    await expect(decryptOneShot({ crypto, spaceContentKey, blob: tampered })).rejects.toThrow()
  })
})
