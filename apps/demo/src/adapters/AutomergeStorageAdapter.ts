/**
 * AutomergeStorageAdapter - StorageAdapter + ReactiveStorageAdapter backed by Personal Automerge Doc
 *
 * Replaces EvoluStorageAdapter. All data lives in a single Automerge document
 * managed by personalDocManager.
 */
import type {
  StorageAdapter,
  ReactiveStorageAdapter,
  Subscribable,
  Identity,
  Profile,
  Contact,
  Verification,
  Attestation,
  AttestationMetadata,
} from '@real-life/wot-core'
import {
  getPersonalDoc,
  changePersonalDoc,
  onPersonalDocChange,
} from '@real-life/adapter-automerge'
import type {
  PersonalDoc,
  ContactDoc,
  VerificationDoc,
  AttestationDoc,
} from '../personalDocManager'

// --- Helper: convert between doc format and domain types ---

function contactFromDoc(doc: ContactDoc): Contact {
  return {
    did: doc.did,
    publicKey: doc.publicKey,
    ...(doc.name != null ? { name: doc.name } : {}),
    ...(doc.avatar != null ? { avatar: doc.avatar } : {}),
    ...(doc.bio != null ? { bio: doc.bio } : {}),
    status: doc.status as Contact['status'],
    ...(doc.verifiedAt != null ? { verifiedAt: doc.verifiedAt } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

function verificationFromDoc(doc: VerificationDoc): Verification {
  return {
    id: doc.id,
    from: doc.fromDid,
    to: doc.toDid,
    timestamp: doc.timestamp,
    proof: JSON.parse(doc.proofJson),
    ...(doc.locationJson != null ? { location: JSON.parse(doc.locationJson) } : {}),
  }
}

function attestationFromDoc(doc: AttestationDoc): Attestation {
  return {
    id: doc.attestationId ?? doc.id,
    from: doc.fromDid,
    to: doc.toDid,
    claim: doc.claim,
    ...(doc.tagsJson != null ? { tags: JSON.parse(doc.tagsJson) } : {}),
    ...(doc.context != null ? { context: doc.context } : {}),
    createdAt: doc.createdAt,
    proof: JSON.parse(doc.proofJson),
  }
}

export class AutomergeStorageAdapter implements StorageAdapter, ReactiveStorageAdapter {
  private cachedIdentity: Identity | null = null

  constructor(private did: string) {}

  // --- Identity ---

  async createIdentity(did: string, profile: Profile): Promise<Identity> {
    const now = new Date().toISOString()
    const identity: Identity = { did, profile, createdAt: now, updatedAt: now }

    changePersonalDoc(doc => {
      doc.profile = {
        did,
        name: profile.name || null,
        bio: profile.bio || null,
        avatar: profile.avatar || null,
        offersJson: profile.offers?.length ? JSON.stringify(profile.offers) : null,
        needsJson: profile.needs?.length ? JSON.stringify(profile.needs) : null,
        createdAt: now,
        updatedAt: now,
      }
    })

    this.cachedIdentity = identity
    return identity
  }

  async getIdentity(): Promise<Identity | null> {
    if (this.cachedIdentity) return this.cachedIdentity

    const doc = getPersonalDoc()
    if (!doc.profile) return null

    const profile = this.profileFromDoc(doc)
    const identity: Identity = {
      did: this.did,
      profile,
      createdAt: doc.profile.createdAt ?? '',
      updatedAt: doc.profile.updatedAt ?? '',
    }
    this.cachedIdentity = identity
    return identity
  }

  async updateIdentity(identity: Identity): Promise<void> {
    identity.updatedAt = new Date().toISOString()

    changePersonalDoc(doc => {
      doc.profile = {
        did: identity.did,
        name: identity.profile.name || null,
        bio: identity.profile.bio || null,
        avatar: identity.profile.avatar || null,
        offersJson: identity.profile.offers?.length ? JSON.stringify(identity.profile.offers) : null,
        needsJson: identity.profile.needs?.length ? JSON.stringify(identity.profile.needs) : null,
        createdAt: doc.profile?.createdAt ?? identity.createdAt,
        updatedAt: identity.updatedAt,
      }
    })

    this.cachedIdentity = identity
  }

  private profileFromDoc(doc: PersonalDoc): Profile {
    if (!doc.profile) return { name: '' }
    return {
      name: doc.profile.name ?? '',
      ...(doc.profile.bio != null ? { bio: doc.profile.bio } : {}),
      ...(doc.profile.avatar != null ? { avatar: doc.profile.avatar } : {}),
      ...(doc.profile.offersJson != null ? { offers: JSON.parse(doc.profile.offersJson) } : {}),
      ...(doc.profile.needsJson != null ? { needs: JSON.parse(doc.profile.needsJson) } : {}),
    }
  }

  // --- Contacts ---

  async addContact(contact: Contact): Promise<void> {
    changePersonalDoc(doc => {
      doc.contacts[contact.did] = {
        did: contact.did,
        publicKey: contact.publicKey,
        name: contact.name || null,
        avatar: contact.avatar || null,
        bio: contact.bio || null,
        status: contact.status,
        verifiedAt: contact.verifiedAt || null,
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt,
      }
    })
  }

  async getContacts(): Promise<Contact[]> {
    const doc = getPersonalDoc()
    return Object.values(doc.contacts).map(contactFromDoc)
  }

  async getContact(did: string): Promise<Contact | null> {
    const doc = getPersonalDoc()
    const c = doc.contacts[did]
    return c ? contactFromDoc(c) : null
  }

  async updateContact(contact: Contact): Promise<void> {
    // Background: usually called from profile sync, not explicit user action
    changePersonalDoc(doc => {
      doc.contacts[contact.did] = {
        did: contact.did,
        publicKey: contact.publicKey,
        name: contact.name || null,
        avatar: contact.avatar || null,
        bio: contact.bio || null,
        status: contact.status,
        verifiedAt: contact.verifiedAt || null,
        createdAt: doc.contacts[contact.did]?.createdAt ?? contact.createdAt,
        updatedAt: contact.updatedAt,
      }
    }, { background: true })
  }

  async removeContact(did: string): Promise<void> {
    changePersonalDoc(doc => {
      delete doc.contacts[did]
    })
  }

  // --- Verifications ---

  async saveVerification(verification: Verification): Promise<void> {
    changePersonalDoc(doc => {
      // Remove existing verification from same from→to pair (renewal)
      for (const [key, v] of Object.entries(doc.verifications)) {
        if (v.fromDid === verification.from && v.toDid === verification.to && key !== verification.id) {
          delete doc.verifications[key]
        }
      }

      doc.verifications[verification.id] = {
        id: verification.id,
        fromDid: verification.from,
        toDid: verification.to,
        timestamp: verification.timestamp,
        proofJson: JSON.stringify(verification.proof),
        locationJson: verification.location ? JSON.stringify(verification.location) : null,
      }
    })
  }

  async getReceivedVerifications(): Promise<Verification[]> {
    const doc = getPersonalDoc()
    return Object.values(doc.verifications)
      .filter(v => v.toDid === this.did)
      .map(verificationFromDoc)
  }

  async getAllVerifications(): Promise<Verification[]> {
    const doc = getPersonalDoc()
    return Object.values(doc.verifications)
      .filter(v => v.fromDid === this.did || v.toDid === this.did)
      .map(verificationFromDoc)
  }

  async getVerification(id: string): Promise<Verification | null> {
    const doc = getPersonalDoc()
    const v = doc.verifications[id]
    return v ? verificationFromDoc(v) : null
  }

  // --- Attestations ---

  async saveAttestation(attestation: Attestation): Promise<void> {
    changePersonalDoc(doc => {
      doc.attestations[attestation.id] = {
        id: attestation.id,
        attestationId: attestation.id,
        fromDid: attestation.from,
        toDid: attestation.to,
        claim: attestation.claim,
        tagsJson: attestation.tags ? JSON.stringify(attestation.tags) : null,
        context: attestation.context || null,
        createdAt: attestation.createdAt,
        proofJson: JSON.stringify(attestation.proof),
      }

      // Create metadata if it doesn't exist
      if (!doc.attestationMetadata[attestation.id]) {
        doc.attestationMetadata[attestation.id] = {
          attestationId: attestation.id,
          accepted: false,
          acceptedAt: null,
          deliveryStatus: null,
        }
      }
    })
  }

  async getReceivedAttestations(): Promise<Attestation[]> {
    const doc = getPersonalDoc()
    return Object.values(doc.attestations)
      .filter(a => a.toDid === this.did)
      .map(attestationFromDoc)
  }

  async getAttestation(id: string): Promise<Attestation | null> {
    const doc = getPersonalDoc()
    const a = doc.attestations[id]
    return a ? attestationFromDoc(a) : null
  }

  // --- Attestation Metadata ---

  async getAttestationMetadata(attestationId: string): Promise<AttestationMetadata | null> {
    const doc = getPersonalDoc()
    const m = doc.attestationMetadata[attestationId]
    if (!m) return null
    return {
      attestationId: m.attestationId,
      accepted: m.accepted,
      ...(m.acceptedAt != null ? { acceptedAt: m.acceptedAt } : {}),
    }
  }

  async setAttestationAccepted(attestationId: string, accepted: boolean): Promise<void> {
    changePersonalDoc(doc => {
      if (!doc.attestationMetadata[attestationId]) {
        doc.attestationMetadata[attestationId] = {
          attestationId,
          accepted,
          acceptedAt: accepted ? new Date().toISOString() : null,
          deliveryStatus: null,
        }
      } else {
        doc.attestationMetadata[attestationId].accepted = accepted
        doc.attestationMetadata[attestationId].acceptedAt = accepted ? new Date().toISOString() : null
      }
    })
  }

  async setDeliveryStatus(attestationId: string, status: string): Promise<void> {
    changePersonalDoc(doc => {
      if (!doc.attestationMetadata[attestationId]) {
        doc.attestationMetadata[attestationId] = {
          attestationId,
          accepted: false,
          acceptedAt: null,
          deliveryStatus: status,
        }
      } else {
        doc.attestationMetadata[attestationId].deliveryStatus = status
      }
    }, { background: true })
  }

  async getAllDeliveryStatuses(): Promise<Map<string, string>> {
    const doc = getPersonalDoc()
    const map = new Map<string, string>()
    for (const m of Object.values(doc.attestationMetadata)) {
      if (m.deliveryStatus) {
        map.set(m.attestationId, m.deliveryStatus)
      }
    }
    return map
  }

  // --- Lifecycle ---

  async init(): Promise<void> {}

  async clear(): Promise<void> {
    this.cachedIdentity = null
  }

  // --- Reactive (ReactiveStorageAdapter) ---

  watchIdentity(): Subscribable<Identity | null> {
    const did = this.did
    const self = this

    const getSnapshot = (): Identity | null => {
      const doc = getPersonalDoc()
      if (!doc.profile) return null
      const profile = self.profileFromDoc(doc)
      const cached = self.cachedIdentity
      return {
        did,
        profile,
        createdAt: cached?.createdAt ?? doc.profile.createdAt ?? '',
        updatedAt: cached?.updatedAt ?? doc.profile.updatedAt ?? '',
      }
    }

    let snapshot = getSnapshot()
    let snapshotKey = JSON.stringify(snapshot?.profile)

    return {
      subscribe: (callback) => {
        return onPersonalDocChange(() => {
          const next = getSnapshot()
          const nextKey = JSON.stringify(next?.profile)
          if (nextKey !== snapshotKey) {
            snapshot = next
            snapshotKey = nextKey
            if (snapshot) self.cachedIdentity = snapshot
            callback(snapshot)
          }
        })
      },
      getValue: () => snapshot,
    }
  }

  watchContacts(): Subscribable<Contact[]> {
    const getSnapshot = (): Contact[] => {
      const doc = getPersonalDoc()
      return Object.values(doc.contacts).map(contactFromDoc)
    }

    let snapshot = getSnapshot()
    let snapshotKey = JSON.stringify(snapshot)

    return {
      subscribe: (callback) => {
        return onPersonalDocChange(() => {
          const next = getSnapshot()
          const nextKey = JSON.stringify(next)
          if (nextKey !== snapshotKey) {
            snapshot = next
            snapshotKey = nextKey
            callback(snapshot)
          }
        })
      },
      getValue: () => snapshot,
    }
  }

  watchAllVerifications(): Subscribable<Verification[]> {
    const myDid = this.did

    const getSnapshot = (): Verification[] => {
      const doc = getPersonalDoc()
      return Object.values(doc.verifications)
        .filter(v => v.fromDid === myDid || v.toDid === myDid)
        .map(verificationFromDoc)
    }

    let snapshot = getSnapshot()
    let snapshotKey = JSON.stringify(snapshot)

    return {
      subscribe: (callback) => {
        return onPersonalDocChange(() => {
          const next = getSnapshot()
          const nextKey = JSON.stringify(next)
          if (nextKey !== snapshotKey) {
            snapshot = next
            snapshotKey = nextKey
            callback(snapshot)
          }
        })
      },
      getValue: () => snapshot,
    }
  }

  watchReceivedVerifications(): Subscribable<Verification[]> {
    const myDid = this.did

    const getSnapshot = (): Verification[] => {
      const doc = getPersonalDoc()
      return Object.values(doc.verifications)
        .filter(v => v.toDid === myDid)
        .map(verificationFromDoc)
    }

    let snapshot = getSnapshot()
    let snapshotKey = JSON.stringify(snapshot)

    return {
      subscribe: (callback) => {
        return onPersonalDocChange(() => {
          const next = getSnapshot()
          const nextKey = JSON.stringify(next)
          if (nextKey !== snapshotKey) {
            snapshot = next
            snapshotKey = nextKey
            callback(snapshot)
          }
        })
      },
      getValue: () => snapshot,
    }
  }

  watchAllAttestations(): Subscribable<Attestation[]> {
    const myDid = this.did

    const getSnapshot = (): Attestation[] => {
      const doc = getPersonalDoc()
      return Object.values(doc.attestations)
        .filter(a => a.fromDid === myDid || a.toDid === myDid)
        .map(attestationFromDoc)
    }

    let snapshot = getSnapshot()
    let snapshotKey = JSON.stringify(snapshot)

    return {
      subscribe: (callback) => {
        return onPersonalDocChange(() => {
          const next = getSnapshot()
          const nextKey = JSON.stringify(next)
          if (nextKey !== snapshotKey) {
            snapshot = next
            snapshotKey = nextKey
            callback(snapshot)
          }
        })
      },
      getValue: () => snapshot,
    }
  }

  watchReceivedAttestations(): Subscribable<Attestation[]> {
    const myDid = this.did

    const getSnapshot = (): Attestation[] => {
      const doc = getPersonalDoc()
      return Object.values(doc.attestations)
        .filter(a => a.toDid === myDid)
        .map(attestationFromDoc)
    }

    let snapshot = getSnapshot()
    let snapshotKey = JSON.stringify(snapshot)

    return {
      subscribe: (callback) => {
        return onPersonalDocChange(() => {
          const next = getSnapshot()
          const nextKey = JSON.stringify(next)
          if (nextKey !== snapshotKey) {
            snapshot = next
            snapshotKey = nextKey
            callback(snapshot)
          }
        })
      },
      getValue: () => snapshot,
    }
  }
}
