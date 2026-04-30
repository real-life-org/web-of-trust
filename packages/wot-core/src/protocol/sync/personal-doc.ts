import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { hexToBytes } from '../crypto/hex'

const PERSONAL_DOC_INFO = 'wot/personal-doc/v1'

export interface PersonalDocMaterial {
  hkdfInfo: string
  key: Uint8Array
  docId: string
}

export async function derivePersonalDocFromSeedHex(
  bip39SeedHex: string,
  cryptoAdapter: ProtocolCryptoAdapter,
): Promise<PersonalDocMaterial> {
  const seed = hexToBytes(bip39SeedHex)
  const key = await cryptoAdapter.hkdfSha256(seed, PERSONAL_DOC_INFO, 32)
  return { hkdfInfo: PERSONAL_DOC_INFO, key, docId: personalDocIdFromKey(key) }
}

export function personalDocIdFromKey(key: Uint8Array): string {
  if (key.length < 16) throw new Error('Personal Doc key must be at least 16 bytes')
  const rawDocId = key.slice(0, 16)
  return [
    bytesToLowerHex(rawDocId.slice(0, 4)),
    bytesToLowerHex(rawDocId.slice(4, 6)),
    bytesToLowerHex(rawDocId.slice(6, 8)),
    bytesToLowerHex(rawDocId.slice(8, 10)),
    bytesToLowerHex(rawDocId.slice(10, 16)),
  ].join('-')
}

function bytesToLowerHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
