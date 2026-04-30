import { SeedStorage } from '../../identity/SeedStorage'
import { decodeBase64Url, encodeBase64Url } from '../../protocol'
import type { SeedStorageAdapter } from '../interfaces/SeedStorageAdapter'
import type { IdentitySeedVault } from '../../ports'

const STORED_IDENTITY_SEED_TYPE = 'wot.identity.seed'
const STORED_IDENTITY_SEED_VERSION = 1
const STORED_IDENTITY_SEED_FORMAT = 'bip39-64-byte'
const UNSUPPORTED_STORED_IDENTITY_SEED_ERROR =
  'Stored identity uses an unsupported legacy seed format. Create a new ID to continue.'

interface StoredIdentitySeed {
  type: typeof STORED_IDENTITY_SEED_TYPE
  version: typeof STORED_IDENTITY_SEED_VERSION
  seedFormat: typeof STORED_IDENTITY_SEED_FORMAT
  seed: string
}

export class SeedStorageIdentityVault implements IdentitySeedVault {
  constructor(private readonly storage: SeedStorageAdapter = new SeedStorage()) {}

  saveSeed(seed: Uint8Array, passphrase: string): Promise<void> {
    return this.storage.storeSeed(this.encodeSeed(seed), passphrase)
  }

  async loadSeed(passphrase: string): Promise<Uint8Array | null> {
    const storedSeed = await this.storage.loadSeed(passphrase)
    if (!storedSeed) return null
    return this.decodeSeed(storedSeed)
  }

  async loadSeedWithSessionKey(): Promise<Uint8Array | null> {
    const storedSeed = await this.storage.loadSeedWithSessionKey()
    if (!storedSeed) return null
    return this.decodeSeed(storedSeed)
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
      return decodeBase64Url(parsed.seed)
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
