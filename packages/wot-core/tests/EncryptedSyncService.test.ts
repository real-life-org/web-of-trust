import { describe, it, expect } from 'vitest'
import { EncryptedSyncService, type EncryptedChange } from '../src/services/EncryptedSyncService'
import { WebCryptoAdapter } from '../src/adapters/crypto/WebCryptoAdapter'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters/web-crypto'
import { deriveLogPayloadNonce } from '../src/protocol/sync/encryption'

const logPayloadEncryptionVector = {
  space_content_key_hex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  device_id: '550e8400-e29b-41d4-a716-446655440000',
  seq: 42,
  nonce_hex: '7ae069db68aeb3161aa67131',
  plaintext: '{"op":"set","path":["title"],"value":"Hello WoT"}',
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('EncryptedSyncService', () => {
  const crypto = new WebCryptoAdapter()
  const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

  it('should encrypt a change with group key', async () => {
    const groupKey = await crypto.generateSymmetricKey()
    const data = new TextEncoder().encode('{"counter": 42}')

    const encrypted = await EncryptedSyncService.encryptChange(
      data,
      groupKey,
      'space-123',
      1,
      'did:key:zAlice',
      'device-alice',
      1,
    )

    expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array)
    expect(encrypted.nonce).toBeInstanceOf(Uint8Array)
    expect(encrypted.nonce.length).toBe(12)
    expect(encrypted.spaceId).toBe('space-123')
    expect(encrypted.generation).toBe(1)
    expect(encrypted.fromDid).toBe('did:key:zAlice')
    expect(encrypted.deviceId).toBe('device-alice')
    expect(encrypted.seq).toBe(1)
  })

  it('should decrypt a change with correct group key', async () => {
    const groupKey = await crypto.generateSymmetricKey()
    const original = new TextEncoder().encode('{"counter": 42}')

    const encrypted = await EncryptedSyncService.encryptChange(
      original,
      groupKey,
      'space-123',
      1,
      'did:key:zAlice',
      'device-alice',
      1,
    )

    const decrypted = await EncryptedSyncService.decryptChange(encrypted, groupKey)
    expect(decrypted).toEqual(original)
  })

  it('should fail with wrong group key', async () => {
    const groupKey1 = await crypto.generateSymmetricKey()
    const groupKey2 = await crypto.generateSymmetricKey()
    const data = new TextEncoder().encode('secret')

    const encrypted = await EncryptedSyncService.encryptChange(
      data,
      groupKey1,
      'space-123',
      1,
      'did:key:zAlice',
      'device-alice',
      1,
    )

    await expect(
      EncryptedSyncService.decryptChange(encrypted, groupKey2),
    ).rejects.toThrow()
  })

  it('should include spaceId and generation in metadata', async () => {
    const groupKey = await crypto.generateSymmetricKey()
    const data = new TextEncoder().encode('test')

    const encrypted = await EncryptedSyncService.encryptChange(
      data,
      groupKey,
      'my-space-456',
      3,
      'did:key:zBob',
      'device-bob',
      7,
    )

    expect(encrypted.spaceId).toBe('my-space-456')
    expect(encrypted.generation).toBe(3)
    expect(encrypted.fromDid).toBe('did:key:zBob')
    expect(encrypted.deviceId).toBe('device-bob')
    expect(encrypted.seq).toBe(7)
  })

  it('should include fromDid in metadata', async () => {
    const groupKey = await crypto.generateSymmetricKey()
    const data = new TextEncoder().encode('test')

    const encrypted = await EncryptedSyncService.encryptChange(
      data,
      groupKey,
      'space-1',
      1,
      'did:key:z6MkTest123',
      'device-123',
      1,
    )

    expect(encrypted.fromDid).toBe('did:key:z6MkTest123')
  })

  it('derives deterministic nonce from deviceId and seq using the log payload vector', async () => {
    const vector = logPayloadEncryptionVector
    const groupKey = hexToBytes(vector.space_content_key_hex)
    const data = new TextEncoder().encode(vector.plaintext)

    const enc1 = await EncryptedSyncService.encryptChange(
      data,
      groupKey,
      's',
      1,
      'did:key:z1',
      vector.device_id,
      vector.seq,
    )
    const enc2 = await EncryptedSyncService.encryptChange(
      data,
      groupKey,
      's',
      1,
      'did:key:z1',
      vector.device_id,
      vector.seq,
    )
    const encNextSeq = await EncryptedSyncService.encryptChange(
      data,
      groupKey,
      's',
      1,
      'did:key:z1',
      vector.device_id,
      vector.seq + 1,
    )
    const expectedDigest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${vector.device_id}|${vector.seq}`)),
    ).slice(0, 12)
    const helperNonce = await deriveLogPayloadNonce(protocolCrypto, vector.device_id, vector.seq)

    expect(enc1.nonce).toEqual(expectedDigest)
    expect(enc1.nonce).toEqual(helperNonce)
    expect(bytesToHex(enc1.nonce)).toBe(vector.nonce_hex)
    expect(enc2.nonce).toEqual(enc1.nonce)
    expect(encNextSeq.nonce).not.toEqual(enc1.nonce)
    expect(enc1.deviceId).toBe(vector.device_id)
    expect(enc1.seq).toBe(vector.seq)
  })

  it('should fail with tampered ciphertext', async () => {
    const groupKey = await crypto.generateSymmetricKey()
    const data = new TextEncoder().encode('do not tamper')

    const encrypted = await EncryptedSyncService.encryptChange(data, groupKey, 's', 1, 'did:key:z1', 'device-1', 1)
    const tampered: EncryptedChange = {
      ...encrypted,
      ciphertext: new Uint8Array([...encrypted.ciphertext]),
    }
    tampered.ciphertext[0] ^= 0xff

    await expect(
      EncryptedSyncService.decryptChange(tampered, groupKey),
    ).rejects.toThrow()
  })

  it('should handle empty data', async () => {
    const groupKey = await crypto.generateSymmetricKey()
    const data = new Uint8Array(0)

    const encrypted = await EncryptedSyncService.encryptChange(data, groupKey, 's', 1, 'did:key:z1', 'device-1', 1)
    const decrypted = await EncryptedSyncService.decryptChange(encrypted, groupKey)
    expect(decrypted).toEqual(data)
  })
})
