// Automerge Replication
export { AutomergeReplicationAdapter } from './AutomergeReplicationAdapter'
export type { AutomergeReplicationAdapterConfig, CompactStore } from './AutomergeReplicationAdapter'
export { EncryptedMessagingNetworkAdapter } from './EncryptedMessagingNetworkAdapter'
export { PersonalNetworkAdapter } from './PersonalNetworkAdapter'

// Slice A Phase 4 / VE-9: canonical UUID-docId ⇄ native base58 documentId mapping.
export { spaceIdToDocumentId, documentIdToSpaceId, isCanonicalUuidV4 } from './automerge-doc-id'

// Slice A VE-6: Personal-Doc multi-device sync on the Sync 002/003 log path.
export { AutomergePersonalLogSyncAdapter } from './AutomergePersonalLogSyncAdapter'
export type { AutomergePersonalLogSyncConfig } from './AutomergePersonalLogSyncAdapter'

// Personal Document (Automerge-based)
export {
  initPersonalDoc,
  getPersonalDoc,
  isPersonalDocInitialized,
  changePersonalDoc,
  onPersonalDocChange,
  flushPersonalDoc,
  resetPersonalDoc,
  deletePersonalDocDB,
} from './PersonalDocManager'
export type {
  PersonalDoc,
  ProfileDoc,
  ContactDoc,
  AttestationDoc,
  AttestationMetadataDoc,
  OutboxEntryDoc,
  SpaceMetadataDoc,
  GroupKeyDoc,
  DismissedNotificationDoc,
} from './PersonalDocManager'

// Storage
export { SyncOnlyStorageAdapter } from './SyncOnlyStorageAdapter'
export { CompactionService } from './CompactionService'
export type { CompactionRequest, CompactionResponse } from './CompactionService'
export { InMemoryRepoStorageAdapter } from './InMemoryRepoStorageAdapter'
export { AutomergeSpaceMetadataStorage } from './AutomergeSpaceMetadataStorage'
export type { SpaceMetadataDocFunctions } from './AutomergeSpaceMetadataStorage'

// Outbox
export { AutomergeOutboxStore } from './AutomergeOutboxStore'
export type { PersonalDocFunctions } from './AutomergeOutboxStore'
