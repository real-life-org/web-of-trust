// Seed vault (architecture §5.2): format, the SeedVaultPort over a transactional backend, and the
// IndexedDB and in-memory backends. Web and Capacitor use IndexedDB; tests and the harness use memory.
export { createSeedVault, type VaultBackend, type VaultTx, type VaultStore, type SeedVaultOptions } from './vault'
export { idbVaultBackend, closeVaultConnections, VAULT_DB_NAME } from './idb'
export { memoryVaultBackend, type MemoryVaultBackend } from './memory'
export {
  b64url,
  fromB64url,
  jcs,
  classify,
  seal,
  open,
  TARGET_ITERATIONS,
  VAULT_FORMAT,
  VAULT_VERSION,
  type VaultRecord,
  type VaultPayload,
} from './format'
