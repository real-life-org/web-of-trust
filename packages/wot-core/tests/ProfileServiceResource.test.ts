import { describe, expect, it } from 'vitest'
import {
  createDidKeyResolver,
  createJcsEd25519JwsWithSigner,
  decideProfileResourcePutAcceptance,
  didKeyToPublicKeyBytes,
  detectProfileResourceRollback,
  encodeBase64Url,
  resolveDidKey,
  validateProfileServiceResourcePayload,
  verifyProfileServiceResourceJws,
} from '../src/protocol'
import type { DidDocument, ProtocolCryptoAdapter, ProfileServiceResourcePayload } from '../src/protocol'

const DID = 'did:key:z6Mki7w5nqgiJ1KecCGzGuxr4hh7aQUjVc2PYSZazGsB6M4r'
const OTHER_DID = 'did:key:z6Mkv1Y7GdtkqFJrVtX8BrXzPkS7mZYmrQu7izBtLqD2aLEj'
const UPDATED_AT = '2026-04-23T10:00:00Z'

function validPayload(overrides: Partial<ProfileServiceResourcePayload> = {}): ProfileServiceResourcePayload {
  return {
    did: DID,
    version: 3,
    didDocument: didDocument(DID),
    profile: {
      name: 'Alice',
      bio: 'Neighborhood garden',
      protocols: ['https://web-of-trust.de/protocols/attestation/1.0'],
      publicNickname: 'alice-garden',
    },
    updatedAt: UPDATED_AT,
    ...overrides,
  }
}

function didDocument(did: string): DidDocument {
  return {
    ...resolveDidKey(did),
    keyAgreement: [
      {
        id: '#enc-0',
        type: 'X25519KeyAgreementKey2020',
        controller: did,
        publicKeyMultibase: 'z6LSgCwVwNShkpgfYQ1Hz3bkSXpSWUBNRssPrRZVa1RrXstD',
      },
    ],
    service: [
      {
        id: '#inbox',
        type: 'WoTInbox',
        serviceEndpoint: 'wss://broker.example.com',
      },
    ],
  }
}

function cryptoWithVerify(
  verifyEd25519: ProtocolCryptoAdapter['verifyEd25519'],
): ProtocolCryptoAdapter {
  return {
    verifyEd25519,
    sha256: async () => new Uint8Array(32),
    hkdfSha256: async (_input, _info, length) => new Uint8Array(length),
    x25519PublicFromSeed: async () => new Uint8Array(32),
    x25519SharedSecret: async () => new Uint8Array(32),
    aes256GcmEncrypt: async (_key, _nonce, plaintext) => plaintext,
    aes256GcmDecrypt: async (_key, _nonce, ciphertext) => ciphertext,
  }
}

function compactJws(header: Record<string, unknown>, payload: Record<string, unknown>, signature = new Uint8Array([1])): string {
  const textEncoder = new TextEncoder()
  return [
    encodeBase64Url(textEncoder.encode(JSON.stringify(header))),
    encodeBase64Url(textEncoder.encode(JSON.stringify(payload))),
    encodeBase64Url(signature),
  ].join('.')
}

describe('Sync 004 profile-service profile resource', () => {
  it('accepts a valid /p/{did} profile resource payload and preserves opaque public metadata', () => {
    const payload = validPayload()

    expect(validateProfileServiceResourcePayload(payload, { expectedDid: DID })).toEqual(payload)
  })

  it('rejects payload DID mismatch with the /p/{did} path DID', () => {
    expect(() =>
      validateProfileServiceResourcePayload(validPayload({ did: OTHER_DID }), { expectedDid: DID }),
    ).toThrow('Profile resource DID does not match path DID')
  })

  it('rejects DID document mismatch with the payload DID', () => {
    expect(() =>
      validateProfileServiceResourcePayload(
        validPayload({ didDocument: didDocument(OTHER_DID) }),
        { expectedDid: DID },
      ),
    ).toThrow('Profile resource DID document id does not match payload DID')
  })

  it('rejects structurally invalid DID documents', () => {
    expect(() =>
      validateProfileServiceResourcePayload(
        validPayload({ didDocument: { id: DID } as DidDocument }),
        { expectedDid: DID },
      ),
    ).toThrow('Invalid profile resource DID document')
  })

  it('rejects missing, fractional, or negative versions', () => {
    expect(() =>
      validateProfileServiceResourcePayload({ ...validPayload(), version: undefined } as unknown, { expectedDid: DID }),
    ).toThrow('Invalid profile resource version')
    expect(() =>
      validateProfileServiceResourcePayload(validPayload({ version: 1.5 }), { expectedDid: DID }),
    ).toThrow('Invalid profile resource version')
    expect(() =>
      validateProfileServiceResourcePayload(validPayload({ version: -1 }), { expectedDid: DID }),
    ).toThrow('Invalid profile resource version')
  })

  it('rejects missing or empty profile names', () => {
    expect(() =>
      validateProfileServiceResourcePayload(
        { ...validPayload(), profile: undefined },
        { expectedDid: DID },
      ),
    ).toThrow('Invalid profile resource profile metadata')
    expect(() =>
      validateProfileServiceResourcePayload(
        validPayload({ profile: {} as ProfileServiceResourcePayload['profile'] }),
        { expectedDid: DID },
      ),
    ).toThrow('Invalid profile resource profile name')
    expect(() =>
      validateProfileServiceResourcePayload(validPayload({ profile: { name: '' } }), { expectedDid: DID }),
    ).toThrow('Invalid profile resource profile name')
  })

  it('rejects forbidden profile encryptionPublicKey metadata', () => {
    expect(() =>
      validateProfileServiceResourcePayload(
        validPayload({ profile: { name: 'Alice', encryptionPublicKey: 'legacy-key-material' } }),
        { expectedDid: DID },
      ),
    ).toThrow('Profile resource profile metadata must not contain encryptionPublicKey')
  })

  it('makes deterministic server PUT version decisions', () => {
    expect(decideProfileResourcePutAcceptance({ incomingVersion: 0 })).toEqual({ accept: true })
    expect(decideProfileResourcePutAcceptance({ incomingVersion: 4, storedVersion: 3 })).toEqual({ accept: true })
    expect(decideProfileResourcePutAcceptance({ incomingVersion: 3, storedVersion: 3 })).toEqual({
      accept: false,
      conflictVersion: 3,
    })
    expect(decideProfileResourcePutAcceptance({ incomingVersion: 2, storedVersion: 3 })).toEqual({
      accept: false,
      conflictVersion: 3,
    })
  })

  it('detects client rollback only when fetched version is lower than the last seen version', () => {
    expect(detectProfileResourceRollback({ fetchedVersion: 7 })).toBe(false)
    expect(detectProfileResourceRollback({ fetchedVersion: 7, lastSeenVersion: 7 })).toBe(false)
    expect(detectProfileResourceRollback({ fetchedVersion: 8, lastSeenVersion: 7 })).toBe(false)
    expect(detectProfileResourceRollback({ fetchedVersion: 6, lastSeenVersion: 7 })).toBe(true)
  })

  it('verifies compact EdDSA JWS through DID resolution and the exact received signing input', async () => {
    let receivedSigningInput: Uint8Array | undefined
    let receivedPublicKey: Uint8Array | undefined
    const jws = await createJcsEd25519JwsWithSigner(
      { alg: 'EdDSA', kid: `${DID}#sig-0` },
      validPayload(),
      async () => new Uint8Array([1, 2, 3]),
    )
    const expectedSigningInput = new TextEncoder().encode(jws.split('.').slice(0, 2).join('.'))

    const result = await verifyProfileServiceResourceJws(jws, {
      expectedDid: DID,
      didResolver: createDidKeyResolver(),
      crypto: cryptoWithVerify(async (input, _signature, publicKey) => {
        receivedSigningInput = input
        receivedPublicKey = publicKey
        return true
      }),
    })

    expect(result).toEqual(validPayload())
    expect(receivedSigningInput).toEqual(expectedSigningInput)
    expect(receivedPublicKey).toEqual(didKeyToPublicKeyBytes(DID))
  })

  it('rejects malformed DID documents returned by DID resolution deterministically', async () => {
    const jws = await createJcsEd25519JwsWithSigner(
      { alg: 'EdDSA', kid: `${DID}#sig-0` },
      validPayload(),
      async () => new Uint8Array([1, 2, 3]),
    )

    await expect(
      verifyProfileServiceResourceJws(jws, {
        expectedDid: DID,
        didResolver: {
          async resolve() {
            return { id: DID } as DidDocument
          },
        },
        crypto: cryptoWithVerify(async () => true),
      }),
    ).rejects.toThrow('Invalid resolved profile resource DID document')
  })

  it('rejects invalid generic WoT JWS boundaries without requiring a profile-service typ', async () => {
    const didResolver = createDidKeyResolver()
    const crypto = cryptoWithVerify(async () => true)

    await expect(
      verifyProfileServiceResourceJws('not-a-jws', { expectedDid: DID, didResolver, crypto }),
    ).rejects.toThrow('Invalid JWS compact serialization')
    await expect(
      verifyProfileServiceResourceJws(
        compactJws({ alg: 'ES256', kid: `${DID}#sig-0` }, validPayload()),
        { expectedDid: DID, didResolver, crypto },
      ),
    ).rejects.toThrow('Unsupported JWS alg')
    await expect(
      verifyProfileServiceResourceJws(compactJws({ alg: 'EdDSA' }, validPayload()), {
        expectedDid: DID,
        didResolver,
        crypto,
      }),
    ).rejects.toThrow('Missing JWS kid')
  })
})
