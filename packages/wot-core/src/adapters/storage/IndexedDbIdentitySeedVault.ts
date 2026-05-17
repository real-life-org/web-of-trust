import { SeedStorage } from '../../identity/SeedStorage'
import { createIdentityVaultUnlockHandle } from '../../application/identity/identity-vault-handle'
import { WebCryptoProtocolCryptoAdapter } from '../../protocol-adapters'
import { decodeBase64Url, encodeBase64Url } from '../../protocol'
import type { ProtocolCryptoAdapter } from '../../protocol'
import type { SeedStorageAdapter } from '../../ports/SeedStorageAdapter'
import type { IdentitySeedVault } from '../../ports'
import type { IdentityVaultUnlockHandle } from '../../types/identity-session'

const STORED_IDENTITY_SEED_TYPE = 'wot.identity.seed'
const STORED_IDENTITY_SEED_VERSION = 1
const STORED_IDENTITY_SEED_FORMAT = 'bip39-64-byte'
const IDENTITY_SEED_BYTE_LENGTH = 64
const INVALID_IDENTITY_SEED_ERROR = 'Identity seed must be exactly 64 bytes.'
const UNSUPPORTED_STORED_IDENTITY_SEED_ERROR =
  'Stored identity uses an unsupported local identity format. Create a new ID to continue.'

interface StoredIdentitySeed {
  type: typeof STORED_IDENTITY_SEED_TYPE
  version: typeof STORED_IDENTITY_SEED_VERSION
  seedFormat: typeof STORED_IDENTITY_SEED_FORMAT
  seed: string
}

export interface IndexedDbIdentitySeedVaultOptions {
  storage?: SeedStorageAdapter
  crypto?: ProtocolCryptoAdapter
}

export class IndexedDbIdentitySeedVault implements IdentitySeedVault {
  private readonly storage: SeedStorageAdapter
  private readonly crypto: ProtocolCryptoAdapter

  constructor(storageOrOptions: SeedStorageAdapter | IndexedDbIdentitySeedVaultOptions = {}) {
    if (storageOrOptions && typeof (storageOrOptions as SeedStorageAdapter).storeSeed === 'function') {
      this.storage = storageOrOptions as SeedStorageAdapter
      this.crypto = new WebCryptoProtocolCryptoAdapter()
    } else {
      const options = storageOrOptions as IndexedDbIdentitySeedVaultOptions
      this.storage = options.storage ?? new SeedStorage()
      this.crypto = options.crypto ?? new WebCryptoProtocolCryptoAdapter()
    }
  }

  async saveSeed(seed: Uint8Array, passphrase: string): Promise<void> {
    if (seed.byteLength !== IDENTITY_SEED_BYTE_LENGTH) throw new Error(INVALID_IDENTITY_SEED_ERROR)
    await this.storage.storeSeed(this.encodeSeed(seed), passphrase)
  }

  async unlockWithPassphrase(passphrase: string): Promise<IdentityVaultUnlockHandle | null> {
    const storedSeed = await this.storage.loadSeed(passphrase)
    if (!storedSeed) return null
    const seed = this.decodeSeed(storedSeed)
    return createIdentityVaultUnlockHandle(seed, this.crypto)
  }

  async unlockWithSession(): Promise<IdentityVaultUnlockHandle | null> {
    const storedSeed = await this.storage.loadSeedWithSessionKey()
    if (!storedSeed) return null
    const seed = this.decodeSeed(storedSeed)
    return createIdentityVaultUnlockHandle(seed, this.crypto)
  }

  deleteSeed(): Promise<void> {
    return this.storage.deleteSeed()
  }

  hasSeed(): Promise<boolean> {
    return this.storage.hasSeed()
  }

  hasActiveSession(): Promise<boolean> {
    return this.storage.hasActiveSession()
  }

  clearSessionKey(): Promise<void> {
    return this.storage.clearSessionKey()
  }

  private encodeSeed(seed: Uint8Array): Uint8Array {
    const storedSeed: StoredIdentitySeed = {
      type: STORED_IDENTITY_SEED_TYPE,
      version: STORED_IDENTITY_SEED_VERSION,
      seedFormat: STORED_IDENTITY_SEED_FORMAT,
      seed: encodeBase64Url(seed),
    }

    return new TextEncoder().encode(JSON.stringify(storedSeed))
  }

  private decodeSeed(storedSeed: Uint8Array): Uint8Array {
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(storedSeed))
    } catch {
      throw new Error(UNSUPPORTED_STORED_IDENTITY_SEED_ERROR)
    }

    if (!isStoredIdentitySeed(parsed)) throw new Error(UNSUPPORTED_STORED_IDENTITY_SEED_ERROR)

    try {
      const seed = decodeBase64Url(parsed.seed)
      if (seed.byteLength !== IDENTITY_SEED_BYTE_LENGTH) throw new Error('Unsupported stored identity seed length')
      return seed
    } catch {
      throw new Error(UNSUPPORTED_STORED_IDENTITY_SEED_ERROR)
    }
  }
}

function isStoredIdentitySeed(value: unknown): value is StoredIdentitySeed {
  if (!value || typeof value !== 'object') return false

  const candidate = value as Record<string, unknown>
  return candidate.type === STORED_IDENTITY_SEED_TYPE
    && candidate.version === STORED_IDENTITY_SEED_VERSION
    && candidate.seedFormat === STORED_IDENTITY_SEED_FORMAT
    && typeof candidate.seed === 'string'
}
