import * as ed25519 from '@noble/ed25519'
import { hexToBytes } from '../crypto/hex'
import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { publicKeyToDidKey } from './did-key'

const IDENTITY_INFO = 'wot/identity/ed25519/v1'
const ENCRYPTION_INFO = 'wot/encryption/x25519/v1'
const BIP39_EMPTY_PASSPHRASE = ''
const HEX_PATTERN = /^[0-9a-fA-F]*$/

interface Bip39Modules {
  mnemonicToSeed: (mnemonic: string, passphrase: string) => Promise<Uint8Array>
  validateMnemonic: (mnemonic: string, wordlist: string[]) => boolean
  englishWordlist: string[]
}

let bip39ModulesPromise: Promise<Bip39Modules> | undefined

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
  // hexToBytes only enforces even length; keep a seed-specific error for non-hex input.
  if (bip39SeedHex.length % 2 !== 0 || !HEX_PATTERN.test(bip39SeedHex)) {
    throw new Error('Invalid BIP39 seed hex')
  }

  const seed = hexToBytes(bip39SeedHex)
  return deriveProtocolIdentityFromSeedBytes(seed, cryptoAdapter)
}

async function deriveProtocolIdentityFromSeedBytes(
  bip39Seed: Uint8Array,
  cryptoAdapter: ProtocolCryptoAdapter,
): Promise<ProtocolIdentityMaterial> {
  if (bip39Seed.length !== 64) throw new Error('Expected 64-byte BIP39 seed')

  const ed25519Seed = await cryptoAdapter.hkdfSha256(bip39Seed, IDENTITY_INFO, 32)
  const ed25519PublicKey = new Uint8Array(await ed25519.getPublicKeyAsync(ed25519Seed))
  const x25519Seed = await cryptoAdapter.hkdfSha256(bip39Seed, ENCRYPTION_INFO, 32)
  const x25519PublicKey = await cryptoAdapter.x25519PublicFromSeed(x25519Seed)
  const did = publicKeyToDidKey(ed25519PublicKey)
  return { ed25519Seed, ed25519PublicKey, x25519Seed, x25519PublicKey, did, kid: `${did}#sig-0` }
}

// wot-identity@0.1 Identity 001 fixes BIP39 seed derivation to passphrase="" and the full 64-byte seed; English is the default wordlist.
export async function deriveBip39SeedFromMnemonic(mnemonic: string): Promise<Uint8Array> {
  const { mnemonicToSeed, validateMnemonic, englishWordlist } = await loadBip39Modules()

  if (!validateMnemonic(mnemonic, englishWordlist)) throw new Error('Invalid BIP39 mnemonic')

  return mnemonicToSeed(mnemonic, BIP39_EMPTY_PASSPHRASE)
}

// wot-identity@0.1 Identity 001 derives protocol identity material from the full BIP39 seed without slicing.
export async function deriveProtocolIdentityFromMnemonic(
  mnemonic: string,
  cryptoAdapter: ProtocolCryptoAdapter,
): Promise<ProtocolIdentityMaterial> {
  const seed = await deriveBip39SeedFromMnemonic(mnemonic)
  return deriveProtocolIdentityFromSeedBytes(seed, cryptoAdapter)
}

function loadBip39Modules(): Promise<Bip39Modules> {
  if (!bip39ModulesPromise) {
    bip39ModulesPromise = Promise.all([
      import('@scure/bip39'),
      import('@scure/bip39/wordlists/english.js'),
    ]).then(([bip39, english]) => ({
      mnemonicToSeed: bip39.mnemonicToSeed,
      validateMnemonic: bip39.validateMnemonic,
      englishWordlist: english.wordlist,
    })).catch((error) => {
      bip39ModulesPromise = undefined
      throw error
    })
  }

  return bip39ModulesPromise
}
