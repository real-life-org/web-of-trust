import * as ed25519 from '@noble/ed25519'
import {
  bytesToHex,
  decodeBase64Url,
  decryptEcies,
  deriveProtocolIdentityFromSeedHex,
  encodeBase64Url,
  encryptEcies,
} from '../../protocol'
import type { ProtocolCryptoAdapter } from '../../protocol'
import type { IdentityEncryptedPayload, IdentityVaultUnlockHandle } from '../../types/identity-session'

const BIP39_SEED_LENGTH = 64

// Builds an operation-shaped IdentityVaultUnlockHandle from a raw BIP39 seed.
// Reference seed-vault adapters use this internally so the raw seed is only
// captured in the handle's private closure and never returned to application
// code through the IdentitySeedVault port.
export async function createIdentityVaultUnlockHandle(
  bip39Seed: Uint8Array,
  cryptoAdapter: ProtocolCryptoAdapter,
): Promise<IdentityVaultUnlockHandle> {
  if (bip39Seed.length !== BIP39_SEED_LENGTH) throw new Error('Invalid identity seed format')
  const sealedSeed = new Uint8Array(bip39Seed)
  const material = await deriveProtocolIdentityFromSeedHex(bytesToHex(sealedSeed), cryptoAdapter)
  const ed25519Seed = new Uint8Array(material.ed25519Seed)
  const x25519Seed = new Uint8Array(material.x25519Seed)
  const ed25519PublicKey = new Uint8Array(material.ed25519PublicKey)
  const x25519PublicKey = new Uint8Array(material.x25519PublicKey)

  return {
    did: material.did,
    kid: material.kid,
    ed25519PublicKey,
    x25519PublicKey,
    async signEd25519(data: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(await ed25519.signAsync(data, ed25519Seed))
    },
    async decryptForMe(payload: IdentityEncryptedPayload): Promise<Uint8Array> {
      if (!payload.ephemeralPublicKey) throw new Error('Missing ephemeral public key')
      return decryptEcies({
        crypto: cryptoAdapter,
        recipientPrivateSeed: x25519Seed,
        message: {
          epk: encodeBase64Url(payload.ephemeralPublicKey),
          nonce: encodeBase64Url(payload.nonce),
          ciphertext: encodeBase64Url(payload.ciphertext),
        },
      })
    },
    async deriveFrameworkKey(info: string, length: number = 32): Promise<Uint8Array> {
      return cryptoAdapter.hkdfSha256(sealedSeed, info, length)
    },
  }
}

// ECIES envelope construction for sending to a recipient. Encryption does not
// require access to the local seed, so it stays in application code rather
// than on the vault handle.
export async function encryptForRecipientUsingX25519(
  cryptoAdapter: ProtocolCryptoAdapter,
  plaintext: Uint8Array,
  recipientPublicKeyBytes: Uint8Array,
): Promise<IdentityEncryptedPayload> {
  const ephemeralPrivateSeed = crypto.getRandomValues(new Uint8Array(32))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const message = await encryptEcies({
    crypto: cryptoAdapter,
    ephemeralPrivateSeed,
    recipientPublicKey: recipientPublicKeyBytes,
    nonce,
    plaintext,
  })
  return {
    ciphertext: decodeBase64Url(message.ciphertext),
    nonce: decodeBase64Url(message.nonce),
    ephemeralPublicKey: decodeBase64Url(message.epk),
  }
}
