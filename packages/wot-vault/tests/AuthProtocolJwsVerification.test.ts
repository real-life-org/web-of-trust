import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'http'
import { verifyIdentity } from '../src/auth'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  decodeJws,
  encodeBase64Url,
  decodeBase64Url,
} from '@web_of_trust/core/protocol'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'

const here = dirname(fileURLToPath(import.meta.url))
const authSourcePath = resolve(here, '../src/auth.ts')

function mockRequest(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

async function makeAuthToken(
  identity: PublicIdentitySession,
  overrides: { did?: string; iat?: number } = {},
): Promise<string> {
  return identity.signJws({
    did: overrides.did ?? identity.getDid(),
    iat: overrides.iat ?? Math.floor(Date.now() / 1000),
  })
}

describe('Vault auth — protocol JWS verification', () => {
  describe('source guard', () => {
    it('does not reference legacy core/crypto JWS or DID byte helpers', () => {
      const src = readFileSync(authSourcePath, 'utf8')
      expect(src).not.toMatch(/extractJwsPayload/)
      expect(src).not.toMatch(/verifyJws\b(?!WithPublicKey)/)
      expect(src).not.toMatch(/didToPublicKeyBytes/)
    })

    it('does not import WebCrypto keys directly for identity-token JWS verification', () => {
      const src = readFileSync(authSourcePath, 'utf8')
      expect(src).not.toMatch(/crypto\.subtle\.importKey/)
    })
  })

  describe('verifyIdentity', () => {
    it('accepts a protocol-backed identity-session JWS with kid', async () => {
      const { identity } = await createTestIdentity('alice-pass')
      const token = await makeAuthToken(identity)

      // Sanity-check: the protocol-signed token carries an EdDSA header with
      // the identity DID's #sig-0 kid. Vault auth must accept exactly that.
      const decoded = decodeJws(token)
      expect(decoded.header).toMatchObject({
        alg: 'EdDSA',
        kid: `${identity.getDid()}#sig-0`,
      })

      const result = await verifyIdentity(
        mockRequest({ authorization: `Bearer ${token}` }),
      )
      expect(result.authenticated).toBe(true)
      expect(result.did).toBe(identity.getDid())
    })

    it('rejects when Authorization header is missing', async () => {
      const result = await verifyIdentity(mockRequest())
      expect(result.authenticated).toBe(false)
      expect(result.error).toMatch(/Missing Authorization header/i)
    })

    it('rejects a malformed (non-three-part) bearer token', async () => {
      const result = await verifyIdentity(
        mockRequest({ authorization: 'Bearer not-a-real-jws' }),
      )
      expect(result.authenticated).toBe(false)
    })

    it('rejects a tampered JWS signature', async () => {
      const { identity } = await createTestIdentity('alice-pass')
      const token = await makeAuthToken(identity)
      const [header, payload, signature] = token.split('.')
      const sigBytes = decodeBase64Url(signature)
      sigBytes[sigBytes.length - 1] ^= 0x01
      const tampered = `${header}.${payload}.${encodeBase64Url(sigBytes)}`

      const result = await verifyIdentity(
        mockRequest({ authorization: `Bearer ${tampered}` }),
      )
      expect(result.authenticated).toBe(false)
      expect(result.error ?? '').toMatch(/signature|invalid/i)
    })

    it('rejects a token whose payload DID does not match the signing key', async () => {
      const { identity: alice } = await createTestIdentity('alice-pass')
      const { identity: bob } = await createTestIdentity('bob-pass')

      // Bob signs but claims to be Alice — protocol verification with Alice's
      // resolved public key must reject this token.
      const token = await bob.signJws({
        did: alice.getDid(),
        iat: Math.floor(Date.now() / 1000),
      })

      const result = await verifyIdentity(
        mockRequest({ authorization: `Bearer ${token}` }),
      )
      expect(result.authenticated).toBe(false)
    })

    it('rejects a token whose protected header is missing the kid', async () => {
      const { identity } = await createTestIdentity('alice-pass')
      const did = identity.getDid()
      const payload = { did, iat: Math.floor(Date.now() / 1000) }
      const header = { alg: 'EdDSA' }

      const encoder = new TextEncoder()
      const encodedHeader = encodeBase64Url(encoder.encode(JSON.stringify(header)))
      const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)))
      const signingInput = `${encodedHeader}.${encodedPayload}`
      // The signing input is pure ASCII, so identity.sign(string) re-encodes
      // it byte-identically and gives us the matching Ed25519 signature.
      const signature = await identity.sign(signingInput)
      const tokenNoKid = `${encodedHeader}.${encodedPayload}.${signature}`

      const result = await verifyIdentity(
        mockRequest({ authorization: `Bearer ${tokenNoKid}` }),
      )
      expect(result.authenticated).toBe(false)
      expect(result.error ?? '').toMatch(/kid|invalid|header|signature/i)
    })

    it('rejects a payload missing did', async () => {
      const { identity } = await createTestIdentity('alice-pass')
      const token = await identity.signJws({
        iat: Math.floor(Date.now() / 1000),
      })
      const result = await verifyIdentity(
        mockRequest({ authorization: `Bearer ${token}` }),
      )
      expect(result.authenticated).toBe(false)
      expect(result.error ?? '').toMatch(/did/i)
    })

    it('rejects a payload missing iat', async () => {
      const { identity } = await createTestIdentity('alice-pass')
      const token = await identity.signJws({ did: identity.getDid() })
      const result = await verifyIdentity(
        mockRequest({ authorization: `Bearer ${token}` }),
      )
      expect(result.authenticated).toBe(false)
      expect(result.error ?? '').toMatch(/iat/i)
    })

    it('rejects iat too far in the future (clock skew)', async () => {
      const { identity } = await createTestIdentity('alice-pass')
      const token = await makeAuthToken(identity, {
        iat: Math.floor(Date.now() / 1000) + 600,
      })
      const result = await verifyIdentity(
        mockRequest({ authorization: `Bearer ${token}` }),
      )
      expect(result.authenticated).toBe(false)
      expect(result.error ?? '').toMatch(/expired|skew/i)
    })

    it('rejects iat too far in the past (token expiry)', async () => {
      const { identity } = await createTestIdentity('alice-pass')
      const token = await makeAuthToken(identity, {
        iat: Math.floor(Date.now() / 1000) - 600,
      })
      const result = await verifyIdentity(
        mockRequest({ authorization: `Bearer ${token}` }),
      )
      expect(result.authenticated).toBe(false)
      expect(result.error ?? '').toMatch(/expired|skew/i)
    })
  })
})
