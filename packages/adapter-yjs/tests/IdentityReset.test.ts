import { describe, it, expect, afterEach } from 'vitest'
import { YjsStorageAdapter } from '../src/YjsStorageAdapter'
import {
  initYjsPersonalDoc,
  resetYjsPersonalDoc,
  deleteYjsPersonalDocDB,
} from '../src/YjsPersonalDocManager'
import { WotIdentity } from '@web_of_trust/core/application'
import type { Contact, Verification, Attestation } from '@web_of_trust/core/types'

/**
 * After logout (reset + delete), a new identity must start completely clean.
 * No contacts, verifications, attestations, or profile from the previous identity.
 */
describe('Identity Reset — no data leaks between identities', () => {
  const DID_A = 'did:key:z6MkUserA'
  const DID_B = 'did:key:z6MkUserB'
  const CONTACT_DID = 'did:key:z6MkContact'

  afterEach(async () => {
    await resetYjsPersonalDoc()
    await deleteYjsPersonalDocDB()
  })

  it('new identity sees no data from previous identity', async () => {
    // --- Identity A: populate all data types ---
    const identityA = new WotIdentity()
    await initYjsPersonalDoc(identityA, null as any)
    const adapterA = new YjsStorageAdapter(DID_A)

    const now = new Date().toISOString()

    await adapterA.updateIdentity({
      did: DID_A,
      profile: { name: 'User A', bio: 'Bio of A' },
      createdAt: now,
      updatedAt: now,
    })

    await adapterA.addContact({
      did: CONTACT_DID,
      publicKey: 'pubkey123',
      name: 'TestContact',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } as Contact)

    await adapterA.saveVerification({
      id: 'ver-1',
      from: DID_A,
      to: CONTACT_DID,
      timestamp: now,
      proof: { type: 'Ed25519Signature2020', signatureValue: 'sig' },
    } as Verification)

    await adapterA.saveAttestation({
      id: 'att-1',
      from: DID_A,
      to: CONTACT_DID,
      claim: 'I know this person',
      createdAt: now,
      proof: { type: 'Ed25519Signature2020', signatureValue: 'sig' },
    } as Attestation)

    // Sanity check: data exists
    expect(await adapterA.getIdentity()).not.toBeNull()
    expect(await adapterA.getContacts()).toHaveLength(1)
    expect(await adapterA.getAllVerifications()).toHaveLength(1)
    expect(await adapterA.getAttestation('att-1')).not.toBeNull()

    // --- Logout ---
    await resetYjsPersonalDoc()
    await deleteYjsPersonalDocDB()

    // --- Identity B: must be completely clean ---
    const identityB = new WotIdentity()
    await initYjsPersonalDoc(identityB, null as any)
    const adapterB = new YjsStorageAdapter(DID_B)

    expect(await adapterB.getIdentity()).toBeNull()
    expect(await adapterB.getContacts()).toHaveLength(0)
    expect(await adapterB.getAllVerifications()).toHaveLength(0)
    expect(await adapterB.getAttestation('att-1')).toBeNull()
  })
})
