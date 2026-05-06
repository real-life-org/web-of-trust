import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { hexToBytes } from '../crypto/hex'

const PERSONAL_DOC_INFO = 'wot/personal-doc/v1'
const BIP39_SEED_LENGTH_BYTES = 64
const PERSONAL_DOC_KEY_LENGTH_BYTES = 32

export interface PersonalDocMaterial {
  hkdfInfo: string
  key: Uint8Array
  docId: string
}

export async function derivePersonalDocFromSeedHex(
  bip39SeedHex: string,
  cryptoAdapter: ProtocolCryptoAdapter,
): Promise<PersonalDocMaterial> {
  const seed = bip39SeedHexToBytes(bip39SeedHex)
  const key = await cryptoAdapter.hkdfSha256(seed, PERSONAL_DOC_INFO, 32)
  return { hkdfInfo: PERSONAL_DOC_INFO, key, docId: personalDocIdFromKey(key) }
}

export function personalDocIdFromKey(key: Uint8Array): string {
  if (key.length !== PERSONAL_DOC_KEY_LENGTH_BYTES) {
    throw new Error(`Personal Doc key must be exactly ${PERSONAL_DOC_KEY_LENGTH_BYTES} bytes`)
  }
  const rawDocId = key.slice(0, 16)
  return [
    bytesToLowerHex(rawDocId.slice(0, 4)),
    bytesToLowerHex(rawDocId.slice(4, 6)),
    bytesToLowerHex(rawDocId.slice(6, 8)),
    bytesToLowerHex(rawDocId.slice(8, 10)),
    bytesToLowerHex(rawDocId.slice(10, 16)),
  ].join('-')
}

function bip39SeedHexToBytes(bip39SeedHex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(bip39SeedHex)) throw new Error('Invalid BIP39 seed hex')
  const seed = hexToBytes(bip39SeedHex)
  if (seed.length !== BIP39_SEED_LENGTH_BYTES) {
    throw new Error(`BIP39 seed hex must decode to ${BIP39_SEED_LENGTH_BYTES} bytes`)
  }
  return seed
}

function bytesToLowerHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
