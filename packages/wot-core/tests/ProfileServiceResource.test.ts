import { readFileSync } from 'node:fs'
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
  verifyAttestationVcJws,
  verifyProfileServiceResourceJws,
} from '../src/protocol'
import type {
  DidDocument,
  ProfileServiceListResourcePayload,
  ProtocolCryptoAdapter,
  ProfileServiceResourcePayload,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'

function loadSpecVector(relativePath: string): any {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')

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
    randomBytes: async (length) => new Uint8Array(length),
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

  it('rejects calendar-invalid dates that JS Date would silently normalize', () => {
    // JS would happily turn `2026-02-31T00:00:00Z` into `2026-03-03T00:00:00Z`,
    // which is the bug Eli's loop-review flagged on PR #66. The validator must
    // reject these so the `updatedAt` field actually means what it says.
    const cases = [
      '2026-02-31T00:00:00Z', // Feb has 28/29 days, never 31
      '2025-02-29T00:00:00Z', // 2025 is not a leap year
      '2026-04-31T00:00:00Z', // April has 30 days
      '2026-13-01T00:00:00Z', // month 13
      '2026-01-32T00:00:00Z', // day 32
      '2026-01-01T24:00:00Z', // hour 24
      '2026-01-01T00:60:00Z', // minute 60
      '2026-01-01T00:00:60Z', // leap second :60 — explicitly rejected (see validator)
      // Timezone offset bounds. RFC3339 §5.6: hour 0-23, minute 0-59.
      // The regex shape `[+-]\d{2}:\d{2}` alone would let these through.
      '2026-06-15T12:30:45+24:00', // offset hour 24
      '2026-06-15T12:30:45-25:00', // offset hour 25 (negative direction)
      '2026-06-15T12:30:45+02:60', // offset minute 60
      '2026-06-15T12:30:45+99:99', // both out of range
    ]
    for (const updatedAt of cases) {
      expect(
        () => validateProfileServiceResourcePayload(validPayload({ updatedAt }), { expectedDid: DID }),
        `expected ${updatedAt} to be rejected`,
      ).toThrow('Invalid profile resource updatedAt')
    }
  })

  it('accepts calendar-valid dates including leap days and timezone offsets', () => {
    const cases = [
      '2024-02-29T00:00:00Z', // 2024 is a leap year
      '2026-12-31T23:59:59Z',
      '2026-06-15T12:30:45.123Z',
      '2026-06-15T12:30:45+02:00',
      '2026-06-15T12:30:45-05:30',
    ]
    for (const updatedAt of cases) {
      expect(
        () => validateProfileServiceResourcePayload(validPayload({ updatedAt }), { expectedDid: DID }),
        `expected ${updatedAt} to be accepted`,
      ).not.toThrow()
    }
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
    expect(() =>
      validateProfileServiceListResourcePayload({ ...verificationListPayload(), version: undefined }, {
        expectedDid: DID,
        resourceKind: 'verifications',
      }),
    ).toThrow('Invalid profile service list resource version')
    expect(() =>
      validateProfileServiceListResourcePayload(verificationListPayload({ version: Number.MAX_SAFE_INTEGER + 1 }), {
        expectedDid: DID,
        resourceKind: 'verifications',
      }),
    ).toThrow('Invalid profile service list resource version')
    expect(() =>
      validateProfileServiceListResourcePayload({ ...attestationListPayload(), version: undefined }, {
        expectedDid: DID,
        resourceKind: 'attestations',
      }),
    ).toThrow('Invalid profile service list resource version')
    expect(() =>
      validateProfileServiceListResourcePayload(attestationListPayload({ version: Number.MAX_SAFE_INTEGER + 1 }), {
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

    let receivedAttestationSigningInput: Uint8Array | undefined
    const attestationJws = await createJcsEd25519JwsWithSigner(
      { alg: 'EdDSA', kid: `${DID}#sig-0` },
      attestationListPayload(),
      async () => new Uint8Array([1, 2, 3]),
    )
    const expectedAttestationSigningInput = new TextEncoder().encode(attestationJws.split('.').slice(0, 2).join('.'))

    const attestationResult = await verifyProfileServiceResourceJws(attestationJws, {
      expectedDid: DID,
      resourceKind: 'attestations',
      didResolver: createDidKeyResolver(),
      crypto: cryptoWithVerify(async (input) => {
        receivedAttestationSigningInput = input
        return true
      }),
    })

    expect(attestationResult).toEqual(attestationListPayload())
    expect(receivedAttestationSigningInput).toEqual(expectedAttestationSigningInput)
  })
})

describe('Sync 004 profile-service conformance vectors (wot-spec #102)', () => {
  const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

  it('reproduces the profile_service_put_acceptance server-monotonie vector cases (VE-4)', () => {
    const vector = phase1.profile_service_put_acceptance

    expect(vector.cases.length).toBeGreaterThan(0)
    for (const testCase of vector.cases) {
      const decision = decideProfileResourcePutAcceptance({
        incomingVersion: testCase.new_version,
        storedVersion: testCase.stored_version ?? undefined,
      })

      if (testCase.expected === 'accept') {
        expect(decision, testCase.name).toEqual({ accept: true })
      } else if (testCase.expected === 'conflict') {
        // Sync 004 Z.155-164: 409 Conflict carries the current stored version.
        expect(decision, testCase.name).toEqual({
          accept: false,
          conflictVersion: testCase.stored_version,
        })
      } else {
        throw new Error(`Unexpected put-acceptance expectation: ${testCase.expected}`)
      }
    }
  })

  it('reproduces the profile_service_rollback client-rollback vector cases (VE-3)', () => {
    const vector = phase1.profile_service_rollback

    expect(vector.cases.length).toBeGreaterThan(0)
    for (const testCase of vector.cases) {
      const isRollback = detectProfileResourceRollback({
        fetchedVersion: testCase.fetched_version,
        lastSeenVersion: testCase.last_seen_version ?? undefined,
      })

      if (testCase.expected === 'ok') {
        expect(isRollback, testCase.name).toBe(false)
      } else if (testCase.expected === 'rollback') {
        expect(isRollback, testCase.name).toBe(true)
      } else {
        throw new Error(`Unexpected rollback expectation: ${testCase.expected}`)
      }
    }
  })

  it('recognises the verification_vc_jws WotVerification marker against the spec vector (VE-2/VE-7)', async () => {
    const vector = phase1.verification_vc_jws

    // The marker that splits /v from /a is the WotVerification entry in `type`
    // (Trust 002 / wot-spec #101), not the human-readable claim string.
    expect(vector.payload.type).toContain('WotVerification')
    // Disjoint split invariant: a verification is still a WotAttestation, so the
    // /a resolve path must exclude it precisely on the WotVerification marker.
    expect(vector.payload.type).toContain('WotAttestation')

    // The vector's compact JWS verifies and the verified payload carries the marker,
    // so the type-based predicate that Step 2 centralises (isVerificationAttestation)
    // will match against real, signature-verified vector data — not just the literal.
    const verified = await verifyAttestationVcJws(vector.jws, {
      crypto: protocolCrypto,
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(verified).toEqual(vector.payload)
    expect(verified.type.includes('WotVerification')).toBe(true)
  })
})
