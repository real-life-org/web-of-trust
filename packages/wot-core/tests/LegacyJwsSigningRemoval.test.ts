import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as coreRoot from '../src'
import * as coreCrypto from '../src/crypto'
import { canonicalize, decodeBase64Url, decodeJws, verifyJwsWithPublicKey } from '../src/protocol'
import { createTestIdentity, testCryptoAdapter } from './helpers/identity-session'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cryptoJwsPath = resolve(__dirname, '../src/crypto/jws.ts')
const coreIndexPath = resolve(__dirname, '../src/index.ts')
const coreCryptoIndexPath = resolve(__dirname, '../src/crypto/index.ts')

describe('legacy crypto signJws helper removal', () => {
  // Issue #94 / Identity 002: the legacy JWT-style signJws helper in
  // packages/wot-core/src/crypto/jws.ts is no longer the identity signing
  // path. The protocol JCS/EdDSA helpers in packages/wot-core/src/protocol/
  // crypto/jws.ts are the signing authority, and IdentitySession.signJws
  // delegates to them. The legacy public helper must be removed from the
  // crypto module and from both the @web_of_trust/core root and
  // @web_of_trust/core/crypto public surfaces.

  it('does not define an exported signJws helper in packages/wot-core/src/crypto/jws.ts', () => {
    const source = readFileSync(cryptoJwsPath, 'utf8')
    expect(source).not.toMatch(/export\s+async\s+function\s+signJws\b/)
    expect(source).not.toMatch(/export\s+function\s+signJws\b/)
    expect(source).not.toMatch(/export\s*\{[^}]*\bsignJws\b[^}]*\}/)
  })

  it('does not re-export signJws from @web_of_trust/core/crypto', () => {
    const source = readFileSync(coreCryptoIndexPath, 'utf8')
    expect(source).not.toMatch(/\bsignJws\b/)
    expect((coreCrypto as Record<string, unknown>).signJws).toBeUndefined()
  })

  it('does not re-export signJws from @web_of_trust/core', () => {
    const source = readFileSync(coreIndexPath, 'utf8')
    expect(source).not.toMatch(/\bsignJws\b/)
    expect((coreRoot as Record<string, unknown>).signJws).toBeUndefined()
  })

  it('keeps verifyJws and extractJwsPayload as compatibility verification helpers', () => {
    expect(typeof (coreCrypto as Record<string, unknown>).verifyJws).toBe('function')
    expect(typeof (coreCrypto as Record<string, unknown>).extractJwsPayload).toBe('function')
    expect(typeof (coreRoot as Record<string, unknown>).verifyJws).toBe('function')
    expect(typeof (coreRoot as Record<string, unknown>).extractJwsPayload).toBe('function')
  })

  it('keeps IdentitySession.signJws as the protocol-backed JCS/EdDSA signing path', async () => {
    const { identity } = await createTestIdentity('legacy-signjws-removal')
    const payload = { did: identity.did, nonce: 'legacy-removal', issuedAt: '2026-05-18T10:04:33.912Z' }

    const jws = await identity.signJws(payload)

    const decoded = decodeJws<Record<string, unknown>, Record<string, unknown>>(jws)
    expect(decoded.header.alg).toBe('EdDSA')
    expect(decoded.header.kid).toBe(identity.kid)
    expect(decoded.header.typ).toBeUndefined()
    expect(new TextDecoder().decode(decodeBase64Url(jws.split('.')[1]))).toBe(canonicalize(payload))

    const verified = await verifyJwsWithPublicKey(jws, {
      publicKey: identity.ed25519PublicKey,
      crypto: testCryptoAdapter,
    })
    expect(verified.payload).toEqual(payload)
  })
})
