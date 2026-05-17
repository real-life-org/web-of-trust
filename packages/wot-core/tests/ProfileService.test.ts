import { describe, it, expect, beforeEach } from 'vitest'
import type { PublicIdentitySession } from '../src/application/identity'
import { ProfileService } from '../src/services/ProfileService'
import { createTestIdentity } from './helpers/identity-session'

describe('ProfileService', () => {
  let identity: PublicIdentitySession

  beforeEach(async () => {
    identity = (await createTestIdentity('test-passphrase')).identity
  })

  describe('signProfile()', () => {
    it('should return a JWS string', async () => {
      const profile = {
        did: identity.getDid(),
        name: 'Alice',
        updatedAt: new Date().toISOString(),
      }
      const jws = await ProfileService.signProfile(profile, identity)
      expect(typeof jws).toBe('string')
      expect(jws.split('.')).toHaveLength(3)
    })
  })

  describe('verifyProfile()', () => {
    it('should verify a valid signed profile', async () => {
      const profile = {
        did: identity.getDid(),
        name: 'Alice',
        updatedAt: new Date().toISOString(),
      }
      const jws = await ProfileService.signProfile(profile, identity)
      const result = await ProfileService.verifyProfile(jws)
      expect(result.valid).toBe(true)
      expect(result.profile?.name).toBe('Alice')
      expect(result.profile?.did).toBe(identity.getDid())
      expect(result.didDocument?.id).toBe(identity.getDid())
      expect(result.didDocument?.keyAgreement[0].id).toBe('#enc-0')
    })

    it('should reject tampered JWS', async () => {
      const profile = {
        did: identity.getDid(),
        name: 'Alice',
        updatedAt: new Date().toISOString(),
      }
      const jws = await ProfileService.signProfile(profile, identity)
      const tampered = jws.slice(0, -5) + 'XXXXX'
      const result = await ProfileService.verifyProfile(tampered)
      expect(result.valid).toBe(false)
    })

    it('should reject JWS with mismatched DID', async () => {
      // Sign with identity A but claim DID B in payload
      const profile = {
        did: identity.getDid(),
        name: 'Eve',
        updatedAt: new Date().toISOString(),
      }
      const document = await ProfileService.createProfileDocument(profile, identity)
      const jws = await identity.signJws({ ...document, did: 'did:key:zFAKE123' })
      const result = await ProfileService.verifyProfile(jws)
      // verifyProfile resolves public key from payload.did — signature won't match
      expect(result.valid).toBe(false)
    })

    it('should reject invalid JWS format', async () => {
      const result = await ProfileService.verifyProfile('not-a-jws')
      expect(result.valid).toBe(false)
    })
  })

  describe('round-trip: sign → verify', () => {
    it('should preserve all profile fields', async () => {
      const profile = {
        did: identity.getDid(),
        name: 'Alice Müller',
        bio: 'Gärtnerin',
        updatedAt: '2026-02-10T12:00:00.000Z',
      }
      const jws = await ProfileService.signProfile(profile, identity)
      const result = await ProfileService.verifyProfile(jws)
      expect(result.valid).toBe(true)
      expect(result.profile).toEqual(profile)
    })
  })
})
