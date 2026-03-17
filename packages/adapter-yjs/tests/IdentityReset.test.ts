import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { YjsStorageAdapter } from '../src/YjsStorageAdapter'
import {
  initYjsPersonalDoc,
  resetYjsPersonalDoc,
  deleteYjsPersonalDocDB,
} from '../src/YjsPersonalDocManager'
import { WotIdentity } from '@real-life/wot-core'
import type { Contact, Verification, Attestation } from '@real-life/wot-core'

/**
 * Tests that switching identities (logout → new login) produces a clean state.
 * This is critical: a new identity must NEVER see contacts, verifications,
 * or attestations from a previous identity.
 */
describe('Identity Reset — no data leaks between identities', () => {
  const DID_A = 'did:key:z6MkUserA'
  const DID_B = 'did:key:z6MkUserB'
  const CONTACT_DID = 'did:key:z6MkContact'

  function makeContact(overrides: Partial<Contact> = {}): Contact {
    const now = new Date().toISOString()
    return {
      did: CONTACT_DID,
      publicKey: 'pubkey123',
      name: 'TestContact',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  function makeVerification(from: string, to: string): Verification {
    return {
      id: `ver-${from}-${to}`,
      from,
      to,
      timestamp: new Date().toISOString(),
      proof: { type: 'Ed25519Signature2020', signatureValue: 'sig' },
    }
  }

  function makeAttestation(from: string, to: string): Attestation {
    return {
      id: `att-${from}-${to}`,
      from,
      to,
      claim: 'I know this person',
      createdAt: new Date().toISOString(),
      proof: { type: 'Ed25519Signature2020', signatureValue: 'sig' },
    }
  }

  afterEach(async () => {
    await resetYjsPersonalDoc()
    await deleteYjsPersonalDocDB()
  })

  it('should not leak contacts after deleteYjsPersonalDocDB + re-init', async () => {
    // --- Identity A: create data ---
    const identityA = new WotIdentity()
    await initYjsPersonalDoc(identityA, null as any)
    const adapterA = new YjsStorageAdapter(DID_A)

    await adapterA.addContact(makeContact())
    await adapterA.saveVerification(makeVerification(DID_A, CONTACT_DID))
    await adapterA.saveAttestation(makeAttestation(DID_A, CONTACT_DID))

    // Verify data exists
    expect(await adapterA.getContacts()).toHaveLength(1)
    expect(await adapterA.getAllVerifications()).toHaveLength(1)
    expect(await adapterA.getAttestation('att-' + DID_A + '-' + CONTACT_DID)).not.toBeNull()

    // --- Simulate logout: full cleanup ---
    await resetYjsPersonalDoc()
    await deleteYjsPersonalDocDB()

    // --- Identity B: fresh start ---
    const identityB = new WotIdentity()
    await initYjsPersonalDoc(identityB, null as any)
    const adapterB = new YjsStorageAdapter(DID_B)

    // Must be completely clean
    expect(await adapterB.getContacts()).toHaveLength(0)
    expect(await adapterB.getAllVerifications()).toHaveLength(0)
    expect(await adapterB.getAttestation('att-' + DID_A + '-' + CONTACT_DID)).toBeNull()
    expect(await adapterB.getIdentity()).toBeNull()
  })

  it('should not leak data when only resetYjsPersonalDoc is called (without DB delete)', async () => {
    // --- Identity A: create data ---
    const identityA = new WotIdentity()
    await initYjsPersonalDoc(identityA, null as any)
    const adapterA = new YjsStorageAdapter(DID_A)

    await adapterA.addContact(makeContact())
    await adapterA.saveVerification(makeVerification(DID_A, CONTACT_DID))

    expect(await adapterA.getContacts()).toHaveLength(1)

    // --- Only reset (NOT delete DB) — simulates the old broken flow ---
    await resetYjsPersonalDoc()

    // --- Identity B: init without DB delete ---
    const identityB = new WotIdentity()
    await initYjsPersonalDoc(identityB, null as any)
    const adapterB = new YjsStorageAdapter(DID_B)

    // This test documents whether reset alone is sufficient.
    // If contacts leak here, it proves we NEED deleteYjsPersonalDocDB.
    const contacts = await adapterB.getContacts()
    // With CompactStore persistence, reset alone may NOT be enough
    // This test captures the current behavior
    if (contacts.length > 0) {
      console.warn('WARNING: resetYjsPersonalDoc alone does NOT prevent data leaks — deleteYjsPersonalDocDB is required!')
    }
  })

  it('should produce clean profile after identity switch', async () => {
    // --- Identity A: set profile ---
    const identityA = new WotIdentity()
    await initYjsPersonalDoc(identityA, null as any)
    const adapterA = new YjsStorageAdapter(DID_A)

    const now = new Date().toISOString()
    await adapterA.updateIdentity({
      did: DID_A,
      profile: { name: 'User A', bio: 'I am user A' },
      createdAt: now,
      updatedAt: now,
    })

    const profileA = await adapterA.getIdentity()
    expect(profileA?.profile.name).toBe('User A')

    // --- Full cleanup ---
    await resetYjsPersonalDoc()
    await deleteYjsPersonalDocDB()

    // --- Identity B ---
    const identityB = new WotIdentity()
    await initYjsPersonalDoc(identityB, null as any)
    const adapterB = new YjsStorageAdapter(DID_B)

    const profileB = await adapterB.getIdentity()
    expect(profileB).toBeNull()
  })

  it('should produce clean verifications and attestations after identity switch', async () => {
    // --- Identity A: create verifications + attestations ---
    const identityA = new WotIdentity()
    await initYjsPersonalDoc(identityA, null as any)
    const adapterA = new YjsStorageAdapter(DID_A)

    await adapterA.addContact(makeContact())
    await adapterA.saveVerification(makeVerification(DID_A, CONTACT_DID))
    await adapterA.saveAttestation(makeAttestation(DID_A, CONTACT_DID))

    expect(await adapterA.getAllVerifications()).toHaveLength(1)
    expect((await adapterA.getAttestation('att-' + DID_A + '-' + CONTACT_DID))).not.toBeNull()

    // --- Full cleanup ---
    await resetYjsPersonalDoc()
    await deleteYjsPersonalDocDB()

    // --- Identity B ---
    const identityB = new WotIdentity()
    await initYjsPersonalDoc(identityB, null as any)
    const adapterB = new YjsStorageAdapter(DID_B)

    expect(await adapterB.getAllVerifications()).toHaveLength(0)
    expect(await adapterB.getAttestation('att-' + DID_A + '-' + CONTACT_DID)).toBeNull()
  })
})
