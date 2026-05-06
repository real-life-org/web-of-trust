import * as ed25519 from '@noble/ed25519'
import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { hexToBytes } from '../crypto/hex'
import { publicKeyToDidKey } from '../identity/did-key'

const BIP39_SEED_LENGTH_BYTES = 64
const SPACE_ID_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface SpaceAdminKeyMaterial {
  hkdfInfo: string
  ed25519Seed: Uint8Array
  ed25519PublicKey: Uint8Array
  did: string
}

export async function deriveSpaceAdminKeyFromSeedHex(
  bip39SeedHex: string,
  spaceId: string,
  cryptoAdapter: ProtocolCryptoAdapter,
): Promise<SpaceAdminKeyMaterial> {
  const seed = bip39SeedHexToBytes(bip39SeedHex)
  const canonicalSpaceId = canonicalizeSpaceId(spaceId)
  const hkdfInfo = `wot/space-admin/${canonicalSpaceId}/v1`
  const ed25519Seed = await cryptoAdapter.hkdfSha256(seed, hkdfInfo, 32)
  const ed25519PublicKey = new Uint8Array(await ed25519.getPublicKeyAsync(ed25519Seed))
  return { hkdfInfo, ed25519Seed, ed25519PublicKey, did: publicKeyToDidKey(ed25519PublicKey) }
}

function bip39SeedHexToBytes(bip39SeedHex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(bip39SeedHex)) throw new Error('Invalid BIP39 seed hex')
  const seed = hexToBytes(bip39SeedHex)
  if (seed.length !== BIP39_SEED_LENGTH_BYTES) {
    throw new Error(`BIP39 seed hex must decode to ${BIP39_SEED_LENGTH_BYTES} bytes`)
  }
  return seed
}

function canonicalizeSpaceId(spaceId: string): string {
  if (!SPACE_ID_UUID_V4_PATTERN.test(spaceId)) throw new Error('spaceId must be a UUID v4 string')
  return spaceId.toLowerCase()
}
