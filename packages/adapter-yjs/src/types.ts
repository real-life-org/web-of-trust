/**
 * Document types for the Yjs Personal Document.
 *
 * These types define the shape of data stored in the Y.Doc.
 * They are identical to the types in adapter-automerge's PersonalDocManager
 * because both adapters manage the same personal document schema.
 */

export interface OutboxEntryDoc {
  envelopeJson: string
  createdAt: string
  retryCount: number
}

export interface SpaceMetadataDoc {
  info: {
    id: string
    type: string
    name: string | null
    description: string | null
    appTag?: string
    members: string[]
    createdAt: string
  }
  documentId: string
  documentUrl: string
  /** memberEncryptionKeys stored as Record<did, number[]> for serialization */
  memberEncryptionKeys: Record<string, number[]>
}

export interface GroupKeyDoc {
  spaceId: string
  generation: number
  key: number[]
}

/**
 * Capability signing seed per (space, generation). Separate grow-only map from
 * groupKeys so a recovered second device gets WRITE material, not just read. #234.
 */
export interface CapabilitySigningSeedDoc {
  spaceId: string
  generation: number
  seed: number[]
}

export interface ContactDoc {
  did: string
  publicKey: string
  name: string | null
  avatar: string | null
  bio: string | null
  status: string  // 'pending' | 'active'
  verifiedAt: string | null
  /** Optional: Dokumente vor wot#386 haben das Feld nicht. */
  profileUpdatedAt?: string | null
  /** Optional: Dokumente vor wot#386 haben die Felder nicht. */
  offers?: string[] | null
  needs?: string[] | null
  createdAt: string
  updatedAt: string
}

export interface AttestationDoc {
  id: string
  attestationId: string | null
  fromDid: string
  toDid: string
  claim: string
  tagsJson: string | null
  context: string | null
  createdAt: string
  vcJws: string
}

export interface AttestationMetadataDoc {
  attestationId: string
  accepted: boolean
  acceptedAt: string | null
  deliveryStatus: string | null
}

/**
 * Synced resolution marker for a notification dialog (generic dialog
 * lifecycle). Key in the map = notificationId (per-event stable ID).
 * `resolvedAt` carries the TTL-based GC — the retention window MUST stay
 * larger than the inbox replay/retention window (30d), else a retained-inbox
 * redelivery after GC re-shows a resolved dialog.
 */
export interface DismissedNotificationDoc {
  resolvedAt: string
}

export interface ProfileDoc {
  did: string
  name: string | null
  bio: string | null
  avatar: string | null
  offersJson: string | null
  needsJson: string | null
  createdAt: string
  updatedAt: string
}

/** Per-device notification markers. Interpretation belongs to the connector. */
export interface NotificationStateDoc {
  lastSeenByDevice?: Record<string, string>
  readUpToByDevice?: Record<string, string>
  readEntryKeys?: Record<string, string>
  mutedGroupIds?: Record<string, true>
}

/** Confirmed personal inbox record for a canonical removal. */
export interface MembershipRemovalDoc {
  eventId: string
  spaceId: string
  removedDid: string
  generation: number
  ts: string
  byDid: string
}

export interface PersonalDoc {
  profile: ProfileDoc | null
  contacts: Record<string, ContactDoc>
  attestations: Record<string, AttestationDoc>
  attestationMetadata: Record<string, AttestationMetadataDoc>
  outbox: Record<string, OutboxEntryDoc>
  spaces: Record<string, SpaceMetadataDoc>
  groupKeys: Record<string, GroupKeyDoc>
  capabilitySigningSeeds: Record<string, CapabilitySigningSeedDoc>
  dismissedNotifications: Record<string, DismissedNotificationDoc>
  notificationState?: NotificationStateDoc
  membershipRemovals?: Record<string, MembershipRemovalDoc>
}
