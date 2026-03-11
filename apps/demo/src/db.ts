/**
 * Evolu Database Setup
 *
 * Defines the Evolu schema and creates the Evolu instance.
 * Uses WotIdentity's deriveFrameworkKey for custom key integration.
 */
import {
  id,
  createEvolu,
  createAppOwner,
  NonEmptyString,
  NonEmptyString1000,
  nullOr,
  SqliteBoolean,
  SimpleName,
  OwnerSecret,
  type Evolu,
} from '@evolu/common'
import { evoluReactWebDeps } from '@evolu/react-web'
import type { WotIdentity } from '@real-life/wot-core'

// --- Branded ID Types ---

const ContactId = id('Contact')
type ContactId = typeof ContactId.Type

const VerificationId = id('Verification')
type VerificationId = typeof VerificationId.Type

const AttestationId = id('Attestation')
type AttestationId = typeof AttestationId.Type

const AttestationMetadataId = id('AttestationMetadata')
type AttestationMetadataId = typeof AttestationMetadataId.Type

const ProfileId = id('Profile')
type ProfileId = typeof ProfileId.Type

const DiscoverySyncStateId = id('DiscoverySyncState')
type DiscoverySyncStateId = typeof DiscoverySyncStateId.Type

const CachedProfileId = id('CachedProfile')
type CachedProfileId = typeof CachedProfileId.Type

const CachedGraphEntryId = id('CachedGraphEntry')
type CachedGraphEntryId = typeof CachedGraphEntryId.Type

const CachedGraphVerificationId = id('CachedGraphVerification')
type CachedGraphVerificationId = typeof CachedGraphVerificationId.Type

const CachedGraphAttestationId = id('CachedGraphAttestation')
type CachedGraphAttestationId = typeof CachedGraphAttestationId.Type

const OutboxId = id('Outbox')
type OutboxId = typeof OutboxId.Type

// --- Schema ---

const Schema = {
  profile: {
    id: ProfileId,
    did: NonEmptyString1000,
    name: nullOr(NonEmptyString1000),
    bio: nullOr(NonEmptyString1000),
    avatar: nullOr(NonEmptyString), // Data URLs can be large, use unbounded string
    offersJson: nullOr(NonEmptyString1000), // JSON-serialized string[]
    needsJson: nullOr(NonEmptyString1000),  // JSON-serialized string[]
  },
  contact: {
    id: ContactId,
    did: NonEmptyString1000,
    publicKey: NonEmptyString1000,
    name: nullOr(NonEmptyString1000),
    avatar: nullOr(NonEmptyString), // Data URLs can be large
    bio: nullOr(NonEmptyString1000),
    status: NonEmptyString1000, // 'pending' | 'active'
    verifiedAt: nullOr(NonEmptyString1000),
  },
  verification: {
    id: VerificationId,
    fromDid: NonEmptyString1000,
    toDid: NonEmptyString1000,
    timestamp: NonEmptyString1000,
    proofJson: NonEmptyString1000, // JSON-serialized Proof
    locationJson: nullOr(NonEmptyString1000), // JSON-serialized GeoLocation
  },
  attestation: {
    id: AttestationId,
    attestationId: nullOr(NonEmptyString1000), // Original attestation ID (urn:uuid:...)
    fromDid: NonEmptyString1000,
    toDid: NonEmptyString1000,
    claim: NonEmptyString1000,
    tagsJson: nullOr(NonEmptyString1000), // JSON-serialized string[]
    context: nullOr(NonEmptyString1000),
    // Note: createdAt is an Evolu system column (auto-added, auto-set on insert)
    proofJson: NonEmptyString1000, // JSON-serialized Proof
  },
  attestationMetadata: {
    id: AttestationMetadataId,
    attestationId: NonEmptyString1000,
    accepted: SqliteBoolean,
    acceptedAt: nullOr(NonEmptyString1000),
    deliveryStatus: nullOr(NonEmptyString1000), // 'sending' | 'queued' | 'delivered' | 'acknowledged' | 'failed'
  },
  discoverySyncState: {
    id: DiscoverySyncStateId,
    did: NonEmptyString1000,
    profileDirty: SqliteBoolean,
    verificationsDirty: SqliteBoolean,
    attestationsDirty: SqliteBoolean,
  },
  cachedProfile: {
    id: CachedProfileId,
    did: NonEmptyString1000,
    name: nullOr(NonEmptyString1000),
    bio: nullOr(NonEmptyString1000),
    avatar: nullOr(NonEmptyString),
    fetchedAt: NonEmptyString1000,
  },
  cachedGraphEntry: {
    id: CachedGraphEntryId,
    did: NonEmptyString1000,
    name: nullOr(NonEmptyString1000),
    bio: nullOr(NonEmptyString1000),
    avatar: nullOr(NonEmptyString),
    encryptionPublicKey: nullOr(NonEmptyString1000), // Base64URL X25519 public key
    verificationCount: NonEmptyString1000, // string-encoded integer
    attestationCount: NonEmptyString1000,  // string-encoded integer
    verifierDidsJson: nullOr(NonEmptyString), // JSON string[]
    fetchedAt: NonEmptyString1000,
  },
  cachedGraphVerification: {
    id: CachedGraphVerificationId,
    subjectDid: NonEmptyString1000, // whose profile this belongs to
    verificationId: NonEmptyString1000,
    fromDid: NonEmptyString1000,
    toDid: NonEmptyString1000,
    timestamp: NonEmptyString1000,
    proofJson: NonEmptyString1000,
    locationJson: nullOr(NonEmptyString1000),
  },
  cachedGraphAttestation: {
    id: CachedGraphAttestationId,
    subjectDid: NonEmptyString1000, // whose profile this belongs to
    attestationId: NonEmptyString1000,
    fromDid: NonEmptyString1000,
    toDid: NonEmptyString1000,
    claim: NonEmptyString1000,
    tagsJson: nullOr(NonEmptyString1000),
    context: nullOr(NonEmptyString1000),
    attestationCreatedAt: NonEmptyString1000,
    proofJson: NonEmptyString1000,
  },
  outbox: {
    id: OutboxId,
    envelopeId: NonEmptyString1000,
    envelopeJson: NonEmptyString, // Full serialized MessageEnvelope
    retryCount: NonEmptyString1000, // String-encoded integer
  },
} as const

type AppSchema = typeof Schema

// --- Evolu Instance Management ---

let evoluInstance: Evolu<AppSchema> | null = null

/**
 * Create Evolu instance with WotIdentity-derived keys.
 *
 * Uses deriveFrameworkKey('evolu-storage-v1') to generate a deterministic
 * OwnerSecret from the user's master seed. Same seed = same Evolu owner.
 */
export async function createWotEvolu(identity: WotIdentity): Promise<Evolu<AppSchema>> {
  // Derive 32 bytes from master seed for Evolu
  const frameworkKey = await identity.deriveFrameworkKey('evolu-storage-v1')

  // Cast to OwnerSecret (branded Uint8Array<32>)
  const ownerSecret = frameworkKey as unknown as OwnerSecret
  const appOwner = createAppOwner(ownerSecret)

  const evolu = createEvolu(evoluReactWebDeps)(Schema, {
    name: SimpleName.orThrow('wot'),
    externalAppOwner: appOwner,
    transports: [{ type: 'WebSocket', url: 'wss://evolu.utopia-lab.org' }],
  })

  evolu.subscribeError(() => {
    const error = evolu.getError()
    console.error('[wot-evolu] Sync error:', error)
  })

  evoluInstance = evolu
  return evolu
}

/**
 * Get the current Evolu instance. Throws if not initialized.
 */
export function getEvolu(): Evolu<AppSchema> {
  if (!evoluInstance) {
    throw new Error('Evolu not initialized. Call createWotEvolu first.')
  }
  return evoluInstance
}

/**
 * Check if Evolu is initialized.
 */
export function isEvoluInitialized(): boolean {
  return evoluInstance !== null
}

/**
 * Reset Evolu: delete all local data and clear the singleton.
 * Uses Evolu's own resetAppOwner which properly cleans up OPFS + IndexedDB.
 */
export async function resetEvolu(): Promise<void> {
  if (evoluInstance) {
    await evoluInstance.resetAppOwner({ reload: false })
    evoluInstance = null
  }
  localStorage.removeItem('wot-evolu-owner-id')
}

export { Schema, type AppSchema, type ProfileId, type ContactId, type VerificationId, type AttestationId, type AttestationMetadataId, type DiscoverySyncStateId, type CachedProfileId, type CachedGraphEntryId, type CachedGraphVerificationId, type CachedGraphAttestationId, type OutboxId }
