import { describe, expect, it, vi } from 'vitest'
import {
  createDidKeyResolver,
  encodeBase64Url,
  resolveDidKey,
  verifyJwsByDidResolver,
} from '../src/protocol'
import type { DidResolver, ProtocolCryptoAdapter } from '../src/protocol'

// Generic EdDSA-JWS verify over kid -> DidResolver (Sync 004 / Identity 002).
// VE-4: the payload DID is bound to the kid DID (and to expectedDid if set), so
// a signer for DID A cannot get a payload claiming did:B accepted.

const DID = 'did:key:z6Mki7w5nqgiJ1KecCGzGuxr4hh7aQUjVc2PYSZazGsB6M4r'
const OTHER_DID = 'did:key:z6Mkv1Y7GdtkqFJrVtX8BrXzPkS7mZYmrQu7izBtLqD2aLEj'
const KID = `${DID}#sig-0`

function cryptoWithVerify(verifyEd25519: ProtocolCryptoAdapter['verifyEd25519']): ProtocolCryptoAdapter {
  return {
    verifyEd25519,
    sha256: async () => new Uint8Array(32),
    hkdfSha256: async (_input, _info, length) => new Uint8Array(length),
    x25519PublicFromSeed: async () => new Uint8Array(32),
    x25519SharedSecret: async () => new Uint8Array(32),
    aes256GcmEncrypt: async (_key, _nonce, plaintext) => plaintext,
    aes256GcmDecrypt: async (_key, _nonce, ciphertext) => ciphertext,
    randomBytes: async (length) => new Uint8Array(length),
  }
}

function compactJws(header: Record<string, unknown>, payload: Record<string, unknown>, signature = new Uint8Array([1])): string {
  const enc = new TextEncoder()
  return [
    encodeBase64Url(enc.encode(JSON.stringify(header))),
    encodeBase64Url(enc.encode(JSON.stringify(payload))),
    encodeBase64Url(signature),
  ].join('.')
}

const validHeader = { alg: 'EdDSA', kid: KID }

describe('verifyJwsByDidResolver', () => {
  it('verifies a valid did:key JWS and returns { did, payload }', async () => {
    const jws = compactJws(validHeader, { did: DID, hello: 'world' })
    const result = await verifyJwsByDidResolver(jws, {
      didResolver: createDidKeyResolver(),
      crypto: cryptoWithVerify(async () => true),
    })
    expect(result.did).toBe(DID)
    expect(result.payload).toMatchObject({ did: DID, hello: 'world' })
  })

  it('rejects a non-EdDSA alg', async () => {
    const jws = compactJws({ alg: 'HS256', kid: KID }, { did: DID })
    await expect(
      verifyJwsByDidResolver(jws, { didResolver: createDidKeyResolver(), crypto: cryptoWithVerify(async () => true) }),
    ).rejects.toThrow('Unsupported JWS alg')
  })

  it('rejects a missing kid', async () => {
    const jws = compactJws({ alg: 'EdDSA' }, { did: DID })
    await expect(
      verifyJwsByDidResolver(jws, { didResolver: createDidKeyResolver(), crypto: cryptoWithVerify(async () => true) }),
    ).rejects.toThrow('Missing JWS kid')
  })

  it('rejects when kid DID does not match expectedDid', async () => {
    const jws = compactJws(validHeader, { did: DID })
    await expect(
      verifyJwsByDidResolver(jws, {
        expectedDid: OTHER_DID,
        didResolver: createDidKeyResolver(),
        crypto: cryptoWithVerify(async () => true),
      }),
    ).rejects.toThrow('JWS kid DID does not match expected DID')
  })

  it('rejects when the DID cannot be resolved', async () => {
    const nullResolver: DidResolver = { resolve: async () => null }
    const jws = compactJws(validHeader, { did: DID })
    await expect(
      verifyJwsByDidResolver(jws, { didResolver: nullResolver, crypto: cryptoWithVerify(async () => true) }),
    ).rejects.toThrow('Unable to resolve DID')
  })

  it('rejects an invalid signature', async () => {
    const jws = compactJws(validHeader, { did: DID })
    await expect(
      verifyJwsByDidResolver(jws, { didResolver: createDidKeyResolver(), crypto: cryptoWithVerify(async () => false) }),
    ).rejects.toThrow('Invalid JWS signature')
  })

  it('uses the injected crypto adapter (DI), not a module singleton', async () => {
    const verify = vi.fn(async () => true)
    const jws = compactJws(validHeader, { did: DID })
    await verifyJwsByDidResolver(jws, { didResolver: createDidKeyResolver(), crypto: cryptoWithVerify(verify) })
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('rejects a payload missing the DID (VE-4)', async () => {
    const jws = compactJws(validHeader, { hello: 'world' })
    await expect(
      verifyJwsByDidResolver(jws, { didResolver: createDidKeyResolver(), crypto: cryptoWithVerify(async () => true) }),
    ).rejects.toThrow('Missing payload DID')
  })

  it('rejects a cross-DID payload: kid DID A, payload.did B (VE-4)', async () => {
    // Even with a "valid" signature and no expectedDid, a payload claiming a
    // different DID than the kid must be rejected.
    const jws = compactJws(validHeader, { did: OTHER_DID, hello: 'world' })
    await expect(
      verifyJwsByDidResolver(jws, { didResolver: createDidKeyResolver(), crypto: cryptoWithVerify(async () => true) }),
    ).rejects.toThrow('JWS payload DID does not match kid DID')
  })

  it('rejects a resolved DID document whose id does not match the kid DID', async () => {
    // A buggy/misconfigured resolver returns a foreign document whose
    // verificationMethod happens to match the kid — must be rejected.
    const foreignDoc = { ...resolveDidKey(DID), id: OTHER_DID }
    const badResolver: DidResolver = { resolve: async () => foreignDoc }
    const jws = compactJws(validHeader, { did: DID })
    await expect(
      verifyJwsByDidResolver(jws, { didResolver: badResolver, crypto: cryptoWithVerify(async () => true) }),
    ).rejects.toThrow('does not match')
  })
})
