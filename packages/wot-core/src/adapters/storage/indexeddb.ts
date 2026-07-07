export { IndexedDbIdentitySeedVault, closeOpenIdentitySeedVaultConnections } from './IndexedDbIdentitySeedVault'
export type { IndexedDbIdentitySeedVaultOptions } from './IndexedDbIdentitySeedVault'
export { IndexedDBSpaceMetadataStorage } from './IndexedDBSpaceMetadataStorage'
export { IndexedDBDocLogStore } from './IndexedDBDocLogStore'
// Durable Wiring / D1 + K1: durable mirrors of the InMemory ref-impl stores.
export { IndexedDBKeyManagementAdapter } from '../key-management/IndexedDBKeyManagementAdapter'
export { IndexedDBMemberUpdatePendingStore } from '../member-update/IndexedDBMemberUpdatePendingStore'
export {
  IndexedDBMessageIdHistory,
  type IndexedDBMessageIdHistoryOptions,
} from '../message-id-history/IndexedDBMessageIdHistory'
