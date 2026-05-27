import { existsSync, readFileSync } from 'node:fs'
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
const legacyHelperNames = '(signJws|verifyJws|extractJwsPayload)'
const legacyHelperReExportPattern = new RegExp(`export\\s*\\{[^}]*\\b${legacyHelperNames}\\b[^}]*\\}`)
const legacyHelperDeclarationPattern = new RegExp(
  `export\\s+(?:async\\s+)?(?:function\\s+${legacyHelperNames}\\b|(?:const|let|var)\\s+${legacyHelperNames}\\b)`,
)

describe('legacy crypto JWS public-surface removal', () => {
  // Issue #94 / Identity 002: the legacy public JWS helpers
  // (signJws, verifyJws, extractJwsPayload) in
  // packages/wot-core/src/crypto/jws.ts are no longer the identity signing
  // or verification path. The protocol JCS/EdDSA helpers in
  // packages/wot-core/src/protocol/crypto/jws.ts are the signing authority,
  // and IdentitySession.signJws + verifyJwsWithPublicKey are the public
  // surface for signing and verifying. All three legacy public helpers must
  // be removed from the crypto module file and from both the
  // @web_of_trust/core root and @web_of_trust/core/crypto public surfaces.

  it('removes the legacy crypto/jws.ts module file', () => {
    expect(existsSync(cryptoJwsPath)).toBe(false)
  })

  it('does not re-export legacy JWS helpers from @web_of_trust/core/crypto', () => {
    const source = readFileSync(coreCryptoIndexPath, 'utf8')
    expect(source).not.toMatch(legacyHelperReExportPattern)
    expect(source).not.toMatch(legacyHelperDeclarationPattern)
    expect(source).not.toMatch(/from\s+['"]\.\/jws['"]/)
    expect(Object.prototype.hasOwnProperty.call(coreCrypto, 'signJws')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(coreCrypto, 'verifyJws')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(coreCrypto, 'extractJwsPayload')).toBe(false)
  })

  it('does not re-export legacy JWS helpers from @web_of_trust/core', () => {
    const source = readFileSync(coreIndexPath, 'utf8')
    expect(source).not.toMatch(legacyHelperReExportPattern)
    expect(source).not.toMatch(legacyHelperDeclarationPattern)
    expect(source).not.toMatch(/from\s+['"]\.\/crypto\/jws['"]/)
    expect(Object.prototype.hasOwnProperty.call(coreRoot, 'signJws')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(coreRoot, 'verifyJws')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(coreRoot, 'extractJwsPayload')).toBe(false)
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
