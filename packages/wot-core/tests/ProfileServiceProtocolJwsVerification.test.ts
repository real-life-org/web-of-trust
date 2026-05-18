import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ProfileService } from '../src/services/ProfileService'
import { decodeJws } from '../src/protocol'
import { createTestIdentity } from './helpers/identity-session'

const __dirname = dirname(fileURLToPath(import.meta.url))
const profileServicePath = resolve(__dirname, '../src/services/ProfileService.ts')

describe('ProfileService protocol-backed JWS verification (issue #94)', () => {
  // Issue #94 / Identity 002 / Sync 004: ProfileService verification must
  // delegate to the protocol JWS helpers (decodeJws / verifyJwsWithPublicKey)
  // backed by the WebCrypto protocol adapter rather than re-implementing
  // signature verification through the legacy `../crypto/jws` helpers and
  // direct `crypto.subtle.importKey` calls.

  describe('source-level guard', () => {
    it('does not import from ../crypto/jws', () => {
      const source = readFileSync(profileServicePath, 'utf8')
      expect(source).not.toMatch(/from\s+['"]\.\.\/crypto\/jws['"]/)
      expect(source).not.toMatch(/\bextractJwsPayload\b/)
      expect(source).not.toMatch(/\bverifyJws\b(?!WithPublicKey)/)
    })

    it('does not call crypto.subtle.importKey directly', () => {
      const source = readFileSync(profileServicePath, 'utf8')
      expect(source).not.toMatch(/crypto\.subtle\.importKey/)
    })

    it('does not import toBuffer from ../crypto/encoding', () => {
      const source = readFileSync(profileServicePath, 'utf8')
      expect(source).not.toMatch(/\btoBuffer\b/)
    })
  })

  describe('verifyProfile() via protocol helpers', () => {
    it('accepts a protocol-backed identity-session JWS carrying kid', async () => {
      const { identity } = await createTestIdentity('profile-protocol-jws')
      const profile = {
        did: identity.getDid(),
        name: 'Alice',
        updatedAt: '2026-05-18T10:43:25.976Z',
      }

      const jws = await ProfileService.signProfile(profile, identity, { version: 1 })

      const decoded = decodeJws(jws)
      expect(decoded.header.alg).toBe('EdDSA')
      expect(decoded.header.kid).toBe(identity.kid)

      const result = await ProfileService.verifyProfile(jws)
      expect(result.valid).toBe(true)
      expect(result.profile?.did).toBe(identity.getDid())
      expect(result.profile?.name).toBe('Alice')
      expect(result.version).toBe(1)
      expect(result.didDocument?.id).toBe(identity.getDid())
    })

    it('rejects a tampered signature segment', async () => {
      const { identity } = await createTestIdentity('profile-protocol-jws-tampered')
      const profile = {
        did: identity.getDid(),
        name: 'Alice',
        updatedAt: '2026-05-18T10:43:25.976Z',
      }
      const jws = await ProfileService.signProfile(profile, identity)
      const tampered = `${jws.slice(0, -5)}AAAAA`

      const result = await ProfileService.verifyProfile(tampered)
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('rejects a malformed JWS without three compact segments', async () => {
      const result = await ProfileService.verifyProfile('not.a-real-jws')
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('rejects a JWS whose payload DID does not match the signing key', async () => {
      const { identity } = await createTestIdentity('profile-protocol-jws-mismatch')
      const { identity: other } = await createTestIdentity('profile-protocol-jws-other')

      const document = await ProfileService.createProfileDocument(
        { did: other.getDid(), name: 'Eve', updatedAt: '2026-05-18T10:43:25.976Z' },
        other,
      )
      // Sign an internally consistent profile document with the wrong identity.
      // The verifier must resolve payload.did and reject the signing-key mismatch.
      const jws = await identity.signJws(document)

      const result = await ProfileService.verifyProfile(jws)
      expect(result.valid).toBe(false)
    })
  })

  describe('verifySignedPayload() via protocol helpers', () => {
    it('verifies an identity-session JWS payload through the protocol adapter', async () => {
      const { identity } = await createTestIdentity('profile-verify-signed-payload')
      const jws = await identity.signJws({
        did: identity.getDid(),
        nonce: 'profile-service-guard',
        issuedAt: '2026-05-18T10:43:25.976Z',
      })

      const result = await ProfileService.verifySignedPayload(jws)
      expect(result.valid).toBe(true)
      expect(result.payload?.did).toBe(identity.getDid())
    })

    it('rejects tampered identity-session JWS', async () => {
      const { identity } = await createTestIdentity('profile-verify-signed-payload-tampered')
      const jws = await identity.signJws({
        did: identity.getDid(),
        nonce: 'profile-service-guard',
        issuedAt: '2026-05-18T10:43:25.976Z',
      })
      const tampered = `${jws.slice(0, -5)}AAAAA`

      const result = await ProfileService.verifySignedPayload(tampered)
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })
  })
})
