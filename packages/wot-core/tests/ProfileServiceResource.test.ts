import { describe, expect, it } from 'vitest'
import {
  createDidKeyResolver,
  createJcsEd25519JwsWithSigner,
  decideProfileResourcePutAcceptance,
  didKeyToPublicKeyBytes,
  detectProfileResourceRollback,
  encodeBase64Url,
  validateProfileServiceListResourcePayload,
  resolveDidKey,
  validateProfileServiceResourcePayload,
  verifyProfileServiceResourceJws,
} from '../src/protocol'
import type {
  DidDocument,
  ProfileServiceListResourcePayload,
  ProtocolCryptoAdapter,
  ProfileServiceResourcePayload,
} from '../src/protocol'

const DID = 'did:key:z6Mki7w5nqgiJ1KecCGzGuxr4hh7aQUjVc2PYSZazGsB6M4r'
const OTHER_DID = 'did:key:z6Mkv1Y7GdtkqFJrVtX8BrXzPkS7mZYmrQu7izBtLqD2aLEj'
const UPDATED_AT = '2026-04-23T10:00:00Z'

type VerificationListPayload = Extract<ProfileServiceListResourcePayload, { verifications: string[] }>
type AttestationListPayload = Extract<ProfileServiceListResourcePayload, { attestations: string[] }>

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

  it('tolerates unknown top-level resource fields pending profile-service additional-properties clarification', () => {
    expect(() =>
      validateProfileServiceResourcePayload(
        { ...validPayload(), futureField: 'not-yet-schema-owned' },
        { expectedDid: DID },
      ),
    ).not.toThrow()
  })

  it('rejects structurally invalid DID documents', () => {
    expect(() =>
      validateProfileServiceResourcePayload(
        validPayload({ didDocument: { id: DID } as DidDocument }),
        { expectedDid: DID },
      ),
    ).toThrow('Invalid profile resource DID document')
  })

  it('rejects invalid updatedAt date-time values', () => {
    expect(() =>
      validateProfileServiceResourcePayload(validPayload({ updatedAt: '2026-04-23' }), { expectedDid: DID }),
    ).toThrow('Invalid profile resource updatedAt')
    expect(() =>
      validateProfileServiceResourcePayload(validPayload({ updatedAt: 'not-a-date' }), { expectedDid: DID }),
    ).toThrow('Invalid profile resource updatedAt')
  })

  it('rejects missing, fractional, negative, or unsafe versions', () => {
    expect(() =>
      validateProfileServiceResourcePayload({ ...validPayload(), version: undefined } as unknown, { expectedDid: DID }),
    ).toThrow('Invalid profile resource version')
    expect(() =>
      validateProfileServiceResourcePayload(validPayload({ version: 1.5 }), { expectedDid: DID }),
    ).toThrow('Invalid profile resource version')
    expect(() =>
      validateProfileServiceResourcePayload(validPayload({ version: -1 }), { expectedDid: DID }),
    ).toThrow('Invalid profile resource version')
    expect(() =>
      validateProfileServiceResourcePayload(validPayload({ version: Number.MAX_SAFE_INTEGER + 1 }), { expectedDid: DID }),
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

  it('verifies compact EdDSA JWS with absolute DID verification method ids', async () => {
    const resolvedDocument = didDocument(DID)
    resolvedDocument.verificationMethod = resolvedDocument.verificationMethod.map((method) => ({
      ...method,
      id: `${DID}${method.id}`,
    }))
    resolvedDocument.authentication = [`${DID}#sig-0`]
    resolvedDocument.assertionMethod = [`${DID}#sig-0`]
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
            return resolvedDocument
          },
        },
        crypto: cryptoWithVerify(async () => true),
      }),
    ).resolves.toEqual(validPayload())
  })

  it('rejects JWS payloads whose DID does not match the requested /p/{did}', async () => {
    const jws = await createJcsEd25519JwsWithSigner(
      { alg: 'EdDSA', kid: `${OTHER_DID}#sig-0` },
      validPayload({ did: OTHER_DID, didDocument: didDocument(OTHER_DID) }),
      async () => new Uint8Array([1, 2, 3]),
    )

    await expect(
      verifyProfileServiceResourceJws(jws, {
        expectedDid: DID,
        didResolver: createDidKeyResolver(),
        crypto: cryptoWithVerify(async () => true),
      }),
    ).rejects.toThrow('Profile resource DID does not match path DID')
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

  it('rejects unresolved or mismatched DID resolution deterministically', async () => {
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
            return null
          },
        },
        crypto: cryptoWithVerify(async () => true),
      }),
    ).rejects.toThrow('Unable to resolve profile resource DID')
    await expect(
      verifyProfileServiceResourceJws(jws, {
        expectedDid: DID,
        didResolver: {
          async resolve() {
            return didDocument(OTHER_DID)
          },
        },
        crypto: cryptoWithVerify(async () => true),
      }),
    ).rejects.toThrow('Resolved profile resource DID document id does not match resolved DID')
  })

  it('rejects missing verification methods and invalid signatures', async () => {
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
            return { ...didDocument(DID), verificationMethod: [] }
          },
        },
        crypto: cryptoWithVerify(async () => true),
      }),
    ).rejects.toThrow('Unable to resolve profile resource verification method')
    await expect(
      verifyProfileServiceResourceJws(jws, {
        expectedDid: DID,
        didResolver: createDidKeyResolver(),
        crypto: cryptoWithVerify(async () => false),
      }),
    ).rejects.toThrow('Invalid JWS signature')
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
    await expect(
      verifyProfileServiceResourceJws(compactJws({ alg: 'EdDSA', kid: '' }, validPayload()), {
        expectedDid: DID,
        didResolver,
        crypto,
      }),
    ).rejects.toThrow('Missing JWS kid')
    await expect(
      verifyProfileServiceResourceJws(
        compactJws({ alg: 'EdDSA', kid: `${OTHER_DID}#sig-0` }, validPayload()),
        { expectedDid: DID, didResolver, crypto },
      ),
    ).rejects.toThrow('Profile service resource JWS kid DID does not match payload DID')
  })
})

describe('Sync 004 profile-service list resources', () => {
  function verificationListPayload(
    overrides: Partial<Omit<VerificationListPayload, 'attestations'>> = {},
  ): VerificationListPayload {
    return {
      did: DID,
      version: 5,
      verifications: [
        'eyJhbGciOiJFZERTQSIsImtpZCI6ImRpZDprZXk6ejZNa2k3dzVucWdpSjFLZWNDR3pHdXhyNGhoN2FRVWpWYzJQWVNaYXpHc0I2TTRyI3NpZy0wIn0.eyJ2YyI6InZlcmlmaWNhdGlvbiJ9.AQID',
      ],
      updatedAt: UPDATED_AT,
      ...overrides,
    }
  }

  function attestationListPayload(
    overrides: Partial<Omit<AttestationListPayload, 'verifications'>> = {},
  ): AttestationListPayload {
    return {
      did: DID,
      version: 12,
      attestations: [
        'eyJhbGciOiJFZERTQSIsImtpZCI6ImRpZDprZXk6ejZNa2k3dzVucWdpSjFLZWNDR3pHdXhyNGhoN2FRVWpWYzJQWVNaYXpHc0I2TTRyI3NpZy0wIn0.eyJ2YyI6ImF0dGVzdGF0aW9uIn0.BAUG',
      ],
      updatedAt: UPDATED_AT,
      ...overrides,
    }
  }

  it('accepts valid /p/{did}/v and /p/{did}/a list-resource payloads', () => {
    expect(
      validateProfileServiceListResourcePayload(verificationListPayload(), {
        expectedDid: DID,
        resourceKind: 'verifications',
      }),
    ).toEqual(verificationListPayload())
    expect(
      validateProfileServiceListResourcePayload(attestationListPayload(), {
        expectedDid: DID,
        resourceKind: 'attestations',
      }),
    ).toEqual(attestationListPayload())
  })

  it('rejects wrong-kind, missing-list, and both-list payloads', () => {
    const publishedAttestationJws =
      'eyJhbGciOiJFZERTQSIsImtpZCI6ImRpZDprZXk6ejZNa2k3dzVucWdpSjFLZWNDR3pHdXhyNGhoN2FRVWpWYzJQWVNaYXpHc0I2TTRyI3NpZy0wIn0.eyJ2YyI6InB1Ymxpc2hlZC1hdHRlc3RhdGlvbiJ9.BwgJ'
    const missingVerificationList: Record<string, unknown> = { ...verificationListPayload() }
    delete missingVerificationList.verifications

    expect(() =>
      validateProfileServiceListResourcePayload(verificationListPayload(), {
        expectedDid: DID,
        resourceKind: 'attestations',
      }),
    ).toThrow('Profile service list resource kind does not match payload list field')
    expect(() =>
      validateProfileServiceListResourcePayload(missingVerificationList, {
        expectedDid: DID,
        resourceKind: 'verifications',
      }),
    ).toThrow('Profile service list resource must contain exactly one list field')
    expect(() =>
      validateProfileServiceListResourcePayload(
        { ...verificationListPayload(), attestations: [publishedAttestationJws] },
        {
          expectedDid: DID,
          resourceKind: 'verifications',
        },
      ),
    ).toThrow('Profile service list resource must contain exactly one list field')
    expect(() =>
      validateProfileServiceListResourcePayload(
        { ...verificationListPayload(), attestations: 'oops' },
        {
          expectedDid: DID,
          resourceKind: 'verifications',
        },
      ),
    ).toThrow('Profile service list resource must contain exactly one list field')
  })

  it('rejects profile-resource fields and non-string list entries', () => {
    expect(() =>
      validateProfileServiceListResourcePayload(
        { ...verificationListPayload(), didDocument: didDocument(DID) },
        {
          expectedDid: DID,
          resourceKind: 'verifications',
        },
      ),
    ).toThrow('Profile service list resource must not contain didDocument or profile')
    expect(() =>
      validateProfileServiceListResourcePayload(
        { ...attestationListPayload(), profile: { name: 'Alice' } },
        {
          expectedDid: DID,
          resourceKind: 'attestations',
        },
      ),
    ).toThrow('Profile service list resource must not contain didDocument or profile')
    expect(() =>
      validateProfileServiceListResourcePayload(
        { ...verificationListPayload(), verifications: ['valid.compact.jws', 12] },
        {
          expectedDid: DID,
          resourceKind: 'verifications',
        },
      ),
    ).toThrow('Profile service list resource entries must be compact JWS strings')
  })

  it('rejects DID/path mismatches and invalid list-resource versions', () => {
    expect(() =>
      validateProfileServiceListResourcePayload(verificationListPayload({ did: OTHER_DID }), {
        expectedDid: DID,
        resourceKind: 'verifications',
      }),
    ).toThrow('Profile service list resource DID does not match path DID')
    expect(() =>
      validateProfileServiceListResourcePayload(verificationListPayload({ version: -1 }), {
        expectedDid: DID,
        resourceKind: 'verifications',
      }),
    ).toThrow('Invalid profile service list resource version')
    expect(() =>
      validateProfileServiceListResourcePayload(attestationListPayload({ version: 1.5 }), {
        expectedDid: DID,
        resourceKind: 'attestations',
      }),
    ).toThrow('Invalid profile service list resource version')
  })

  it('reuses independent per-resource version acceptance and rollback helpers', () => {
    expect(decideProfileResourcePutAcceptance({ incomingVersion: 2, storedVersion: 1 })).toEqual({ accept: true })
    expect(decideProfileResourcePutAcceptance({ incomingVersion: 1, storedVersion: 2 })).toEqual({
      accept: false,
      conflictVersion: 2,
    })
    expect(detectProfileResourceRollback({ fetchedVersion: 4, lastSeenVersion: 5 })).toBe(true)
    expect(detectProfileResourceRollback({ fetchedVersion: 5, lastSeenVersion: 5 })).toBe(false)
  })

  it('verifies compact EdDSA JWS over caller-selected list-resource payloads', async () => {
    let receivedSigningInput: Uint8Array | undefined
    const jws = await createJcsEd25519JwsWithSigner(
      { alg: 'EdDSA', kid: `${DID}#sig-0` },
      verificationListPayload(),
      async () => new Uint8Array([1, 2, 3]),
    )
    const expectedSigningInput = new TextEncoder().encode(jws.split('.').slice(0, 2).join('.'))

    const result = await verifyProfileServiceResourceJws(jws, {
      expectedDid: DID,
      resourceKind: 'verifications',
      didResolver: createDidKeyResolver(),
      crypto: cryptoWithVerify(async (input) => {
        receivedSigningInput = input
        return true
      }),
    })

    expect(result).toEqual(verificationListPayload())
    expect(receivedSigningInput).toEqual(expectedSigningInput)
  })
})
