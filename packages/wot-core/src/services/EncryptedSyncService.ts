/**
 * EncryptedSyncService — Encrypts/decrypts CRDT changes with a group key.
 *
 * Used for Encrypted Group Spaces: each change is AES-256-GCM encrypted
 * before being sent to other members. The server (relay) never sees plaintext.
 *
 * Pattern: Encrypt-then-sync (inspired by Keyhive/NextGraph)
 */

import { WebCryptoProtocolCryptoAdapter } from '../protocol-adapters/web-crypto'
import { deriveLogPayloadNonce } from '../protocol/sync/encryption'

export interface EncryptedChange {
  ciphertext: Uint8Array
  nonce: Uint8Array
  spaceId: string
  generation: number
  fromDid: string
  deviceId: string
  seq: number
}

// Cache imported CryptoKeys to avoid re-importing on every CRDT change.
// Key: hex-encoded raw bytes + usage → Value: CryptoKey
const keyCache = new Map<string, CryptoKey>()
const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

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

export class EncryptedSyncService {
  /**
   * Encrypt a CRDT change with a group key.
   */
  static async encryptChange(
    data: Uint8Array,
    groupKey: Uint8Array,
    spaceId: string,
    generation: number,
    fromDid: string,
    deviceId: string,
    seq: number,
  ): Promise<EncryptedChange> {
    const key = await getOrImportKey(groupKey, 'encrypt')

    const nonce = await deriveLogPayloadNonce(protocolCrypto, deviceId, seq)
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      data,
    )

    return {
      ciphertext: new Uint8Array(ciphertext),
      nonce,
      spaceId,
      generation,
      fromDid,
      deviceId,
      seq,
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
