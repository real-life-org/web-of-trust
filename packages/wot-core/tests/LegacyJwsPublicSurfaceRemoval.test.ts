import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as coreRoot from '../src'
import * as coreCrypto from '../src/crypto'
import { decodeJws, verifyJwsWithPublicKey } from '../src/protocol'
import { createTestIdentity, testCryptoAdapter } from './helpers/identity-session'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cryptoJwsPath = resolve(__dirname, '../src/crypto/jws.ts')
const coreIndexPath = resolve(__dirname, '../src/index.ts')
const coreCryptoIndexPath = resolve(__dirname, '../src/crypto/index.ts')
const LEGACY_HELPERS = ['signJws', 'verifyJws', 'extractJwsPayload'] as const

describe('legacy JWS public surface removal (issue #94)', () => {
  // After PR #106 the protocol JCS/EdDSA helpers in
  // packages/wot-core/src/protocol/crypto/jws.ts are the canonical signing
  // and verification path. This slice removes the legacy public
  // compatibility helpers (signJws / verifyJws / extractJwsPayload) from
  // @web_of_trust/core and @web_of_trust/core/crypto entirely, along with
  // the now-unused packages/wot-core/src/crypto/jws.ts module. The
  // protocol verifyJwsWithPublicKey helper and IdentitySession.signJws
  // remain the supported surface for callers.

  describe('source-level guards', () => {
    it('removes packages/wot-core/src/crypto/jws.ts', () => {
      expect(existsSync(cryptoJwsPath)).toBe(false)
    })

    for (const helper of LEGACY_HELPERS) {
      it(`does not mention ${helper} in the @web_of_trust/core/crypto barrel`, () => {
        const source = readFileSync(coreCryptoIndexPath, 'utf8')
        expect(source).not.toMatch(new RegExp(`\\b${helper}\\b`))
      })

      it(`does not mention ${helper} in the @web_of_trust/core barrel`, () => {
        const source = readFileSync(coreIndexPath, 'utf8')
        expect(source).not.toMatch(new RegExp(`\\b${helper}\\b`))
      })
    }

    it('does not import from the legacy ./jws module in the crypto barrel', () => {
      const source = readFileSync(coreCryptoIndexPath, 'utf8')
      expect(source).not.toMatch(/from\s+['"]\.\/jws['"]/)
    })

    it('does not import from the legacy ./crypto/jws module in the core barrel', () => {
      const source = readFileSync(coreIndexPath, 'utf8')
      expect(source).not.toMatch(/from\s+['"]\.\/crypto\/jws['"]/)
    })
  })

  describe('runtime export guards', () => {
    for (const helper of LEGACY_HELPERS) {
      it(`does not expose ${helper} on @web_of_trust/core/crypto`, () => {
        expect(Object.prototype.hasOwnProperty.call(coreCrypto, helper)).toBe(false)
        expect((coreCrypto as Record<string, unknown>)[helper]).toBeUndefined()
      })

      it(`does not expose ${helper} on @web_of_trust/core`, () => {
        expect(Object.prototype.hasOwnProperty.call(coreRoot, helper)).toBe(false)
        expect((coreRoot as Record<string, unknown>)[helper]).toBeUndefined()
      })
    }
  })

  describe('supported replacements remain available', () => {
    it('keeps protocol verifyJwsWithPublicKey verifying IdentitySession-signed JWS', async () => {
      const { identity } = await createTestIdentity('legacy-public-surface-removal')
      const payload = {
        did: identity.did,
        nonce: 'public-surface-removal',
        issuedAt: '2026-05-20T06:11:39.229Z',
      }

      const jws = await identity.signJws(payload)

      const decoded = decodeJws<Record<string, unknown>, Record<string, unknown>>(jws)
      expect(decoded.header.alg).toBe('EdDSA')
      expect(decoded.header.kid).toBe(identity.kid)

      const verified = await verifyJwsWithPublicKey(jws, {
        publicKey: identity.ed25519PublicKey,
        crypto: testCryptoAdapter,
      })
      expect(verified.payload).toEqual(payload)
    })
  })
})
