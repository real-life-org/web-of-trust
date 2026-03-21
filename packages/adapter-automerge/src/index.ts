// Automerge Replication
export { AutomergeReplicationAdapter } from './AutomergeReplicationAdapter'
export type { AutomergeReplicationAdapterConfig, CompactStore } from './AutomergeReplicationAdapter'
export { EncryptedMessagingNetworkAdapter } from './EncryptedMessagingNetworkAdapter'
export { PersonalNetworkAdapter } from './PersonalNetworkAdapter'

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
  VerificationDoc,
  AttestationDoc,
  AttestationMetadataDoc,
  OutboxEntryDoc,
  PublishStateDoc,
  CachedGraphEntryDoc,
  CachedGraphVerificationDoc,
  CachedGraphAttestationDoc,
  SpaceMetadataDoc,
  GroupKeyDoc,
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
