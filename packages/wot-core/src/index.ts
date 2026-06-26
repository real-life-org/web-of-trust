// Types
export type {
  Profile,
  Identity,
  KeyPair,
  PublicProfile,
} from './types/identity'

export type {
  Contact,
  ContactStatus,
} from './types/contact'

export type {
  Verification,
  GeoLocation,
  VerificationChallenge,
  VerificationResponse,
} from './types/verification'

export type {
  Attestation,
  AttestationMetadata,
} from './types/attestation'

export type { Proof } from './types/proof'

export type {
  ResourceType,
  ResourceRef,
} from './types/resource-ref'

export {
  createResourceRef,
  parseResourceRef,
} from './types/resource-ref'

export type {
  MessageType,
  MessageEnvelope,
  DeliveryReceipt,
  MessagingState,
} from './types/messaging'

export type {
  SpaceInfo,
  SpaceDocMeta,
  SpaceMemberChange,
  ReplicationState,
} from './types/space'

// Adapter Interfaces
export type { StorageAdapter } from './ports/StorageAdapter'
export type {
  CryptoAdapter,
  EncryptedPayload,
} from './ports/CryptoAdapter'
export type { Subscribable } from './ports/Subscribable'
export { skipFirst } from './ports/Subscribable'
export type { ReactiveStorageAdapter } from './ports/ReactiveStorageAdapter'
export type { MessagingAdapter } from './ports/MessagingAdapter'
export type {
  DiscoveryAdapter,
  ProfileResolveResult,
  PublicAttestationsData,
  PublicVerificationsData,
  ProfileSummary,
} from './ports/DiscoveryAdapter'
export type { ReplicationAdapter, SpaceHandle, TransactOptions } from './ports/ReplicationAdapter'
export type { PublishStateStore, PublishStateField } from './ports/PublishStateStore'
export type { GraphCacheStore, GraphCacheSnapshot, CachedGraphEntry } from './ports/GraphCacheStore'
export type { OutboxStore, OutboxEntry } from './ports/OutboxStore'
export type {
  DocLogStore,
  LocalLogEntry,
  AppendLocalEntryParams,
  RecordRemoteAppliedEntry,
  PendingRemoval,
  StagedRemovalKeyMaterial,
  GapRef,
  GapRepair,
} from './ports/DocLogStore'
// Durable Wiring / N2: orphaned-log repair error (a value/class, not a type).
export { OrphanedLogRepairError } from './ports/DocLogStore'
export type { AuthorizationAdapter } from './application/authorization/AuthorizationAdapter'

// Crypto Utilities
export {
  encodeBase58,
  decodeBase58,
  encodeBase64Url,
  decodeBase64Url,
  toBuffer,
} from './protocol/crypto/encoding'

export { getDefaultDisplayName } from './application/identity'

export * as protocol from './protocol'
export * as protocolAdapters from './adapters/protocol-crypto'
export * as application from './application'
export * as ports from './ports'
export { IdentityWorkflow } from './application'
export { VerificationWorkflow } from './application'
export { AttestationWorkflow } from './application'
export { SpacesWorkflow } from './application'
export type { IdentitySession, PublicIdentityMaterial, PublicIdentitySession, IdentitySeedVault } from './application'
export type { SpaceMemberKeyDirectory, SpaceReplicationPort } from './ports'
export { WebCryptoProtocolCryptoAdapter } from './adapters/protocol-crypto'

export {
  createCapability,
  verifyCapability,
  delegateCapability,
  extractCapability,
} from './application/authorization'

export {
  signEnvelope,
  verifyEnvelope,
} from './crypto/envelope-auth'

export type {
  Capability,
  CapabilityJws,
  Permission,
  SignFn,
  VerifiedCapability,
  CapabilityError,
  CapabilityVerificationResult,
} from './application/authorization'

// Services
export { GraphCacheService } from './adapters/discovery/GraphCacheService'
export type { GraphCacheOptions } from './adapters/discovery/GraphCacheService'
export { VaultClient, base64ToUint8 } from './adapters/vault/VaultClient'
export { VaultPushScheduler } from './adapters/vault/VaultPushScheduler'
export type { VaultPushSchedulerConfig } from './adapters/vault/VaultPushScheduler'

// Adapter Implementations (CRDT-agnostic)
export { WebCryptoAdapter } from './adapters/crypto/WebCryptoAdapter'
export { InMemoryMessagingAdapter } from './adapters/messaging/InMemoryMessagingAdapter'
// Slice A (Phase 4): engine-neutral restore/clone mechanism for the log path.
export { createRestoreCloneHandler } from './adapters/messaging/logRestoreClone'
export type { RestoreCloneControllerConfig } from './adapters/messaging/logRestoreClone'
export { CompactStorageManager } from './storage/CompactStorageManager'
export { OfflineFirstDiscoveryAdapter } from './adapters/discovery/OfflineFirstDiscoveryAdapter'
export { InMemoryPublishStateStore } from './adapters/discovery/InMemoryPublishStateStore'
export { InMemoryGraphCacheStore } from './adapters/discovery/InMemoryGraphCacheStore'
export { OutboxMessagingAdapter } from './adapters/messaging/OutboxMessagingAdapter'
export { InMemoryOutboxStore } from './adapters/messaging/InMemoryOutboxStore'
export { InMemorySpaceMetadataStorage } from './adapters/storage/InMemorySpaceMetadataStorage'
export { InMemoryCompactStore } from './adapters/storage/InMemoryCompactStore'
export { InMemoryDocLogStore } from './adapters/storage/InMemoryDocLogStore'
export {
  WebLocksSeqLock,
  InProcessSeqLock,
  createSeqLock,
  hasWebLocks,
} from './adapters/storage/SeqLock'
export type { SeqLock } from './adapters/storage/SeqLock'
export type { SpaceMetadataStorage, PersistedSpaceMetadata, PersistedGroupKey } from './ports/SpaceMetadataStorage'
export { InMemoryAuthorizationAdapter } from './adapters/authorization/InMemoryAuthorizationAdapter'
export { PersonalDocOutboxStore } from './adapters/messaging/AutomergeOutboxStore'
export { PersonalDocOutboxStore as AutomergeOutboxStore } from './adapters/messaging/AutomergeOutboxStore'
export type { PersonalDocFunctions } from './adapters/messaging/AutomergeOutboxStore'
export { PersonalDocSpaceMetadataStorage } from './adapters/storage/AutomergeSpaceMetadataStorage'
export { PersonalDocSpaceMetadataStorage as AutomergeSpaceMetadataStorage } from './adapters/storage/AutomergeSpaceMetadataStorage'
export type { SpaceMetadataDocFunctions } from './adapters/storage/AutomergeSpaceMetadataStorage'

// Persistence Metrics (CRDT-agnostic)
export { PersistenceMetrics, getMetrics, registerDebugApi } from './storage/PersistenceMetrics'
export type { DebugSnapshot, SpaceMetric, ImplTag, LoadSource, SaveTarget } from './storage/PersistenceMetrics'

// Trace Log (CRDT-agnostic)
export { TraceLog, getTraceLog, traceAsync, tracedFetch, registerTraceApi } from './storage/TraceLog'
export type { TraceEntry, TraceStore, TraceOp, TraceFilter } from './storage/TraceLog'

// Traced Wrappers (Debug Dashboard)
export { TracedCompactStorageManager } from './storage/TracedCompactStorageManager'
export { TracedOutboxMessagingAdapter } from './adapters/messaging/TracedOutboxMessagingAdapter'

// Yjs-specific exports have moved to @web_of_trust/adapter-yjs
// import { initYjsPersonalDoc, YjsReplicationAdapter, ... } from '@web_of_trust/adapter-yjs'

// Automerge-specific exports have moved to @web_of_trust/adapter-automerge
// import { AutomergeReplicationAdapter, initPersonalDoc, ... } from '@web_of_trust/adapter-automerge'
