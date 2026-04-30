import * as ed25519 from '@noble/ed25519'
import { hexToBytes } from '../crypto/hex'
import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { publicKeyToDidKey } from './did-key'

const IDENTITY_INFO = 'wot/identity/ed25519/v1'
const ENCRYPTION_INFO = 'wot/encryption/x25519/v1'

export interface ProtocolIdentityMaterial {
  ed25519Seed: Uint8Array
  ed25519PublicKey: Uint8Array
  x25519Seed: Uint8Array
  x25519PublicKey: Uint8Array
  did: string
  kid: string
}

export async function deriveProtocolIdentityFromSeedHex(
  bip39SeedHex: string,
  cryptoAdapter: ProtocolCryptoAdapter,
): Promise<ProtocolIdentityMaterial> {
  const seed = hexToBytes(bip39SeedHex)
  const ed25519Seed = await cryptoAdapter.hkdfSha256(seed, IDENTITY_INFO, 32)
  const ed25519PublicKey = new Uint8Array(await ed25519.getPublicKeyAsync(ed25519Seed))
  const x25519Seed = await cryptoAdapter.hkdfSha256(seed, ENCRYPTION_INFO, 32)
  const x25519PublicKey = await cryptoAdapter.x25519PublicFromSeed(x25519Seed)
  const did = publicKeyToDidKey(ed25519PublicKey)
  return { ed25519Seed, ed25519PublicKey, x25519Seed, x25519PublicKey, did, kid: `${did}#sig-0` }
}
