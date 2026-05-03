/**
 * Seed storage adapter interface for persisting encrypted master seeds.
 *
 * Framework-agnostic: Can be implemented with IndexedDB (browser),
 * Keychain (iOS), Keystore (Android), or any other secure storage.
 */
export interface SeedStorageAdapter {
  /** Store encrypted seed */
  storeSeed(seed: Uint8Array, passphrase: string): Promise<void>

  /** Load and decrypt seed using passphrase. Caches session key on success. */
  loadSeed(passphrase: string): Promise<Uint8Array | null>

  /** Load and decrypt seed using cached session key (no passphrase needed). */
  loadSeedWithSessionKey(): Promise<Uint8Array | null>

  /** Check if a valid (non-expired) session key exists */
  hasActiveSession(): Promise<boolean>

  /** Check if seed exists in storage */
  hasSeed(): Promise<boolean>

  /** Delete stored seed and session key */
  deleteSeed(): Promise<void>

  /** Clear the cached session key */
  clearSessionKey(): Promise<void>
}
