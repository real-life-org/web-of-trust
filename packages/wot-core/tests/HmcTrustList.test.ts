import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeToBytes,
  createJcsEd25519Jws,
  createSdJwtVcCompact,
  decodeJws,
  encodeBase64Url,
  verifyHmcTrustListSdJwtVc,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'
import type { JsonValue } from '../src/protocol'

const phase1 = JSON.parse(readFixture('./fixtures/wot-spec/phase-1-interop.json'))
const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const hmcVector = phase1.sd_jwt_vc_trust_list
const expectedVct = 'https://humanmoney.example/credentials/TrustList/v1'
const verificationTime = new Date('2026-04-22T10:00:00Z')

function readFixture(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const pair = hex.slice(i * 2, i * 2 + 2)
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) throw new Error(`Invalid hex string at byte ${i}`)
    const byte = Number.parseInt(pair, 16)
    bytes[i] = byte
  }
  return bytes
}

function decodedIssuerJwt(): {
  header: Record<string, JsonValue>
  payload: Record<string, JsonValue>
} {
  const decoded = decodeJws(hmcVector.issuer_signed_jwt)
  return {
    header: decoded.header as Record<string, JsonValue>,
    payload: decoded.payload as Record<string, JsonValue>,
  }
}

async function signedTrustListWithPayload(
  mutate: (payload: Record<string, JsonValue>) => void,
): Promise<string> {
  const { header, payload } = decodedIssuerJwt()
  mutate(payload)
  return signedTrustListWithHeaderAndPayload(header, payload)
}

async function signedTrustListWithHeaderAndPayload(
  header: Record<string, JsonValue>,
  payload: Record<string, JsonValue>,
): Promise<string> {
  const issuerSignedJwt = await createJcsEd25519Jws(
    header,
    payload,
    hexToBytes(phase1.identity.ed25519_seed_hex),
  )
  return createSdJwtVcCompact(issuerSignedJwt, [hmcVector.disclosure as JsonValue])
}

function trustListWithHeader(header: Record<string, JsonValue>): string {
  const [, encodedPayload, encodedSignature] = hmcVector.issuer_signed_jwt.split('.')
  if (!encodedPayload || !encodedSignature) throw new Error('Invalid test vector issuer JWS')
  const encodedHeader = encodeBase64Url(canonicalizeToBytes(header))
  return createSdJwtVcCompact(`${encodedHeader}.${encodedPayload}.${encodedSignature}`, [hmcVector.disclosure as JsonValue])
}

describe('HMC H01 SD-JWT VC Trust List verifier', () => {
  it('accepts the phase-1 sd_jwt_vc_trust_list vector with caller-supplied vct and verification time', async () => {
    const verified = await verifyHmcTrustListSdJwtVc(hmcVector.sd_jwt_compact, {
      crypto: cryptoAdapter,
      expectedVct,
      now: verificationTime,
    })

    expect(verified.issuerPayload.vct).toBe(expectedVct)
    expect(verified.issuerKid).toBe(phase1.identity.kid)
    expect(verified.issuerPayload._sd_alg).toBe('sha-256')
    expect(verified.issuerPayload.exp).toBe(1808050800)
    expect(verified.issuerPayload.iat).toBe(1776514800)
    expect(verified.disclosures).toEqual([hmcVector.disclosure])
    expect(verified.disclosureDigests).toEqual([hmcVector.disclosure_digest])
  })

  it('rejects a Trust List whose vct does not match the caller-supplied expected value', async () => {
    await expect(
      verifyHmcTrustListSdJwtVc(hmcVector.sd_jwt_compact, {
        crypto: cryptoAdapter,
        expectedVct: 'https://example.invalid/credentials/OtherTrustList/v1',
        now: verificationTime,
      }),
    ).rejects.toThrow('Invalid HMC Trust List vct')
  })

  it.each([
    {
      name: 'missing',
      mutate: (payload: Record<string, JsonValue>) => {
        delete payload.iss
      },
      error: 'Missing HMC Trust List iss',
    },
    {
      name: 'invalid',
      mutate: (payload: Record<string, JsonValue>) => {
        payload.iss = 42
      },
      error: 'Invalid HMC Trust List iss',
    },
    {
      name: 'mismatched',
      mutate: (payload: Record<string, JsonValue>) => {
        payload.iss = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
      },
      error: 'Invalid HMC Trust List issuer',
    },
    {
      name: 'a DID URL fragment',
      mutate: (payload: Record<string, JsonValue>) => {
        payload.iss = `${phase1.identity.did}#sig-0`
      },
      error: 'Invalid HMC Trust List issuer',
    },
  ])('rejects a Trust List whose iss is $name', async ({ mutate, error }) => {
    const trustList = await signedTrustListWithPayload(mutate)

    await expect(
      verifyHmcTrustListSdJwtVc(trustList, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
    ).rejects.toThrow(error)
  })

  it('rejects missing or unsupported _sd_alg after generic SD-JWT VC verification', async () => {
    const missingSdAlg = await signedTrustListWithPayload((payload) => {
      delete payload._sd_alg
    })
    const wrongSdAlg = await signedTrustListWithPayload((payload) => {
      payload._sd_alg = 'sha-512'
    })

    await expect(
      verifyHmcTrustListSdJwtVc(missingSdAlg, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'missing _sd_alg',
    ).rejects.toThrow('Invalid HMC Trust List _sd_alg')
    await expect(
      verifyHmcTrustListSdJwtVc(wrongSdAlg, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'wrong _sd_alg',
    ).rejects.toThrow('Invalid HMC Trust List _sd_alg')
  })

  it('rejects missing or invalid SD-JWT issuer kid before HMC claim validation', async () => {
    const { header: missingKidHeader } = decodedIssuerJwt()
    delete missingKidHeader.kid
    const { header: invalidKidHeader } = decodedIssuerJwt()
    invalidKidHeader.kid = 42
    const missingKid = trustListWithHeader(missingKidHeader)
    const invalidKid = trustListWithHeader(invalidKidHeader)

    await expect(
      verifyHmcTrustListSdJwtVc(missingKid, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'missing kid',
    ).rejects.toThrow('Missing SD-JWT issuer kid')
    await expect(
      verifyHmcTrustListSdJwtVc(invalidKid, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'invalid kid',
    ).rejects.toThrow('Invalid SD-JWT issuer kid')
  })
  it('rejects missing or expired exp at the injectable verification time', async () => {
    const missingExp = await signedTrustListWithPayload((payload) => {
      delete payload.exp
    })
    const expiredExp = await signedTrustListWithPayload((payload) => {
      payload.exp = 1776851999
    })
    const invalidExp = await signedTrustListWithPayload((payload) => {
      payload.exp = '1776851999'
    })
    const fractionalExp = await signedTrustListWithPayload((payload) => {
      payload.exp = 1776851999.5
    })
    const negativeExp = await signedTrustListWithPayload((payload) => {
      payload.exp = -1
    })
    const expAtVerificationTime = await signedTrustListWithPayload((payload) => {
      payload.exp = 1776852000
    })

    await expect(
      verifyHmcTrustListSdJwtVc(missingExp, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'missing exp',
    ).rejects.toThrow('Missing HMC Trust List exp')
    await expect(
      verifyHmcTrustListSdJwtVc(expiredExp, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'expired exp',
    ).rejects.toThrow('Expired HMC Trust List exp')
    await expect(
      verifyHmcTrustListSdJwtVc(invalidExp, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'invalid exp',
    ).rejects.toThrow('Invalid HMC Trust List exp')
    await expect(
      verifyHmcTrustListSdJwtVc(fractionalExp, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'fractional exp',
    ).rejects.toThrow('Invalid HMC Trust List exp')
    await expect(
      verifyHmcTrustListSdJwtVc(negativeExp, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'negative exp',
    ).rejects.toThrow('Invalid HMC Trust List exp')
    await expect(
      verifyHmcTrustListSdJwtVc(expAtVerificationTime, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'exp equal to verification time',
    ).rejects.toThrow('Expired HMC Trust List exp')
  })

  it('rejects missing or future iat at the injectable verification time', async () => {
    const missingIat = await signedTrustListWithPayload((payload) => {
      delete payload.iat
    })
    const futureIat = await signedTrustListWithPayload((payload) => {
      payload.iat = 1776852001
    })
    const invalidIat = await signedTrustListWithPayload((payload) => {
      payload.iat = '1776852001'
    })
    const fractionalIat = await signedTrustListWithPayload((payload) => {
      payload.iat = 1776852000.5
    })
    const negativeIat = await signedTrustListWithPayload((payload) => {
      payload.iat = -1
    })
    const iatAtVerificationTime = await signedTrustListWithPayload((payload) => {
      payload.iat = 1776852000
    })

    await expect(
      verifyHmcTrustListSdJwtVc(missingIat, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'missing iat',
    ).rejects.toThrow('Missing HMC Trust List iat')
    await expect(
      verifyHmcTrustListSdJwtVc(futureIat, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'future iat',
    ).rejects.toThrow('Future HMC Trust List iat')
    await expect(
      verifyHmcTrustListSdJwtVc(invalidIat, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'invalid iat',
    ).rejects.toThrow('Invalid HMC Trust List iat')
    await expect(
      verifyHmcTrustListSdJwtVc(fractionalIat, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'fractional iat',
    ).rejects.toThrow('Invalid HMC Trust List iat')
    await expect(
      verifyHmcTrustListSdJwtVc(negativeIat, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'negative iat',
    ).rejects.toThrow('Invalid HMC Trust List iat')
    await expect(
      verifyHmcTrustListSdJwtVc(iatAtVerificationTime, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      'iat equal to verification time',
    ).resolves.toBeDefined()
  })

  it('rejects a Trust List whose supplied disclosure digest is not present in any _sd array', async () => {
    const trustList = await signedTrustListWithPayload((payload) => {
      payload.entries = []
    })

    await expect(
      verifyHmcTrustListSdJwtVc(trustList, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
    ).rejects.toThrow('SD-JWT disclosure digest not present')
  })

  it('rejects a Trust List whose disclosure digest appears only in an unrelated string field', async () => {
    const trustList = await signedTrustListWithPayload((payload) => {
      payload.entries = []
      payload.note = hmcVector.disclosure_digest
    })

    await expect(
      verifyHmcTrustListSdJwtVc(trustList, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
    ).rejects.toThrow('SD-JWT disclosure digest not present')
  })

  it('rejects a Trust List whose _sd claim is not an array of strings', async () => {
    const sdAsString = await signedTrustListWithPayload((payload) => {
      payload.entries = [{ _sd: hmcVector.disclosure_digest }]
    })
    const sdAsObject = await signedTrustListWithPayload((payload) => {
      payload.entries = [{ _sd: { digest: hmcVector.disclosure_digest } }]
    })
    const sdWithNonStringElement = await signedTrustListWithPayload((payload) => {
      payload.entries = [{ _sd: [hmcVector.disclosure_digest, 42] }]
    })

    await expect(
      verifyHmcTrustListSdJwtVc(sdAsString, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      '_sd is a string',
    ).rejects.toThrow('Invalid SD-JWT _sd claim')
    await expect(
      verifyHmcTrustListSdJwtVc(sdAsObject, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      '_sd is an object',
    ).rejects.toThrow('Invalid SD-JWT _sd claim')
    await expect(
      verifyHmcTrustListSdJwtVc(sdWithNonStringElement, {
        crypto: cryptoAdapter,
        expectedVct,
        now: verificationTime,
      }),
      '_sd contains a non-string element',
    ).rejects.toThrow('Invalid SD-JWT _sd claim')
  })
})
