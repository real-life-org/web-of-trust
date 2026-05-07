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

export interface ContactDoc {
  did: string
  publicKey: string
  name: string | null
  avatar: string | null
  bio: string | null
  status: string  // 'pending' | 'active'
  verifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface VerificationDoc {
  id: string
  fromDid: string
  toDid: string
  timestamp: string
  proofJson: string
  locationJson: string | null
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

export interface PersonalDoc {
  profile: ProfileDoc | null
  contacts: Record<string, ContactDoc>
  verifications: Record<string, VerificationDoc>
  attestations: Record<string, AttestationDoc>
  attestationMetadata: Record<string, AttestationMetadataDoc>
  outbox: Record<string, OutboxEntryDoc>
  spaces: Record<string, SpaceMetadataDoc>
  groupKeys: Record<string, GroupKeyDoc>
}
