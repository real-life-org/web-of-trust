import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IdentityWorkflow, type PublicIdentitySession } from '../../wot-core/src/application/identity'
import { WebCryptoProtocolCryptoAdapter } from '../../wot-core/src/protocol-adapters'
import {
  decodeJws,
  encodeBase64Url,
} from '../../wot-core/src/protocol'
import {
  verifyProfileJws,
  extractJwsPayload,
} from '../src/jws-verify.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const jwsVerifySourcePath = resolve(__dirname, '../src/jws-verify.ts')

// Issue #94 / Identity 002 / Sync 004: wot-profiles JWS verification must
// delegate to the shared protocol JWS / did:key helpers and the
// WebCryptoProtocolCryptoAdapter. The package must no longer carry its
// own Base58, did:key, base64url, or WebCrypto verification code.

async function createIdentity(passphrase: string): Promise<PublicIdentitySession> {
  const { identity } = await new IdentityWorkflow({
    crypto: new WebCryptoProtocolCryptoAdapter(),
  }).createIdentity({ passphrase, storeSeed: false })
  return identity
}

describe('wot-profiles protocol-backed JWS verification (issue #94)', () => {
  describe('source-level guard', () => {
    const source = readFileSync(jwsVerifySourcePath, 'utf8')

    it('does not define a local Base58 alphabet or decoder', () => {
      expect(source).not.toMatch(/BASE58_ALPHABET/)
      expect(source).not.toMatch(/\bdecodeBase58\b/)
    })

    it('does not define a local did:key-to-public-key resolver', () => {
      expect(source).not.toMatch(/\bdidToPublicKeyBytes\b/)
    })

    it('does not define a local base64url decoder', () => {
      expect(source).not.toMatch(/\bdecodeBase64Url\b/)
    })

    it('does not call crypto.subtle.importKey directly', () => {
      expect(source).not.toMatch(/crypto\.subtle\.importKey/)
    })
  })

  describe('verifyProfileJws() via protocol helpers', () => {
    it('accepts a protocol-backed identity-session JWS carrying kid', async () => {
      const identity = await createIdentity('alice-pass')
      const did = identity.getDid()
      const jws = await identity.signJws({
        did,
        name: 'Alice',
        updatedAt: '2026-05-18T10:43:25.976Z',
      })

      const decoded = decodeJws(jws)
      expect(decoded.header).toMatchObject({
        alg: 'EdDSA',
        kid: `${did}#sig-0`,
      })

      const result = await verifyProfileJws(jws)
      expect(result.valid).toBe(true)
      expect(result.payload?.did).toBe(did)
      expect(result.error).toBeUndefined()
    })

    it('rejects a malformed JWS without three compact segments', async () => {
      const result = await verifyProfileJws('not-a-real-jws')
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('rejects a tampered signature segment', async () => {
      const identity = await createIdentity('alice-pass')
      const jws = await identity.signJws({
        did: identity.getDid(),
        name: 'Alice',
        updatedAt: '2026-05-18T10:43:25.976Z',
      })
      const tampered = `${jws.slice(0, -5)}AAAAA`

      const result = await verifyProfileJws(tampered)
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('rejects a JWS whose payload DID does not match the signing key', async () => {
      const alice = await createIdentity('alice-pass')
      const bob = await createIdentity('bob-pass')

      // Bob signs but claims to be Alice — protocol verification must reject
      // because Alice's resolved public key cannot verify Bob's signature.
      const jws = await bob.signJws({
        did: alice.getDid(),
        name: 'Eve',
        updatedAt: '2026-05-18T10:43:25.976Z',
      })

      const result = await verifyProfileJws(jws)
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('rejects a JWS whose protected header is missing kid', async () => {
      const identity = await createIdentity('alice-pass')
      const did = identity.getDid()
      const payload = {
        did,
        name: 'Alice',
        updatedAt: '2026-05-18T10:43:25.976Z',
      }
      const header = { alg: 'EdDSA' }

      const encoder = new TextEncoder()
      const encodedHeader = encodeBase64Url(encoder.encode(JSON.stringify(header)))
      const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)))
      const signingInput = `${encodedHeader}.${encodedPayload}`
      const signature = await identity.sign(signingInput)
      const tokenNoKid = `${encodedHeader}.${encodedPayload}.${signature}`

      const result = await verifyProfileJws(tokenNoKid)
      expect(result.valid).toBe(false)
      expect(result.error ?? '').toMatch(/kid|header|invalid/i)
    })

    it('rejects a JWS payload missing did', async () => {
      const identity = await createIdentity('alice-pass')
      const jws = await identity.signJws({
        name: 'Alice',
        updatedAt: '2026-05-18T10:43:25.976Z',
      })

      const result = await verifyProfileJws(jws)
      expect(result.valid).toBe(false)
      expect(result.error ?? '').toMatch(/did/i)
    })
  })

  describe('extractJwsPayload() via protocol decoder', () => {
    it('extracts the payload from a protocol-signed JWS without verifying', async () => {
      const identity = await createIdentity('alice-pass')
      const did = identity.getDid()
      const jws = await identity.signJws({
        did,
        profile: { name: 'Alice' },
        verifications: [{ id: 'v1' }, { id: 'v2' }],
        attestations: [{ id: 'a1' }],
        updatedAt: '2026-05-18T10:43:25.976Z',
      })

      const payload = extractJwsPayload(jws)
      expect(payload).not.toBeNull()
      expect(payload?.did).toBe(did)
      expect(Array.isArray(payload?.verifications)).toBe(true)
      expect((payload?.verifications as unknown[]).length).toBe(2)
      expect(Array.isArray(payload?.attestations)).toBe(true)
      expect((payload?.attestations as unknown[]).length).toBe(1)
    })

    it('returns null for a malformed JWS', () => {
      expect(extractJwsPayload('not-a-real-jws')).toBeNull()
      expect(extractJwsPayload('only.two')).toBeNull()
      expect(extractJwsPayload('a.b.c')).toBeNull()
    })

    it('does not verify the signature (tampered payload still parseable)', async () => {
      const identity = await createIdentity('alice-pass')
      const jws = await identity.signJws({
        did: identity.getDid(),
        name: 'Alice',
        updatedAt: '2026-05-18T10:43:25.976Z',
      })
      const tampered = `${jws.slice(0, -5)}AAAAA`

      const payload = extractJwsPayload(tampered)
      expect(payload).not.toBeNull()
      expect(payload?.did).toBe(identity.getDid())
    })
  })
})
