import {
  decodeBase64Url,
  encryptEcies,
  publicKeyToDidKey,
} from '../../protocol'
import type { ProtocolCryptoAdapter } from '../../protocol'
import type { IdentityEncryptedPayload, IdentityVaultUnlockHandle } from '../../types/identity-session'

const BIP39_SEED_LENGTH = 64

// Builds an operation-shaped IdentityVaultUnlockHandle from a raw BIP39 seed.
// Reference seed-vault adapters use this internally and bind operations to an
// adapter-owned opaque key boundary before returning control to application code.
export async function createIdentityVaultUnlockHandle(
  bip39Seed: Uint8Array,
  cryptoAdapter: ProtocolCryptoAdapter,
): Promise<IdentityVaultUnlockHandle> {
  if (bip39Seed.length !== BIP39_SEED_LENGTH) throw new Error('Invalid identity seed format')
  if (!cryptoAdapter.createIdentityVaultCryptoHandle) {
    throw new Error('Identity vault crypto handles require an opaque key-capable crypto adapter')
  }

  const keys = await cryptoAdapter.createIdentityVaultCryptoHandle(bip39Seed)
  const ed25519PublicKey = new Uint8Array(keys.ed25519PublicKey)
  const x25519PublicKey = new Uint8Array(keys.x25519PublicKey)
  const did = publicKeyToDidKey(ed25519PublicKey)

  return {
    did,
    kid: `${did}#sig-0`,
    ed25519PublicKey,
    x25519PublicKey,
    async signEd25519(data: Uint8Array): Promise<Uint8Array> {
      return keys.signEd25519(data)
    },
    async decryptForMe(payload: IdentityEncryptedPayload): Promise<Uint8Array> {
      if (!payload.ephemeralPublicKey) throw new Error('Missing ephemeral public key')
      return keys.decryptForMe(payload.ephemeralPublicKey, payload.nonce, payload.ciphertext)
    },
    async deriveFrameworkKey(info: string, length: number = 32): Promise<Uint8Array> {
      return keys.deriveFrameworkKey(info, length)
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
