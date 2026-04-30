import * as ed25519 from '@noble/ed25519'
import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { hexToBytes } from '../crypto/hex'
import { publicKeyToDidKey } from '../identity/did-key'

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
  if (!spaceId) throw new Error('Missing spaceId')
  const seed = hexToBytes(bip39SeedHex)
  const hkdfInfo = `wot/space-admin/${spaceId}/v1`
  const ed25519Seed = await cryptoAdapter.hkdfSha256(seed, hkdfInfo, 32)
  const ed25519PublicKey = new Uint8Array(await ed25519.getPublicKeyAsync(ed25519Seed))
  return { hkdfInfo, ed25519Seed, ed25519PublicKey, did: publicKeyToDidKey(ed25519PublicKey) }
}
