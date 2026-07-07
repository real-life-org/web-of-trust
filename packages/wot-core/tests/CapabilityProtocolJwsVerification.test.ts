import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createCapability,
  delegateCapability,
  extractCapability,
  verifyCapability,
} from '../src/application/authorization/capabilities'
import { createResourceRef } from '../src/types/resource-ref'
import { decodeJws } from '../src/protocol'
import { createTestIdentity } from './helpers/identity-session'

const __dirname = dirname(fileURLToPath(import.meta.url))
const capabilitiesPath = resolve(__dirname, '../src/application/authorization/capabilities.ts')

function futureDate(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

describe('Capability protocol-backed JWS verification (issue #94)', () => {
  // Issue #94 / Identity 002 / Sync 003: capability JWS extraction and
  // verification must delegate to the protocol JWS helpers (decodeJws /
  // verifyJwsWithPublicKey) backed by didKeyToPublicKeyBytes and the
  // WebCrypto protocol adapter — not the legacy ./jws compatibility
  // helpers, the legacy ./did helper, or direct crypto.subtle.importKey
  // calls.

  describe('source-level guard', () => {
    it('does not import from ./jws', () => {
      const source = readFileSync(capabilitiesPath, 'utf8')
      expect(source).not.toMatch(/from\s+['"]\.\/jws['"]/)
    })

    it('does not reference extractJwsPayload', () => {
      const source = readFileSync(capabilitiesPath, 'utf8')
      expect(source).not.toMatch(/\bextractJwsPayload\b/)
    })

    it('does not reference the legacy verifyJws helper', () => {
      const source = readFileSync(capabilitiesPath, 'utf8')
      expect(source).not.toMatch(/\bverifyJws\b(?!WithPublicKey)/)
    })

    it('does not import didToPublicKeyBytes from ./did', () => {
      const source = readFileSync(capabilitiesPath, 'utf8')
      expect(source).not.toMatch(/\bdidToPublicKeyBytes\b/)
    })

    it('does not call crypto.subtle.importKey directly', () => {
      const source = readFileSync(capabilitiesPath, 'utf8')
      expect(source).not.toMatch(/crypto\.subtle\.importKey/)
    })

    it('uses protocol JWS helpers for verification', () => {
      const source = readFileSync(capabilitiesPath, 'utf8')
      expect(source).toMatch(/\bverifyJwsWithPublicKey\b/)
      expect(source).toMatch(/\bdidKeyToPublicKeyBytes\b/)
    })
  })

  describe('verifyCapability() via protocol helpers', () => {
    const resource = createResourceRef('space', 'capability-protocol-jws')

    it('accepts a protocol-backed identity-session JWS carrying kid', async () => {
      const { identity: alice } = await createTestIdentity('cap-protocol-alice')
      const { identity: bob } = await createTestIdentity('cap-protocol-bob')

      const jws = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource,
          permissions: ['read', 'write'],
          expiration: futureDate(12),
        },
        (payload) => alice.signJws(payload),
      )

      const decoded = decodeJws(jws)
      expect(decoded.header.alg).toBe('EdDSA')
      expect(decoded.header.kid).toBe(alice.kid)

      const result = await verifyCapability(jws)
      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.capability.issuer).toBe(alice.getDid())
        expect(result.capability.audience).toBe(bob.getDid())
        expect(result.chain).toHaveLength(0)
      }
    })

    it('rejects a malformed JWS without three compact segments', async () => {
      const result = await verifyCapability('not.a-real-jws')
      expect(result.valid).toBe(false)
      if (!result.valid) expect(result.error).toBeDefined()
    })

    it('rejects a JWS with a JSON-primitive payload before signature verification', async () => {
      const primitiveJws = [
        encodeJson({ alg: 'EdDSA', kid: 'did:key:zFake#sig-0' }),
        encodeJson(42),
        'AAAA',
      ].join('.')

      const result = await verifyCapability(primitiveJws)
      expect(result.valid).toBe(false)
      if (!result.valid) expect(result.error).toContain('cannot extract payload')
      expect(extractCapability(primitiveJws)).toBeNull()
    })

    it('reports a missing kid as a header error rather than a signature error', async () => {
      const { identity: alice } = await createTestIdentity('cap-protocol-missing-kid-alice')
      const { identity: bob } = await createTestIdentity('cap-protocol-missing-kid-bob')
      const payload = {
        id: crypto.randomUUID(),
        issuer: alice.getDid(),
        audience: bob.getDid(),
        resource,
        permissions: ['read'],
        expiration: futureDate(12),
      }
      const jwsWithoutKid = [
        encodeJson({ alg: 'EdDSA' }),
        encodeJson(payload),
        'AAAA',
      ].join('.')

      const result = await verifyCapability(jwsWithoutKid)
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toContain('Invalid JWS header')
        expect(result.error).not.toContain('Invalid signature')
      }
    })

    it('rejects a tampered signature segment', async () => {
      const { identity: alice } = await createTestIdentity('cap-protocol-tampered-alice')
      const { identity: bob } = await createTestIdentity('cap-protocol-tampered-bob')

      const jws = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource,
          permissions: ['read'],
          expiration: futureDate(12),
        },
        (payload) => alice.signJws(payload),
      )
      const tampered = `${jws.slice(0, -5)}AAAAA`

      const result = await verifyCapability(tampered)
      expect(result.valid).toBe(false)
      if (!result.valid) expect(result.error).toMatch(/signature/i)
    })

    it('rejects a JWS whose issuer DID does not match the signing key', async () => {
      const { identity: alice } = await createTestIdentity('cap-protocol-mismatch-alice')
      const { identity: bob } = await createTestIdentity('cap-protocol-mismatch-bob')
      const { identity: carl } = await createTestIdentity('cap-protocol-mismatch-carl')

      // Alice signs a capability that claims Bob as issuer. The protocol
      // verifier must resolve capability.issuer (Bob) and reject because the
      // signing key does not match.
      const jws = await createCapability(
        {
          issuer: bob.getDid(),
          audience: carl.getDid(),
          resource,
          permissions: ['read'],
          expiration: futureDate(12),
        },
        (payload) => alice.signJws(payload),
      )

      const result = await verifyCapability(jws)
      expect(result.valid).toBe(false)
      if (!result.valid) expect(result.error).toMatch(/signature/i)
    })

    it('preserves delegation-chain validation through protocol helpers', async () => {
      const { identity: alice } = await createTestIdentity('cap-protocol-chain-alice')
      const { identity: bob } = await createTestIdentity('cap-protocol-chain-bob')
      const { identity: carl } = await createTestIdentity('cap-protocol-chain-carl')

      const aliceToBob = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource,
          permissions: ['read', 'write', 'delegate'],
          expiration: futureDate(24),
        },
        (payload) => alice.signJws(payload),
      )

      const bobToCarl = await delegateCapability(
        aliceToBob,
        {
          audience: carl.getDid(),
          permissions: ['read'],
          expiration: futureDate(12),
        },
        (payload) => bob.signJws(payload),
      )

      const result = await verifyCapability(bobToCarl)
      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.capability.issuer).toBe(bob.getDid())
        expect(result.capability.audience).toBe(carl.getDid())
        expect(result.capability.permissions).toEqual(['read'])
        expect(result.chain).toHaveLength(1)
        expect(result.chain[0].issuer).toBe(alice.getDid())
      }
    })

    it('rejects a delegation whose child is signed by the wrong identity', async () => {
      const { identity: alice } = await createTestIdentity('cap-protocol-chain-bad-alice')
      const { identity: bob } = await createTestIdentity('cap-protocol-chain-bad-bob')
      const { identity: carl } = await createTestIdentity('cap-protocol-chain-bad-carl')

      const aliceToBob = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource,
          permissions: ['read', 'write', 'delegate'],
          expiration: futureDate(24),
        },
        (payload) => alice.signJws(payload),
      )

      // Carl signs instead of Bob — issuer in payload is bob.getDid() but the
      // signature was produced by Carl's key, so the protocol verifier must
      // reject the mismatch.
      const fakeDelegate = await delegateCapability(
        aliceToBob,
        {
          audience: carl.getDid(),
          permissions: ['read'],
          expiration: futureDate(12),
        },
        (payload) => carl.signJws(payload),
      )

      const result = await verifyCapability(fakeDelegate)
      expect(result.valid).toBe(false)
      if (!result.valid) expect(result.error).toMatch(/signature/i)
    })
  })

  describe('extractCapability() via protocol decode helpers', () => {
    const resource = createResourceRef('space', 'capability-extract-protocol')

    it('decodes a protocol-backed capability JWS without verifying signature', async () => {
      const { identity: alice } = await createTestIdentity('cap-extract-alice')
      const { identity: bob } = await createTestIdentity('cap-extract-bob')

      const jws = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource,
          permissions: ['read'],
          expiration: futureDate(12),
        },
        (payload) => alice.signJws(payload),
      )

      const capability = extractCapability(jws)
      expect(capability).not.toBeNull()
      expect(capability!.issuer).toBe(alice.getDid())
      expect(capability!.audience).toBe(bob.getDid())
    })

    it('returns null for malformed input', () => {
      expect(extractCapability('not-a-jws')).toBeNull()
      expect(extractCapability('')).toBeNull()
    })
  })
})
