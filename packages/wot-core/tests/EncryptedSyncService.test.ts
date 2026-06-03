import { describe, it, expect } from 'vitest'
import { EncryptedSyncService, type EncryptedChange } from '../src/services/EncryptedSyncService'
import { WebCryptoAdapter } from '../src/adapters/crypto/WebCryptoAdapter'

describe('EncryptedSyncService', () => {
  const cryptoAdapter = new WebCryptoAdapter()

  async function expectedLogEntryNonce(deviceId: string, seq: number): Promise<Uint8Array> {
    const input = new TextEncoder().encode(`${deviceId}|${seq}`)
    const digest = await crypto.subtle.digest('SHA-256', input)
    return new Uint8Array(digest).slice(0, 12)
  }

  it('should encrypt a change with group key', async () => {
    const groupKey = await cryptoAdapter.generateSymmetricKey()
    const data = new TextEncoder().encode('{"counter": 42}')

    const encrypted = await EncryptedSyncService.encryptOneShot(
      data,
      groupKey,
      'space-123',
      1,
      'did:key:zAlice',
    )

    expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array)
    expect(encrypted.nonce).toBeInstanceOf(Uint8Array)
    expect(encrypted.nonce.length).toBe(12)
    expect(encrypted.spaceId).toBe('space-123')
    expect(encrypted.generation).toBe(1)
    expect(encrypted.fromDid).toBe('did:key:zAlice')
  })

  it('should decrypt a change with correct group key', async () => {
    const groupKey = await cryptoAdapter.generateSymmetricKey()
    const original = new TextEncoder().encode('{"counter": 42}')

    const encrypted = await EncryptedSyncService.encryptOneShot(
      original,
      groupKey,
      'space-123',
      1,
      'did:key:zAlice',
    )

    const decrypted = await EncryptedSyncService.decryptChange(encrypted, groupKey)
    expect(decrypted).toEqual(original)
  })

  it('should fail with wrong group key', async () => {
    const groupKey1 = await cryptoAdapter.generateSymmetricKey()
    const groupKey2 = await cryptoAdapter.generateSymmetricKey()
    const data = new TextEncoder().encode('secret')

    const encrypted = await EncryptedSyncService.encryptOneShot(
      data,
      groupKey1,
      'space-123',
      1,
      'did:key:zAlice',
    )

    await expect(
      EncryptedSyncService.decryptChange(encrypted, groupKey2),
    ).rejects.toThrow()
  })

  it('should include spaceId and generation in metadata', async () => {
    const groupKey = await cryptoAdapter.generateSymmetricKey()
    const data = new TextEncoder().encode('test')

    const encrypted = await EncryptedSyncService.encryptOneShot(
      data,
      groupKey,
      'my-space-456',
      3,
      'did:key:zBob',
    )

    expect(encrypted.spaceId).toBe('my-space-456')
    expect(encrypted.generation).toBe(3)
    expect(encrypted.fromDid).toBe('did:key:zBob')
  })

  it('should include fromDid in metadata', async () => {
    const groupKey = await cryptoAdapter.generateSymmetricKey()
    const data = new TextEncoder().encode('test')

    const encrypted = await EncryptedSyncService.encryptOneShot(
      data,
      groupKey,
      'space-1',
      1,
      'did:key:z6MkTest123',
    )

    expect(encrypted.fromDid).toBe('did:key:z6MkTest123')
  })

  it('should produce the SHA-256 based nonce for log entries', async () => {
    const groupKey = await cryptoAdapter.generateSymmetricKey()
    const data = new TextEncoder().encode('log entry')
    const deviceId = '018f6a7b-2f3c-4d5e-8a90-0123456789ab'
    const seq = 42

    const encrypted = await EncryptedSyncService.encryptLogEntry(
      data,
      groupKey,
      'space-log',
      7,
      'did:key:zAlice',
      deviceId,
      seq,
    )

    expect(encrypted.nonce).toEqual(await expectedLogEntryNonce(deviceId, seq))
    await expect(EncryptedSyncService.decryptChange(encrypted, groupKey)).resolves.toEqual(data)
  })

  it('should produce different ciphertexts for same one-shot data (random nonce)', async () => {
    const groupKey = await cryptoAdapter.generateSymmetricKey()
    const data = new TextEncoder().encode('same data')

    const enc1 = await EncryptedSyncService.encryptOneShot(data, groupKey, 's', 1, 'did:key:z1')
    const enc2 = await EncryptedSyncService.encryptOneShot(data, groupKey, 's', 1, 'did:key:z1')

    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext)
    expect(enc1.nonce).not.toEqual(enc2.nonce)
  })

  it('should not use the log-entry nonce for one-shot encryption', async () => {
    const groupKey = await cryptoAdapter.generateSymmetricKey()
    const data = new TextEncoder().encode('one shot')
    const deviceId = 'device-a'
    const seq = 9
    const deterministicNonce = await expectedLogEntryNonce(deviceId, seq)

    const encrypted = await EncryptedSyncService.encryptOneShot(
      data,
      groupKey,
      'space-log',
      7,
      'did:key:zAlice',
    )

    expect(encrypted.nonce).not.toEqual(deterministicNonce)
  })

  it('should fail with tampered ciphertext', async () => {
    const groupKey = await cryptoAdapter.generateSymmetricKey()
    const data = new TextEncoder().encode('do not tamper')

    const encrypted = await EncryptedSyncService.encryptOneShot(data, groupKey, 's', 1, 'did:key:z1')
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
    const groupKey = await cryptoAdapter.generateSymmetricKey()
    const data = new Uint8Array(0)

    const encrypted = await EncryptedSyncService.encryptOneShot(data, groupKey, 's', 1, 'did:key:z1')
    const decrypted = await EncryptedSyncService.decryptChange(encrypted, groupKey)
    expect(decrypted).toEqual(data)
  })
})
