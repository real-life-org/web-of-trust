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
  PublicVerificationsData,
  PublicAttestationsData,
  ProfileSummary,
} from './ports/DiscoveryAdapter'
export type { ReplicationAdapter, SpaceHandle, TransactOptions } from './ports/ReplicationAdapter'
export type { PublishStateStore, PublishStateField } from './ports/PublishStateStore'
export type { GraphCacheStore, CachedGraphEntry } from './ports/GraphCacheStore'
export type { OutboxStore, OutboxEntry } from './ports/OutboxStore'
export type { AuthorizationAdapter } from './ports/AuthorizationAdapter'

// Crypto Utilities
export {
  encodeBase58,
  decodeBase58,
  encodeBase64Url,
  decodeBase64Url,
  toBuffer,
} from './crypto/encoding'

export {
  createDid,
  didToPublicKeyBytes,
  isValidDid,
  getDefaultDisplayName,
} from './crypto/did'

export {
  signJws,
  verifyJws,
  extractJwsPayload,
} from './crypto/jws'

export * as protocol from './protocol'
export * as protocolAdapters from './protocol-adapters'
export * as application from './application'
export * as ports from './ports'
export { IdentityWorkflow } from './application'
export { VerificationWorkflow } from './application'
export { AttestationWorkflow } from './application'
export { SpacesWorkflow } from './application'
export type { IdentitySession, PublicIdentityMaterial, PublicIdentitySession, IdentitySeedVault } from './application'
export type { SpaceMemberKeyDirectory, SpaceReplicationPort } from './ports'
export { WebCryptoProtocolCryptoAdapter } from './protocol-adapters'

export {
  createCapability,
  verifyCapability,
  delegateCapability,
  extractCapability,
} from './crypto/capabilities'

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
} from './crypto/capabilities'

// Identity
export { WotIdentity } from './identity'

// Services
export { ProfileService } from './services/ProfileService'
export { EncryptedSyncService } from './services/EncryptedSyncService'
export { GroupKeyService } from './services/GroupKeyService'
export { GraphCacheService } from './services/GraphCacheService'
export type { GraphCacheOptions } from './services/GraphCacheService'
export { AttestationDeliveryService } from './services/AttestationDeliveryService'
export type { DeliveryStatus } from './services/AttestationDeliveryService'
export { VaultClient, base64ToUint8 } from './services/VaultClient'
export { VaultPushScheduler } from './services/VaultPushScheduler'
export type { VaultPushSchedulerConfig } from './services/VaultPushScheduler'

// Adapter Implementations (CRDT-agnostic)
export { WebCryptoAdapter } from './adapters/crypto/WebCryptoAdapter'
export { LocalStorageAdapter } from './adapters/storage/LocalStorageAdapter'
export { SeedStorageIdentityVault } from './adapters/storage/SeedStorageIdentityVault'
export { InMemoryMessagingAdapter } from './adapters/messaging/InMemoryMessagingAdapter'
export { WebSocketMessagingAdapter } from './adapters/messaging/WebSocketMessagingAdapter'
export type { SignChallengeFn } from './adapters/messaging/WebSocketMessagingAdapter'
export { CompactStorageManager } from './storage/CompactStorageManager'
export { HttpDiscoveryAdapter } from './adapters/discovery/HttpDiscoveryAdapter'
export { OfflineFirstDiscoveryAdapter } from './adapters/discovery/OfflineFirstDiscoveryAdapter'
export { InMemoryPublishStateStore } from './adapters/discovery/InMemoryPublishStateStore'
export { InMemoryGraphCacheStore } from './adapters/discovery/InMemoryGraphCacheStore'
export { OutboxMessagingAdapter } from './adapters/messaging/OutboxMessagingAdapter'
export { InMemoryOutboxStore } from './adapters/messaging/InMemoryOutboxStore'
export { InMemorySpaceMetadataStorage } from './adapters/storage/InMemorySpaceMetadataStorage'
export { InMemoryCompactStore } from './adapters/storage/InMemoryCompactStore'
export { IndexedDBSpaceMetadataStorage } from './adapters/storage/IndexedDBSpaceMetadataStorage'
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
