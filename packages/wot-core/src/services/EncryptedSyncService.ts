/**
 * EncryptedSyncService — Encrypts/decrypts CRDT changes with a group key.
 *
 * Used for Encrypted Group Spaces: each change is AES-256-GCM encrypted
 * before being sent to other members. The server (relay) never sees plaintext.
 *
 * Pattern: Encrypt-then-sync (inspired by Keyhive/NextGraph)
 */

export interface EncryptedChange {
  ciphertext: Uint8Array
  nonce: Uint8Array
  spaceId: string
  generation: number
  fromDid: string
}

// Cache imported CryptoKeys to avoid re-importing on every CRDT change.
// Key: hex-encoded raw bytes + usage → Value: CryptoKey
const keyCache = new Map<string, CryptoKey>()

function cacheKey(rawKey: Uint8Array, usage: 'encrypt' | 'decrypt'): string {
  let hex = ''
  for (let i = 0; i < rawKey.length; i++) hex += rawKey[i].toString(16).padStart(2, '0')
  return `${hex}:${usage}`
}

async function getOrImportKey(rawKey: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const id = cacheKey(rawKey, usage)
  let key = keyCache.get(id)
  if (!key) {
    key = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      false,
      [usage],
    )
    keyCache.set(id, key)
  }
  return key
}

async function deriveLogEntryNonce(deviceId: string, seq: number): Promise<Uint8Array> {
  const input = new TextEncoder().encode(`${deviceId}|${seq}`)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return new Uint8Array(digest).slice(0, 12)
}

async function encryptWithNonce(
  data: Uint8Array,
  groupKey: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const key = await getOrImportKey(groupKey, 'encrypt')
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    data,
  )
  return new Uint8Array(ciphertext)
}

export class EncryptedSyncService {
  /**
   * Encrypt a Sync-002 log entry with a deterministic nonce.
   */
  static async encryptLogEntry(
    data: Uint8Array,
    groupKey: Uint8Array,
    spaceId: string,
    generation: number,
    fromDid: string,
    deviceId: string,
    seq: number,
  ): Promise<EncryptedChange> {
    const nonce = await deriveLogEntryNonce(deviceId, seq)

    return {
      ciphertext: await encryptWithNonce(data, groupKey, nonce),
      nonce,
      spaceId,
      generation,
      fromDid,
    }
  }

  /**
   * Encrypt a one-shot payload with a random nonce.
   */
  static async encryptOneShot(
    data: Uint8Array,
    groupKey: Uint8Array,
    spaceId: string,
    generation: number,
    fromDid: string,
  ): Promise<EncryptedChange> {
    const nonce = crypto.getRandomValues(new Uint8Array(12))

    return {
      ciphertext: await encryptWithNonce(data, groupKey, nonce),
      nonce,
      spaceId,
      generation,
      fromDid,
    }
  }

  /**
   * Decrypt a CRDT change with a group key.
   */
  static async decryptChange(
    change: EncryptedChange,
    groupKey: Uint8Array,
  ): Promise<Uint8Array> {
    const key = await getOrImportKey(groupKey, 'decrypt')

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: change.nonce },
      key,
      change.ciphertext,
    )

    return new Uint8Array(plaintext)
  }
}
