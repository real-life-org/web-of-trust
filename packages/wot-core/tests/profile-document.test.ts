import { describe, expect, it } from 'vitest'
import {
  buildProfilePublicationPayload,
  flattenProfilePublicationPayload,
} from '../src/application/identity/profile-document'
import { validateProfileServiceResourcePayload, x25519PublicKeyToMultibase } from '../src/protocol'
import { createTestIdentity } from './helpers/identity-session'
import type { PublicProfile } from '../src/types/identity'

describe('buildProfilePublicationPayload', () => {
  it('throws if the profile DID does not match the identity', async () => {
    const { identity } = await createTestIdentity('profile-doc-mismatch')
    const profile: PublicProfile = { did: 'did:key:zFAKE', name: 'Eve', updatedAt: '2026-05-18T10:43:25.976Z' }
    await expect(buildProfilePublicationPayload(profile, identity)).rejects.toThrow()
  })

  it('builds a didDocument with the identity X25519 key in keyAgreement (Sync 004 didDocument is canonical)', async () => {
    const { identity } = await createTestIdentity('profile-doc-keyagreement')
    const profile: PublicProfile = { did: identity.getDid(), name: 'Alice', updatedAt: '2026-05-18T10:43:25.976Z' }
    const payload = await buildProfilePublicationPayload(profile, identity)
    const expectedMultibase = x25519PublicKeyToMultibase(await identity.getEncryptionPublicKeyBytes())
    expect(payload.didDocument.keyAgreement[0].id).toBe('#enc-0')
    expect(payload.didDocument.keyAgreement[0].publicKeyMultibase).toBe(expectedMultibase)
  })

  it('never copies encryptionPublicKey into profile metadata (Sync 004 Z.153)', async () => {
    const { identity } = await createTestIdentity('profile-doc-no-enc')
    const synthetic = {
      did: identity.getDid(),
      name: 'Alice',
      updatedAt: '2026-05-18T10:43:25.976Z',
      encryptionPublicKey: 'zSHOULD-NOT-LEAK',
    } as unknown as PublicProfile
    const payload = await buildProfilePublicationPayload(synthetic, identity)
    expect('encryptionPublicKey' in payload.profile).toBe(false)
  })

  it('defaults version to a positive integer and lets options.version override', async () => {
    const { identity } = await createTestIdentity('profile-doc-version')
    const profile: PublicProfile = { did: identity.getDid(), name: 'Alice', updatedAt: '2026-05-18T10:43:25.976Z' }
    const auto = await buildProfilePublicationPayload(profile, identity)
    expect(Number.isInteger(auto.version)).toBe(true)
    expect(auto.version).toBeGreaterThan(0)
    const fixed = await buildProfilePublicationPayload(profile, identity, { version: 7 })
    expect(fixed.version).toBe(7)
  })

  it('only writes optional profile fields when they have content', async () => {
    const { identity } = await createTestIdentity('profile-doc-optional')
    const minimal: PublicProfile = { did: identity.getDid(), name: 'Alice', updatedAt: '2026-05-18T10:43:25.976Z' }
    const payload = await buildProfilePublicationPayload(minimal, identity)
    expect(payload.profile).toEqual({ name: 'Alice' })
  })

  it('produces a payload that passes the resource schema (round-trip)', async () => {
    const { identity } = await createTestIdentity('profile-doc-roundtrip')
    const profile: PublicProfile = {
      did: identity.getDid(),
      name: 'Alice Müller',
      bio: 'Gärtnerin',
      offers: ['Gemüse'],
      updatedAt: '2026-05-18T10:43:25.976Z',
    }
    const payload = await buildProfilePublicationPayload(profile, identity)
    expect(() => validateProfileServiceResourcePayload(payload, { expectedDid: profile.did })).not.toThrow()
  })

  it('round-trips through flatten back to the profile (mod did/updatedAt)', async () => {
    const { identity } = await createTestIdentity('profile-doc-flatten')
    const profile: PublicProfile = {
      did: identity.getDid(),
      name: 'Alice',
      bio: 'Gärtnerin',
      offers: ['Gemüse'],
      updatedAt: '2026-05-18T10:43:25.976Z',
    }
    const payload = await buildProfilePublicationPayload(profile, identity)
    expect(flattenProfilePublicationPayload(payload)).toEqual(profile)
  })
})
