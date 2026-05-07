import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeToBytes,
  createDidKeyResolver,
  createAttestationVcJws,
  createDelegatedAttestationBundle,
  createDeviceKeyBindingJws,
  createJcsEd25519Jws,
  createJcsEd25519JwsWithSigner,
  createLogEntryJws,
  createKeyRotationMessage,
  createLogEntryMessage,
  createMemberUpdateMessage,
  decideVerificationAttestationAcceptance,
  createPlaintextMessage,
  LOG_ENTRY_MESSAGE_TYPE,
  createSdJwtVcCompact,
  createSpaceInviteMessage,
  createSpaceCapabilityJws,
  decodeJws,
  decodeBase64Url,
  decryptEcies,
  decryptLogPayload,
  derivePersonalDocFromSeedHex,
  deriveEciesMaterial,
  deriveLogPayloadNonce,
  deriveBip39SeedFromMnemonic,
  deriveProtocolIdentityFromMnemonic,
  deriveSpaceAdminKeyFromSeedHex,
  deriveProtocolIdentityFromSeedHex,
  didKeyToPublicKeyBytes,
  ed25519PublicKeyToMultibase,
  ed25519MultibaseToPublicKeyBytes,
  encodeBase64Url,
  encryptEcies,
  encryptLogPayload,
  encodeSdJwtDisclosure,
  evaluateMemberUpdateDisposition,
  isActiveQrChallengeValid,
  digestSdJwtDisclosure,
  parseQrChallenge,
  verifyAttestationVcJws,
  verifyDelegatedAttestationBundle,
  verifyDeviceKeyBindingJws,
  verifyJwsWithPublicKey,
  verifyLogEntryJws,
  parseKeyRotationMessage,
  parseLogEntryMessage,
  parseMemberUpdateMessage,
  parseSpaceInviteMessage,
  parsePlaintextMessage,
  verifySdJwtVc,
  verifySpaceCapabilityJws,
  resolveDidKey,
  x25519PublicKeyToMultibase,
  x25519MultibaseToPublicKeyBytes,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'
import type { AttestationVcPayload, DidResolver, JsonValue, ProtocolCryptoAdapter } from '../src/protocol'

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')
const deviceDelegation = loadSpecVector('./fixtures/wot-spec/device-delegation.json')
const validQrChallengeExampleJson = loadSpecFixtureText('./fixtures/wot-spec/schemas/examples/valid/qr-challenge.json')
const invalidQrChallengeExampleJson = loadSpecFixtureText('./fixtures/wot-spec/schemas/examples/invalid/qr-challenge.json')
const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

function loadSpecFixtureText(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

function loadSpecVector(relativePath: string): any {
  return JSON.parse(loadSpecFixtureText(relativePath))
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

const trust002Challenge = {
  did: phase1.identity.did,
  name: 'Alice',
  enc: phase1.identity.x25519_public_b64,
  nonce: '550e8400-e29b-41d4-a716-446655440000',
  ts: '2026-04-22T10:00:00Z',
  broker: 'wss://broker.example.com',
}

function verificationAttestationPayload(overrides: Partial<AttestationVcPayload> = {}): AttestationVcPayload {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://web-of-trust.de/vocab/v1'],
    type: ['VerifiableCredential', 'WotAttestation'],
    issuer: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
    credentialSubject: {
      id: trust002Challenge.did,
      claim: 'in-person verifiziert',
    },
    validFrom: '2026-04-22T10:01:00Z',
    iss: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
    sub: trust002Challenge.did,
    nbf: 1776852060,
    jti: `urn:uuid:ver-${trust002Challenge.nonce}-bob`,
    ...overrides,
  } satisfies AttestationVcPayload
}

async function createSignedAttestationPayload(payload: Record<string, unknown>): Promise<string> {
  return createAttestationVcJws({
    payload: payload as unknown as AttestationVcPayload,
    kid: phase1.attestation_vc_jws.header.kid,
    signingSeed: hexToBytes(phase1.identity.ed25519_seed_hex),
  })
}

function textToBase64Url(text: string): string {
  return encodeBase64Url(new TextEncoder().encode(text))
}

function cryptoWithVerify(
  verifyEd25519: ProtocolCryptoAdapter['verifyEd25519'],
): ProtocolCryptoAdapter {
  return {
    verifyEd25519,
    sha256: cryptoAdapter.sha256.bind(cryptoAdapter),
    hkdfSha256: cryptoAdapter.hkdfSha256.bind(cryptoAdapter),
    x25519PublicFromSeed: cryptoAdapter.x25519PublicFromSeed.bind(cryptoAdapter),
    x25519SharedSecret: cryptoAdapter.x25519SharedSecret.bind(cryptoAdapter),
    aes256GcmEncrypt: cryptoAdapter.aes256GcmEncrypt.bind(cryptoAdapter),
    aes256GcmDecrypt: cryptoAdapter.aes256GcmDecrypt.bind(cryptoAdapter),
  }
}

function cryptoWithSharedSecret(sharedSecret: Uint8Array): ProtocolCryptoAdapter {
  return {
    ...cryptoWithVerify(cryptoAdapter.verifyEd25519.bind(cryptoAdapter)),
    x25519SharedSecret: async () => sharedSecret,
  }
}

describe('WoT protocol interop vectors', () => {
  it('resolves bare did:key through the protocol DidResolver surface', async () => {
    const resolver: DidResolver = createDidKeyResolver()

    await expect(resolver.resolve('did:webvh:example.com:alice')).resolves.toBeNull()
    await expect(resolver.resolve('did:key:z0')).resolves.toBeNull()
    await expect(resolver.resolve(`did:key:${phase1.identity.x25519_public_multibase}`)).resolves.toBeNull()
    await expect(resolver.resolve(`${phase1.identity.did}#sig-0`)).resolves.toBeNull()
    expect(() => ed25519PublicKeyToMultibase(new Uint8Array(31))).toThrow('Expected 32-byte Ed25519 public key')
    expect(() => x25519PublicKeyToMultibase(new Uint8Array(31))).toThrow('Expected 32-byte X25519 public key')
    expect(() => didKeyToPublicKeyBytes('did:key:z0')).toThrow('Invalid base58 character: 0')
    expect(() => ed25519MultibaseToPublicKeyBytes('m0')).toThrow('Expected base58btc multibase key')
    expect(() => ed25519MultibaseToPublicKeyBytes(phase1.identity.x25519_public_multibase)).toThrow(
      'Expected Ed25519 multibase key',
    )
    expect(() =>
      x25519MultibaseToPublicKeyBytes(phase1.did_resolution.did_document.verificationMethod[0].publicKeyMultibase),
    ).toThrow('Expected X25519 multibase key')

    const bareDidDocument = resolveDidKey(phase1.identity.did)
    expect(resolveDidKey(phase1.identity.did, { service: [] })).not.toHaveProperty('service')
    const didDocument = await resolver.resolve(phase1.identity.did)
    expect(bareDidDocument).toEqual(didDocument)
    expect(didDocument).toEqual({
      id: phase1.identity.did,
      verificationMethod: phase1.did_resolution.did_document.verificationMethod,
      authentication: ['#sig-0'],
      assertionMethod: ['#sig-0'],
      keyAgreement: [],
    })
  })

  it('preserves enriched did:key DID document vector parity with keyAgreement and service input', async () => {
    const keyAgreement = phase1.did_resolution.did_document.keyAgreement.map((entry: any) => ({ ...entry }))
    const service = phase1.did_resolution.did_document.service.map((entry: any) => ({ ...entry }))
    const resolver: DidResolver = createDidKeyResolver({
      [phase1.identity.did]: {
        keyAgreement,
        service,
      },
    })
    keyAgreement[0].id = '#mutated-input'
    service[0].serviceEndpoint = 'wss://mutated.example.com'

    const didDocument = await resolver.resolve(phase1.identity.did)
    if (didDocument === null) throw new Error('Expected did:key DID document')
    const didDocumentHash = await cryptoAdapter.sha256(canonicalizeToBytes(didDocument as unknown as JsonValue))

    expect(didDocument).toEqual(phase1.did_resolution.did_document)
    expect(didDocument?.keyAgreement).toEqual([
      {
        id: '#enc-0',
        type: 'X25519KeyAgreementKey2020',
        controller: phase1.identity.did,
        publicKeyMultibase: phase1.identity.x25519_public_multibase,
      },
    ])
    expect(didDocument?.service).toEqual([
      {
        id: '#inbox',
        type: 'WoTInbox',
        serviceEndpoint: 'wss://broker.example.com',
      },
    ])
    expect(bytesToHex(didDocumentHash)).toBe(phase1.did_resolution.jcs_sha256)

    didDocument.keyAgreement[0].id = '#mutated-output'
    if (didDocument.service) didDocument.service[0].serviceEndpoint = 'wss://mutated-output.example.com'
    const didDocumentAgain = await resolver.resolve(phase1.identity.did)
    expect(didDocumentAgain?.keyAgreement).toEqual(phase1.did_resolution.did_document.keyAgreement)
    expect(didDocumentAgain?.service).toEqual(phase1.did_resolution.did_document.service)
  })

  it('derives identity material from the phase-1 vector', async () => {
    const identity = await deriveProtocolIdentityFromSeedHex(phase1.identity.bip39_seed_hex, cryptoAdapter)

    expect(bytesToHex(identity.ed25519Seed)).toBe(phase1.identity.ed25519_seed_hex)
    expect(bytesToHex(identity.ed25519PublicKey)).toBe(phase1.identity.ed25519_public_hex)
    expect(identity.did).toBe(phase1.identity.did)
    expect(identity.kid).toBe(phase1.identity.kid)
    expect(ed25519PublicKeyToMultibase(identity.ed25519PublicKey)).toBe(
      phase1.did_resolution.did_document.verificationMethod[0].publicKeyMultibase,
    )
    expect(bytesToHex(identity.x25519Seed)).toBe(phase1.identity.x25519_seed_hex)
    expect(bytesToHex(identity.x25519PublicKey)).toBe(phase1.identity.x25519_public_hex)
    expect(x25519PublicKeyToMultibase(identity.x25519PublicKey)).toBe(phase1.identity.x25519_public_multibase)

    const resolver = createDidKeyResolver({
      [phase1.identity.did]: {
        keyAgreement: phase1.did_resolution.did_document.keyAgreement,
        service: phase1.did_resolution.did_document.service,
      },
    })
    const didDocument = await resolver.resolve(phase1.identity.did)
    if (didDocument === null) throw new Error('Expected did:key DID document')
    const didDocumentHash = await cryptoAdapter.sha256(canonicalizeToBytes(didDocument as unknown as JsonValue))
    expect(didDocument).toEqual(phase1.did_resolution.did_document)
    expect(bytesToHex(didDocumentHash)).toBe(phase1.did_resolution.jcs_sha256)
  })

  it('derives the full BIP39 seed from the phase-1 English mnemonic', async () => {
    const seed = await deriveBip39SeedFromMnemonic(phase1.identity.mnemonic)

    expect(seed).toHaveLength(64)
    expect(bytesToHex(seed)).toBe(phase1.identity.bip39_seed_hex)
  })

  it('derives identity material from the phase-1 mnemonic through the full-seed path', async () => {
    const fromMnemonic = await deriveProtocolIdentityFromMnemonic(phase1.identity.mnemonic, cryptoAdapter)
    const fromSeedHex = await deriveProtocolIdentityFromSeedHex(phase1.identity.bip39_seed_hex, cryptoAdapter)

    expect(bytesToHex(fromMnemonic.ed25519Seed)).toBe(bytesToHex(fromSeedHex.ed25519Seed))
    expect(bytesToHex(fromMnemonic.ed25519PublicKey)).toBe(bytesToHex(fromSeedHex.ed25519PublicKey))
    expect(bytesToHex(fromMnemonic.x25519Seed)).toBe(bytesToHex(fromSeedHex.x25519Seed))
    expect(bytesToHex(fromMnemonic.x25519PublicKey)).toBe(bytesToHex(fromSeedHex.x25519PublicKey))
    expect(fromMnemonic.did).toBe(fromSeedHex.did)
    expect(fromMnemonic.kid).toBe(fromSeedHex.kid)
  })

  it('rejects invalid English BIP39 mnemonics', async () => {
    const invalidChecksumMnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'
    const invalidWordMnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon invalid'

    await expect(deriveBip39SeedFromMnemonic(invalidChecksumMnemonic)).rejects.toThrow(
      'Invalid BIP39 mnemonic',
    )
    await expect(deriveBip39SeedFromMnemonic(invalidWordMnemonic)).rejects.toThrow(
      'Invalid BIP39 mnemonic',
    )
    await expect(deriveProtocolIdentityFromMnemonic(invalidChecksumMnemonic, cryptoAdapter)).rejects.toThrow(
      'Invalid BIP39 mnemonic',
    )
    await expect(deriveProtocolIdentityFromMnemonic(invalidWordMnemonic, cryptoAdapter)).rejects.toThrow(
      'Invalid BIP39 mnemonic',
    )
  })

  it('rejects valid non-English BIP39 mnemonics in the English protocol helper', async () => {
    // `abaco ... abete` is valid Italian BIP39, but not valid under the English protocol default.
    await expect(
      deriveBip39SeedFromMnemonic('abaco abaco abaco abaco abaco abaco abaco abaco abaco abaco abaco abete'),
    ).rejects.toThrow('Invalid BIP39 mnemonic')
  })

  it('rejects non-64-byte BIP39 seed input for protocol identity derivation', async () => {
    await expect(
      deriveProtocolIdentityFromSeedHex(bytesToHex(new Uint8Array(32)), cryptoAdapter),
    ).rejects.toThrow('Expected 64-byte BIP39 seed')
  })

  it('rejects non-hex BIP39 seed input for protocol identity derivation', async () => {
    await expect(
      deriveProtocolIdentityFromSeedHex(`${'00'.repeat(63)}zz`, cryptoAdapter),
    ).rejects.toThrow('Invalid BIP39 seed hex')
  })

  it('canonicalizes and verifies the attestation VC-JWS vector', async () => {
    const payloadHash = await cryptoAdapter.sha256(canonicalizeToBytes(phase1.attestation_vc_jws.payload as JsonValue))

    expect(bytesToHex(payloadHash)).toBe(phase1.attestation_vc_jws.payload_jcs_sha256)

    const payload = await verifyAttestationVcJws(phase1.attestation_vc_jws.jws, {
      crypto: cryptoAdapter,
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(payload).toEqual(phase1.attestation_vc_jws.payload)
  })

  it('accepts signed attestation VC-JWS payloads with unknown extension fields', async () => {
    const payload = {
      ...phase1.attestation_vc_jws.payload,
      'https://example.com/extensions/localNote': 'kept outside Trust 001 semantics',
      credentialSubject: {
        ...phase1.attestation_vc_jws.payload.credentialSubject,
        expertiseLevel: 'advanced',
      },
    }
    const jws = await createSignedAttestationPayload(payload)

    await expect(verifyAttestationVcJws(jws, {
      crypto: cryptoAdapter,
      now: new Date('2026-04-22T10:00:00Z'),
    })).resolves.toEqual(payload)
  })

  it('accepts attestation validFrom with an explicit timezone offset', async () => {
    const payload = {
      ...phase1.attestation_vc_jws.payload,
      validFrom: '2026-04-21T12:00:00+02:00',
    }
    const jws = await createSignedAttestationPayload(payload)

    await expect(verifyAttestationVcJws(jws, {
      crypto: cryptoAdapter,
      now: new Date('2026-04-22T10:00:00Z'),
    })).resolves.toEqual(payload)
  })

  it('accepts attestation validFrom with fractional seconds that map to nbf', async () => {
    const payload = {
      ...phase1.attestation_vc_jws.payload,
      validFrom: '2026-04-21T10:00:00.500Z',
    }
    const jws = await createSignedAttestationPayload(payload)

    await expect(verifyAttestationVcJws(jws, {
      crypto: cryptoAdapter,
      now: new Date('2026-04-22T10:00:00Z'),
    })).resolves.toEqual(payload)
  })

  it('rejects signed attestation VC-JWS payloads missing mandatory Trust 001 fields', async () => {
    const basePayload = phase1.attestation_vc_jws.payload
    const invalidPayloads: Array<[string, Record<string, unknown>]> = [
      ['issuer and iss mismatch', { ...basePayload, issuer: basePayload.sub }],
      ['credentialSubject id and sub mismatch', {
        ...basePayload,
        credentialSubject: { ...basePayload.credentialSubject, id: basePayload.issuer },
      }],
      ['missing VC context', { ...basePayload, '@context': ['https://example.com/context'] }],
      ['missing WoT context', { ...basePayload, '@context': ['https://www.w3.org/ns/credentials/v2'] }],
      ['missing VerifiableCredential type', { ...basePayload, type: ['WotAttestation'] }],
      ['missing WotAttestation type', { ...basePayload, type: ['VerifiableCredential'] }],
      ['missing credentialSubject claim', {
        ...basePayload,
        credentialSubject: { id: basePayload.credentialSubject.id },
      }],
      ['empty credentialSubject claim', {
        ...basePayload,
        credentialSubject: { ...basePayload.credentialSubject, claim: '' },
      }],
      ['missing validFrom', {
        '@context': basePayload['@context'],
        type: basePayload.type,
        issuer: basePayload.issuer,
        credentialSubject: basePayload.credentialSubject,
        iss: basePayload.iss,
        sub: basePayload.sub,
        nbf: basePayload.nbf,
      }],
      ['missing nbf', {
        '@context': basePayload['@context'],
        type: basePayload.type,
        issuer: basePayload.issuer,
        credentialSubject: basePayload.credentialSubject,
        validFrom: basePayload.validFrom,
        iss: basePayload.iss,
        sub: basePayload.sub,
      }],
    ]

    for (const [name, payload] of invalidPayloads) {
      const jws = await createSignedAttestationPayload(payload)
      await expect(
        verifyAttestationVcJws(jws, {
          crypto: cryptoAdapter,
          now: new Date('2026-04-22T10:00:00Z'),
        }),
        name,
      ).rejects.toThrow()
    }
  })

  it('rejects signed attestation VC-JWS payloads with invalid Trust 001 time claims', async () => {
    const invalidPayloads: Array<[string, Record<string, unknown>]> = [
      ['future nbf', {
        ...phase1.attestation_vc_jws.payload,
        validFrom: '2026-04-23T12:00:00Z',
        nbf: 1776945600,
      }],
      ['validFrom without timezone', {
        ...phase1.attestation_vc_jws.payload,
        validFrom: '2026-04-21T10:00:00',
      }],
      ['validFrom with invalid calendar date', {
        ...phase1.attestation_vc_jws.payload,
        validFrom: '2026-02-30T10:00:00Z',
        nbf: 1772445600,
      }],
      ['offset validFrom one second in the future', {
        ...phase1.attestation_vc_jws.payload,
        validFrom: '2026-04-22T12:00:01+02:00',
        nbf: 1776852001,
      }],
      ['validFrom and nbf mismatch', { ...phase1.attestation_vc_jws.payload, nbf: 1776945600 }],
      ['expired exp', { ...phase1.attestation_vc_jws.payload, exp: 1776851999 }],
    ]

    for (const [name, payload] of invalidPayloads) {
      const jws = await createSignedAttestationPayload(payload)
      await expect(
        verifyAttestationVcJws(jws, {
          crypto: cryptoAdapter,
          now: new Date('2026-04-22T10:00:00Z'),
        }),
        name,
      ).rejects.toThrow()
    }
  })

  it('rejects attestation VC-JWS with invalid JOSE header fields', async () => {
    const payload = phase1.attestation_vc_jws.payload as JsonValue
    const signingSeed = hexToBytes(phase1.identity.ed25519_seed_hex)
    const verifierInvalidHeaders: Array<[string, Record<string, JsonValue>]> = [
      ['invalid typ', { alg: 'EdDSA', kid: phase1.attestation_vc_jws.header.kid, typ: 'JWT' }],
    ]
    const senderInvalidHeaders: Array<[string, Record<string, JsonValue>]> = [
      ['empty kid', { alg: 'EdDSA', kid: '', typ: 'vc+jwt' }],
      ['missing kid', { alg: 'EdDSA', typ: 'vc+jwt' }],
    ]

    for (const [name, header] of verifierInvalidHeaders) {
      const jws = await createJcsEd25519Jws(header, payload, signingSeed)
      await expect(
        verifyAttestationVcJws(jws, {
          crypto: cryptoAdapter,
          now: new Date('2026-04-22T10:00:00Z'),
        }),
        name,
      ).rejects.toThrow()
    }

    for (const [name, header] of senderInvalidHeaders) {
      await expect(createJcsEd25519Jws(header, payload, signingSeed), name).rejects.toThrow('Missing JWS kid')
    }
  })

  it('recreates attestation and device delegation JWS vectors', async () => {
    const attestationJws = await createAttestationVcJws({
      payload: phase1.attestation_vc_jws.payload,
      kid: phase1.attestation_vc_jws.header.kid,
      signingSeed: hexToBytes(phase1.identity.ed25519_seed_hex),
    })
    expect(attestationJws).toBe(phase1.attestation_vc_jws.jws)

    const deviceKeyBindingJws = await createDeviceKeyBindingJws({
      payload: deviceDelegation.device_key_binding_jws.payload,
      issuerKid: deviceDelegation.device_key_binding_jws.header.kid,
      signingSeed: hexToBytes(phase1.identity.ed25519_seed_hex),
    })
    expect(deviceKeyBindingJws).toBe(deviceDelegation.device_key_binding_jws.jws)

    const bundle = await createDelegatedAttestationBundle({
      attestationPayload: deviceDelegation.delegated_attestation_bundle.attestationPayload,
      deviceKid: deviceDelegation.delegated_attestation_bundle.attestationHeader.kid,
      deviceSigningSeed: hexToBytes(deviceDelegation.device.seed_hex),
      deviceKeyBindingJws,
    })
    expect(bundle).toEqual(deviceDelegation.delegated_attestation_bundle.bundle)
  })

  it('uses JCS-encoded header and payload bytes as sender-side JWS signing input', async () => {
    const header = {
      z: 'last',
      kid: phase1.identity.kid,
      alg: 'EdDSA',
      a: 'first',
    } satisfies Record<string, JsonValue>
    const payload = {
      z: 1,
      a: {
        y: true,
        x: 'first',
      },
    } satisfies JsonValue
    let observedSigningInput = ''

    const jws = await createJcsEd25519JwsWithSigner(header, payload, async (signingInput) => {
      observedSigningInput = bytesToText(signingInput)
      return new Uint8Array(64).fill(7)
    })
    const [encodedHeader, encodedPayload] = jws.split('.')
    const expectedHeader = encodeBase64Url(canonicalizeToBytes(header))
    const expectedPayload = encodeBase64Url(canonicalizeToBytes(payload))

    expect(encodedHeader).toBe(expectedHeader)
    expect(encodedPayload).toBe(expectedPayload)
    expect(observedSigningInput).toBe(`${expectedHeader}.${expectedPayload}`)
  })

  it('requires a non-empty string kid when creating and verifying WoT JWS values', async () => {
    await expect(
      createJcsEd25519JwsWithSigner({ alg: 'EdDSA' }, { ok: true }, async () => new Uint8Array(64)),
    ).rejects.toThrow('Missing JWS kid')
    await expect(
      createJcsEd25519JwsWithSigner({ alg: 'EdDSA', kid: '' }, { ok: true }, async () => new Uint8Array(64)),
    ).rejects.toThrow('Missing JWS kid')

    const missingKidJws = [
      textToBase64Url(JSON.stringify({ alg: 'EdDSA' })),
      textToBase64Url(JSON.stringify({ ok: true })),
      encodeBase64Url(new Uint8Array(64)),
    ].join('.')
    await expect(
      verifyJwsWithPublicKey(missingKidJws, {
        publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
        crypto: cryptoAdapter,
      }),
    ).rejects.toThrow('Missing JWS kid')
  })

  it('rejects unsupported JWS alg values before crypto verification', async () => {
    let verifyCalls = 0
    const rejectingCrypto = cryptoWithVerify(async () => {
      verifyCalls += 1
      throw new Error('verifyEd25519 must not be called')
    })
    const jws = [
      textToBase64Url(JSON.stringify({ alg: 'HS256', kid: phase1.identity.kid })),
      textToBase64Url(JSON.stringify({ ok: true })),
      encodeBase64Url(new Uint8Array(64)),
    ].join('.')

    await expect(
      verifyJwsWithPublicKey(jws, {
        publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
        crypto: rejectingCrypto,
      }),
    ).rejects.toThrow('Unsupported JWS alg')
    expect(verifyCalls).toBe(0)
  })

  it('rejects non-object JWS headers before crypto verification', async () => {
    let verifyCalls = 0
    const rejectingCrypto = cryptoWithVerify(async () => {
      verifyCalls += 1
      throw new Error('verifyEd25519 must not be called')
    })
    const jws = [
      textToBase64Url('null'),
      textToBase64Url(JSON.stringify({ ok: true })),
      encodeBase64Url(new Uint8Array(64)),
    ].join('.')

    await expect(
      verifyJwsWithPublicKey(jws, {
        publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
        crypto: rejectingCrypto,
      }),
    ).rejects.toThrow('Invalid JWS header')
    expect(verifyCalls).toBe(0)
  })

  it('verifies against the exact received compact JWS signing-input bytes', async () => {
    let observedSigningInput = ''
    const acceptingCrypto = cryptoWithVerify(async (input) => {
      observedSigningInput = bytesToText(input)
      return true
    })
    const encodedHeader = textToBase64Url(JSON.stringify({ alg: 'EdDSA', kid: phase1.identity.kid }))
    const encodedPayload = textToBase64Url('{"z":1,"a":2}')
    const jws = `${encodedHeader}.${encodedPayload}.${encodeBase64Url(new Uint8Array(64))}`

    const decoded = await verifyJwsWithPublicKey(jws, {
      publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
      crypto: acceptingCrypto,
    })

    expect(observedSigningInput).toBe(`${encodedHeader}.${encodedPayload}`)
    expect(decoded.payload).toEqual({ z: 1, a: 2 })
  })

  it('rejects tampered received compact JWS payload bytes', async () => {
    const jws = await createJcsEd25519Jws(
      { alg: 'EdDSA', kid: phase1.identity.kid },
      { ok: true },
      hexToBytes(phase1.identity.ed25519_seed_hex),
    )
    const [encodedHeader, , encodedSignature] = jws.split('.')
    const tamperedJws = `${encodedHeader}.${textToBase64Url('{"ok":false}')}.${encodedSignature}`

    await expect(
      verifyJwsWithPublicKey(tamperedJws, {
        publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
        crypto: cryptoAdapter,
      }),
    ).rejects.toThrow('Invalid JWS signature')
  })

  it('rejects unambiguous malformed compact JWS inputs', () => {
    expect(() => decodeJws('a.b')).toThrow('Invalid JWS compact serialization')
    expect(() => decodeJws('a.b.c.d')).toThrow('Invalid JWS compact serialization')
    expect(() => decodeJws(`.${textToBase64Url('{}')}.${encodeBase64Url(new Uint8Array(64))}`)).toThrow(
      'Invalid JWS compact serialization',
    )
    expect(() => decodeJws(`${textToBase64Url('{"alg":"EdDSA"}')}..${encodeBase64Url(new Uint8Array(64))}`)).toThrow(
      'Invalid JWS compact serialization',
    )
    expect(() => decodeJws(`${textToBase64Url('{"alg":"EdDSA"}')}.${textToBase64Url('{}')}.`)).toThrow(
      'Invalid JWS compact serialization',
    )
  })

  it('recreates and verifies sync JWS vectors', async () => {
    const logEntryJws = await createLogEntryJws({
      payload: phase1.log_entry_jws.payload,
      signingSeed: hexToBytes(phase1.identity.ed25519_seed_hex),
    })
    expect(logEntryJws).toBe(phase1.log_entry_jws.jws)

    const logEntryPayload = await verifyLogEntryJws(phase1.log_entry_jws.jws, { crypto: cryptoAdapter })
    expect(logEntryPayload).toEqual(phase1.log_entry_jws.payload)

    const capabilityJws = await createSpaceCapabilityJws({
      payload: phase1.space_capability_jws.payload,
      signingSeed: hexToBytes(phase1.space_capability_jws.signing_seed_hex),
    })
    expect(capabilityJws).toBe(phase1.space_capability_jws.jws)

    const capabilityPayload = await verifySpaceCapabilityJws(phase1.space_capability_jws.jws, {
      crypto: cryptoAdapter,
      publicKey: ed25519MultibaseToPublicKeyBytes(phase1.space_capability_jws.verification_key_multibase),
      expectedSpaceId: phase1.space_capability_jws.payload.spaceId,
      expectedAudience: phase1.space_capability_jws.payload.audience,
      expectedGeneration: phase1.space_capability_jws.payload.generation,
      now: new Date('2026-04-23T10:00:00Z'),
    })
    expect(capabilityPayload).toEqual(phase1.space_capability_jws.payload)
  })

  it('rejects schema-invalid log-entry payloads inside signed JWS objects', async () => {
    const validPayload = phase1.log_entry_jws.payload
    const signingSeed = hexToBytes(phase1.identity.ed25519_seed_hex)
    const invalidPayloads = [
      ['additional payload property', { ...validPayload, extra: true }],
      ['invalid seq integer', { ...validPayload, seq: 42.5 }],
      ['invalid deviceId UUID', { ...validPayload, deviceId: 'not-a-uuid' }],
      ['invalid docId UUID', { ...validPayload, docId: 'not-a-uuid' }],
      ['invalid authorKid DID URL', { ...validPayload, authorKid: phase1.identity.did }],
      ['invalid keyGeneration integer', { ...validPayload, keyGeneration: -1 }],
      ['invalid base64url data', { ...validPayload, data: 'abc=' }],
      ['undecodable base64url data', { ...validPayload, data: 'a' }],
      ['invalid timestamp date-time', { ...validPayload, timestamp: '2026-04-17 10:00:00' }],
    ] as const

    for (const [name, payload] of invalidPayloads) {
      await expect(createLogEntryJws({ payload: payload as any, signingSeed }), name).rejects.toThrow()
      const jws = await createJcsEd25519Jws(
        { alg: 'EdDSA', kid: payload.authorKid },
        payload as unknown as JsonValue,
        signingSeed,
      )
      await expect(verifyLogEntryJws(jws, { crypto: cryptoAdapter }), name).rejects.toThrow()
    }
  })

  it('rejects schema-invalid log-entry payloads before signing', async () => {
    await expect(
      createLogEntryJws({
        payload: { ...phase1.log_entry_jws.payload, data: 'abc=' },
        signingSeed: hexToBytes(phase1.identity.ed25519_seed_hex),
      }),
    ).rejects.toThrow('Invalid log entry data')
  })

  it('matches the DIDComm-compatible plaintext envelope vector', () => {
    const message = createPlaintextMessage({
      id: phase1.didcomm_plaintext_envelope.message.id,
      type: phase1.didcomm_plaintext_envelope.message.type,
      from: phase1.didcomm_plaintext_envelope.message.from,
      to: phase1.didcomm_plaintext_envelope.message.to,
      createdTime: phase1.didcomm_plaintext_envelope.message.created_time,
      thid: phase1.didcomm_plaintext_envelope.message.thid,
      body: phase1.didcomm_plaintext_envelope.message.body,
    })

    expect(message).toEqual(phase1.didcomm_plaintext_envelope.message)
    expect(parsePlaintextMessage(message)).toEqual(message)
  })

  it('rejects invalid plaintext envelope shapes', () => {
    const validMessage = phase1.didcomm_plaintext_envelope.message
    const invalidMessages = [
      ['invalid typ', { ...validMessage, typ: 'application/json' }],
      ['invalid created_time', { ...validMessage, created_time: '1776514800' }],
      ['empty to', { ...validMessage, to: [] }],
      ['invalid to DID', { ...validMessage, to: ['not-a-did'] }],
      ['invalid body', { ...validMessage, body: phase1.log_entry_jws.jws }],
    ] as const

    for (const [name, message] of invalidMessages) {
      expect(() => parsePlaintextMessage(message), name).toThrow()
    }
  })

  it('treats log-entry envelope body entries as opaque JWS compact strings', () => {
    const message = createLogEntryMessage({
      id: phase1.didcomm_plaintext_envelope.message.id,
      from: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
      to: [phase1.identity.did],
      createdTime: phase1.didcomm_plaintext_envelope.message.created_time,
      entry: phase1.log_entry_jws.jws,
    })

    expect(message).toEqual({
      id: phase1.didcomm_plaintext_envelope.message.id,
      typ: 'application/didcomm-plain+json',
      type: LOG_ENTRY_MESSAGE_TYPE,
      from: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
      to: [phase1.identity.did],
      created_time: phase1.didcomm_plaintext_envelope.message.created_time,
      body: { entry: phase1.log_entry_jws.jws },
    })
    expect(parseLogEntryMessage(message).body.entry).toBe(phase1.log_entry_jws.jws)
    expect(() => parseLogEntryMessage(({ ...message, to: undefined }))).toThrow('Invalid log-entry message to')
    expect(() => parseLogEntryMessage(({ ...message, body: { entry: 'a.b.c' } }))).toThrow(
      'Invalid log-entry body entry',
    )
  })

  it('uses the inner log-entry JWS authorKid as the authority anchor, not envelope from', async () => {
    const message = createLogEntryMessage({
      id: phase1.didcomm_plaintext_envelope.message.id,
      from: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
      to: [phase1.identity.did],
      createdTime: phase1.didcomm_plaintext_envelope.message.created_time,
      entry: phase1.log_entry_jws.jws,
    })

    const parsed = parseLogEntryMessage(message)
    const payload = await verifyLogEntryJws(parsed.body.entry, { crypto: cryptoAdapter })

    expect(parsed.from).not.toBe(payload.authorKid.split('#', 1)[0])
    expect(payload.authorKid).toBe(phase1.log_entry_jws.payload.authorKid)
  })

  it('matches the space membership message vectors', () => {
    expect(phase1.space_membership_messages.invite_key_discovery).toEqual({
      canonical_key_agreement_id: '#enc-0',
      x25519_public_b64: phase1.identity.x25519_public_b64,
      x25519_public_multibase: phase1.identity.x25519_public_multibase,
    })
    expect(phase1.space_membership_messages.member_update_body).toEqual({
      spaceId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
      action: 'removed',
      memberDid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
      effectiveKeyGeneration: 4,
    })
    expect(phase1.space_membership_messages.member_update_body).not.toHaveProperty('members')

    const message = createMemberUpdateMessage({
      id: '550e8400-e29b-41d4-a716-446655440000',
      from: phase1.identity.did,
      to: [phase1.space_membership_messages.member_update_body.memberDid],
      createdTime: 1776945600,
      body: phase1.space_membership_messages.member_update_body,
    })
    expect(parseMemberUpdateMessage(message)).toEqual(message)

    expect(() => parseMemberUpdateMessage({
      ...message,
      typ: 'application/json',
    })).toThrow('Invalid member-update typ')
    expect(() => parseMemberUpdateMessage({
      ...message,
      type: 'https://web-of-trust.de/protocols/inbox/1.0',
    })).toThrow('Invalid member-update type')
    expect(() => parseMemberUpdateMessage({
      ...message,
      body: null,
    })).toThrow('Invalid member-update body')
    expect(() => parseMemberUpdateMessage({
      ...message,
      body: { ...message.body, action: 'joined' },
    })).toThrow('Invalid member-update body action')
    expect(() => parseMemberUpdateMessage({
      ...message,
      body: { ...message.body, effectiveKeyGeneration: -1 },
    })).toThrow('Invalid member-update body effectiveKeyGeneration')
    expect(() => parseMemberUpdateMessage({
      ...message,
      body: { ...message.body, members: [message.body.memberDid] },
    })).toThrow('Invalid member-update body property: members')
  })

  it('parses normative space-invite membership inbox messages from the vector body', () => {
    const message = createSpaceInviteMessage({
      id: '550e8400-e29b-41d4-a716-446655440001',
      from: phase1.identity.did,
      to: [phase1.space_capability_jws.payload.audience],
      createdTime: 1776945600,
      thid: '550e8400-e29b-41d4-a716-446655440001',
      body: phase1.space_membership_messages.space_invite_body,
    })

    expect(message).toMatchObject({
      typ: 'application/didcomm-plain+json',
      type: 'https://web-of-trust.de/protocols/space-invite/1.0',
      body: phase1.space_membership_messages.space_invite_body,
    })
    expect(parseSpaceInviteMessage(message)).toEqual(message)
    // Capability JWS payload correlation is deferred to wot-spec issue #24; this layer checks compact shape only.
    expect(message.body.capability).toBe('aaa.bbb.ccc')

    expect(() => parseSpaceInviteMessage({
      ...message,
      typ: 'application/json',
    })).toThrow('Invalid space-invite typ')
    expect(() => parseSpaceInviteMessage({
      ...message,
      type: 'https://web-of-trust.de/protocols/inbox/1.0',
    })).toThrow('Invalid space-invite type')
    expect(() => parseSpaceInviteMessage({
      ...message,
      body: null,
    })).toThrow('Invalid space-invite body')
    expect(() => parseSpaceInviteMessage({
      ...message,
      body: { ...message.body, brokerUrls: [] },
    })).toThrow('Invalid space-invite body brokerUrls')
    expect(() => parseSpaceInviteMessage({
      ...message,
      body: { ...message.body, spaceContentKeys: [] },
    })).toThrow('Invalid space-invite body spaceContentKeys')
    expect(() => parseSpaceInviteMessage({
      ...message,
      body: { ...message.body, currentKeyGeneration: -1 },
    })).toThrow('Invalid space-invite body currentKeyGeneration')
    expect(() => parseSpaceInviteMessage({
      ...message,
      body: { ...message.body, currentKeyGeneration: 2 },
    })).toThrow('Invalid space-invite body currentKeyGeneration')
    expect(() => parseSpaceInviteMessage({
      ...message,
      body: { ...message.body, spaceContentKeys: [{ generation: 3, key: 'abc+123' }] },
    })).toThrow('Invalid space-invite body spaceContentKeys key')
    expect(() => parseSpaceInviteMessage({
      ...message,
      body: { ...message.body, capability: 'aaa.bbb' },
    })).toThrow('Invalid space-invite body capability')
    expect(() => parseSpaceInviteMessage({
      ...message,
      body: { ...message.body, inviteeDid: message.to[0] },
    })).toThrow('Invalid space-invite body property: inviteeDid')
  })

  it('parses normative key-rotation membership inbox messages and rejects legacy group-key-rotation', () => {
    const message = createKeyRotationMessage({
      id: '550e8400-e29b-41d4-a716-446655440002',
      from: phase1.identity.did,
      to: [phase1.space_capability_jws.payload.audience],
      createdTime: 1776945600,
      body: phase1.space_membership_messages.key_rotation_body,
    })

    expect(message).toMatchObject({
      typ: 'application/didcomm-plain+json',
      type: 'https://web-of-trust.de/protocols/key-rotation/1.0',
      body: phase1.space_membership_messages.key_rotation_body,
    })
    expect(parseKeyRotationMessage(message)).toEqual(message)
    // Capability JWS payload correlation is deferred to wot-spec issue #24; this layer checks compact shape only.
    expect(message.body.capability).toBe('aaa.bbb.ccc')

    expect(() => parseKeyRotationMessage({
      ...message,
      typ: 'application/json',
    })).toThrow('Invalid key-rotation typ')
    expect(() => parseKeyRotationMessage({
      ...message,
      type: 'https://web-of-trust.de/protocols/group-key-rotation/1.0',
    })).toThrow('Invalid key-rotation type')
    expect(() => parseKeyRotationMessage({
      ...message,
      body: { ...message.body, generation: -1 },
    })).toThrow('Invalid key-rotation body generation')
    expect(() => parseKeyRotationMessage({
      ...message,
      body: null,
    })).toThrow('Invalid key-rotation body')
    expect(() => parseKeyRotationMessage({
      ...message,
      body: { ...message.body, spaceContentKey: 'abc+123' },
    })).toThrow('Invalid key-rotation body spaceContentKey')
    expect(() => parseKeyRotationMessage({
      ...message,
      body: { ...message.body, capability: 'aaa.bbb' },
    })).toThrow('Invalid key-rotation body capability')
    expect(() => parseKeyRotationMessage({
      ...message,
      body: { ...message.body, previousGeneration: 3 },
    })).toThrow('Invalid key-rotation body property: previousGeneration')
  })

  it('evaluates member-update generation disposition vectors', () => {
    for (const testCase of phase1.space_membership_messages.member_update_generation_cases) {
      expect(evaluateMemberUpdateDisposition(testCase), testCase.name).toBe(testCase.expectedDisposition)
    }
  })

  it('recreates ECIES and log payload encryption vectors', async () => {
    const eciesMaterial = await deriveEciesMaterial({
      crypto: cryptoAdapter,
      ephemeralPrivateSeed: hexToBytes(phase1.ecies.ephemeral_private_hex),
      recipientPublicKey: decodeBase64Url(phase1.ecies.recipient_x25519_public_b64),
    })
    expect(bytesToHex(eciesMaterial.sharedSecret)).toBe(phase1.ecies.shared_secret_hex)
    expect(bytesToHex(eciesMaterial.aesKey)).toBe(phase1.ecies.aes_key_hex)

    const eciesMessage = await encryptEcies({
      crypto: cryptoAdapter,
      ephemeralPrivateSeed: hexToBytes(phase1.ecies.ephemeral_private_hex),
      recipientPublicKey: decodeBase64Url(phase1.ecies.recipient_x25519_public_b64),
      nonce: hexToBytes(phase1.ecies.nonce_hex),
      plaintext: new TextEncoder().encode(phase1.ecies.plaintext),
    })
    expect(eciesMessage).toEqual({
      epk: phase1.ecies.ephemeral_public_b64,
      nonce: 'GhscHR4fICEiIyQl',
      ciphertext: phase1.ecies.ciphertext_b64,
    })
    const eciesPlaintext = await decryptEcies({
      crypto: cryptoAdapter,
      recipientPrivateSeed: hexToBytes(phase1.identity.x25519_seed_hex),
      message: eciesMessage,
    })
    expect(bytesToText(eciesPlaintext)).toBe(phase1.ecies.plaintext)

    const logNonce = await deriveLogPayloadNonce(
      cryptoAdapter,
      phase1.log_payload_encryption.device_id,
      phase1.log_payload_encryption.seq,
    )
    expect(bytesToHex(logNonce)).toBe(phase1.log_payload_encryption.nonce_hex)

    const encryptedLogPayload = await encryptLogPayload({
      crypto: cryptoAdapter,
      spaceContentKey: hexToBytes(phase1.log_payload_encryption.space_content_key_hex),
      deviceId: phase1.log_payload_encryption.device_id,
      seq: phase1.log_payload_encryption.seq,
      plaintext: new TextEncoder().encode(phase1.log_payload_encryption.plaintext),
    })
    expect(bytesToHex(encryptedLogPayload.ciphertextTag)).toBe(phase1.log_payload_encryption.ciphertext_tag_hex)
    expect(encryptedLogPayload.blobBase64Url).toBe(phase1.log_payload_encryption.blob_b64)

    const decryptedLogPayload = await decryptLogPayload({
      crypto: cryptoAdapter,
      spaceContentKey: hexToBytes(phase1.log_payload_encryption.space_content_key_hex),
      blob: decodeBase64Url(phase1.log_payload_encryption.blob_b64),
    })
    expect(bytesToText(decryptedLogPayload)).toBe(phase1.log_payload_encryption.plaintext)
  })

  it('rejects empty ECIES and log payload plaintext boundaries', async () => {
    await expect(
      encryptEcies({
        crypto: cryptoAdapter,
        ephemeralPrivateSeed: hexToBytes(phase1.ecies.ephemeral_private_hex),
        recipientPublicKey: decodeBase64Url(phase1.ecies.recipient_x25519_public_b64),
        nonce: hexToBytes(phase1.ecies.nonce_hex),
        plaintext: new Uint8Array(),
      }),
    ).rejects.toThrow('ECIES plaintext must not be empty')

    const eciesMaterial = await deriveEciesMaterial({
      crypto: cryptoAdapter,
      ephemeralPrivateSeed: hexToBytes(phase1.ecies.ephemeral_private_hex),
      recipientPublicKey: decodeBase64Url(phase1.ecies.recipient_x25519_public_b64),
    })
    const emptyEciesCiphertext = await cryptoAdapter.aes256GcmEncrypt(
      eciesMaterial.aesKey,
      hexToBytes(phase1.ecies.nonce_hex),
      new Uint8Array(),
    )
    await expect(
      decryptEcies({
        crypto: cryptoAdapter,
        recipientPrivateSeed: hexToBytes(phase1.identity.x25519_seed_hex),
        message: {
          epk: phase1.ecies.ephemeral_public_b64,
          nonce: 'GhscHR4fICEiIyQl',
          ciphertext: encodeBase64Url(emptyEciesCiphertext),
        },
      }),
    ).rejects.toThrow('ECIES ciphertext must include ciphertext and authentication tag')

    await expect(
      encryptLogPayload({
        crypto: cryptoAdapter,
        spaceContentKey: hexToBytes(phase1.log_payload_encryption.space_content_key_hex),
        deviceId: phase1.log_payload_encryption.device_id,
        seq: phase1.log_payload_encryption.seq,
        plaintext: new Uint8Array(),
      }),
    ).rejects.toThrow('Log payload plaintext must not be empty')

    const logNonce = await deriveLogPayloadNonce(
      cryptoAdapter,
      phase1.log_payload_encryption.device_id,
      phase1.log_payload_encryption.seq,
    )
    const emptyLogCiphertextTag = await cryptoAdapter.aes256GcmEncrypt(
      hexToBytes(phase1.log_payload_encryption.space_content_key_hex),
      logNonce,
      new Uint8Array(),
    )
    const emptyLogBlob = new Uint8Array(logNonce.length + emptyLogCiphertextTag.length)
    emptyLogBlob.set(logNonce)
    emptyLogBlob.set(emptyLogCiphertextTag, logNonce.length)

    await expect(
      decryptLogPayload({
        crypto: cryptoAdapter,
        spaceContentKey: hexToBytes(phase1.log_payload_encryption.space_content_key_hex),
        blob: emptyLogBlob,
      }),
    ).rejects.toThrow('Invalid encrypted log payload blob')
  })

  it('rejects malformed ECIES key, nonce, and ciphertext boundaries', async () => {
    await expect(
      deriveEciesMaterial({
        crypto: cryptoAdapter,
        ephemeralPrivateSeed: new Uint8Array(31),
        recipientPublicKey: decodeBase64Url(phase1.ecies.recipient_x25519_public_b64),
      }),
    ).rejects.toThrow('ECIES ephemeral private seed must be 32 bytes')
    await expect(
      deriveEciesMaterial({
        crypto: cryptoAdapter,
        ephemeralPrivateSeed: hexToBytes(phase1.ecies.ephemeral_private_hex),
        recipientPublicKey: new Uint8Array(31),
      }),
    ).rejects.toThrow('ECIES recipient public key must be 32 bytes')
    await expect(
      encryptEcies({
        crypto: cryptoAdapter,
        ephemeralPrivateSeed: hexToBytes(phase1.ecies.ephemeral_private_hex),
        recipientPublicKey: decodeBase64Url(phase1.ecies.recipient_x25519_public_b64),
        nonce: new Uint8Array(11),
        plaintext: new TextEncoder().encode(phase1.ecies.plaintext),
      }),
    ).rejects.toThrow('ECIES nonce must be 12 bytes')

    await expect(
      decryptEcies({
        crypto: cryptoAdapter,
        recipientPrivateSeed: hexToBytes(phase1.identity.x25519_seed_hex),
        message: null as any,
      }),
    ).rejects.toThrow('Invalid ECIES message')
    await expect(
      decryptEcies({
        crypto: cryptoAdapter,
        recipientPrivateSeed: hexToBytes(phase1.identity.x25519_seed_hex),
        message: {
          epk: 123,
          nonce: 'GhscHR4fICEiIyQl',
          ciphertext: phase1.ecies.ciphertext_b64,
        } as any,
      }),
    ).rejects.toThrow('Invalid ECIES message')
    await expect(
      decryptEcies({
        crypto: cryptoAdapter,
        recipientPrivateSeed: new Uint8Array(31),
        message: {
          epk: phase1.ecies.ephemeral_public_b64,
          nonce: 'GhscHR4fICEiIyQl',
          ciphertext: phase1.ecies.ciphertext_b64,
        },
      }),
    ).rejects.toThrow('ECIES recipient private seed must be 32 bytes')
    await expect(
      decryptEcies({
        crypto: cryptoAdapter,
        recipientPrivateSeed: hexToBytes(phase1.identity.x25519_seed_hex),
        message: {
          epk: encodeBase64Url(new Uint8Array(31)),
          nonce: 'GhscHR4fICEiIyQl',
          ciphertext: phase1.ecies.ciphertext_b64,
        },
      }),
    ).rejects.toThrow('ECIES ephemeral public key must be 32 bytes')
    await expect(
      decryptEcies({
        crypto: cryptoAdapter,
        recipientPrivateSeed: hexToBytes(phase1.identity.x25519_seed_hex),
        message: {
          epk: phase1.ecies.ephemeral_public_b64,
          nonce: encodeBase64Url(new Uint8Array(11)),
          ciphertext: phase1.ecies.ciphertext_b64,
        },
      }),
    ).rejects.toThrow('ECIES nonce must be 12 bytes')
    await expect(
      decryptEcies({
        crypto: cryptoAdapter,
        recipientPrivateSeed: hexToBytes(phase1.identity.x25519_seed_hex),
        message: {
          epk: phase1.ecies.ephemeral_public_b64,
          nonce: 'GhscHR4fICEiIyQl',
          ciphertext: 'not+base64url',
        },
      }),
    ).rejects.toThrow('ECIES ciphertext must be a valid base64url string')
  })

  it('rejects all-zero ECIES shared secrets before HKDF', async () => {
    const zeroSharedSecretCrypto = cryptoWithSharedSecret(new Uint8Array(32))

    await expect(
      deriveEciesMaterial({
        crypto: zeroSharedSecretCrypto,
        ephemeralPrivateSeed: hexToBytes(phase1.ecies.ephemeral_private_hex),
        recipientPublicKey: decodeBase64Url(phase1.ecies.recipient_x25519_public_b64),
      }),
    ).rejects.toThrow('ECIES shared secret must not be all zero bytes')
    await expect(
      decryptEcies({
        crypto: zeroSharedSecretCrypto,
        recipientPrivateSeed: hexToBytes(phase1.identity.x25519_seed_hex),
        message: {
          epk: phase1.ecies.ephemeral_public_b64,
          nonce: 'GhscHR4fICEiIyQl',
          ciphertext: phase1.ecies.ciphertext_b64,
        },
      }),
    ).rejects.toThrow('ECIES shared secret must not be all zero bytes')
  })

  it('rejects ECIES tamper and wrong-key decrypt attempts', async () => {
    const eciesMessage = await encryptEcies({
      crypto: cryptoAdapter,
      ephemeralPrivateSeed: hexToBytes(phase1.ecies.ephemeral_private_hex),
      recipientPublicKey: decodeBase64Url(phase1.ecies.recipient_x25519_public_b64),
      nonce: hexToBytes(phase1.ecies.nonce_hex),
      plaintext: new TextEncoder().encode(phase1.ecies.plaintext),
    })
    const tamperedCiphertext = decodeBase64Url(eciesMessage.ciphertext)
    tamperedCiphertext[0] ^= 0xff
    const tagTamperedCiphertext = decodeBase64Url(eciesMessage.ciphertext)
    tagTamperedCiphertext[tagTamperedCiphertext.length - 1] ^= 0xff

    await expect(
      decryptEcies({
        crypto: cryptoAdapter,
        recipientPrivateSeed: hexToBytes(phase1.identity.x25519_seed_hex),
        message: { ...eciesMessage, ciphertext: encodeBase64Url(tamperedCiphertext) },
      }),
    ).rejects.toThrow()
    await expect(
      decryptEcies({
        crypto: cryptoAdapter,
        recipientPrivateSeed: hexToBytes(phase1.identity.x25519_seed_hex),
        message: { ...eciesMessage, ciphertext: encodeBase64Url(tagTamperedCiphertext) },
      }),
    ).rejects.toThrow()
    await expect(
      decryptEcies({
        crypto: cryptoAdapter,
        recipientPrivateSeed: hexToBytes(phase1.ecies.ephemeral_private_hex),
        message: eciesMessage,
      }),
    ).rejects.toThrow()
  })

  it('rejects invalid log payload nonce inputs and encrypted blob boundaries', async () => {
    await expect(deriveLogPayloadNonce(cryptoAdapter, '', phase1.log_payload_encryption.seq)).rejects.toThrow(
      'Missing deviceId',
    )
    await expect(
      deriveLogPayloadNonce(cryptoAdapter, phase1.log_payload_encryption.device_id, -1),
    ).rejects.toThrow('Invalid seq')
    await expect(
      deriveLogPayloadNonce(cryptoAdapter, phase1.log_payload_encryption.device_id, 1.5),
    ).rejects.toThrow('Invalid seq')
    await expect(
      deriveLogPayloadNonce(cryptoAdapter, phase1.log_payload_encryption.device_id, Number.MAX_SAFE_INTEGER + 1),
    ).rejects.toThrow('Invalid seq')
    await expect(
      encryptLogPayload({
        crypto: cryptoAdapter,
        spaceContentKey: new Uint8Array(31),
        deviceId: phase1.log_payload_encryption.device_id,
        seq: phase1.log_payload_encryption.seq,
        plaintext: new TextEncoder().encode(phase1.log_payload_encryption.plaintext),
      }),
    ).rejects.toThrow('Space content key must be 32 bytes')
    await expect(
      decryptLogPayload({
        crypto: cryptoAdapter,
        spaceContentKey: new Uint8Array(31),
        blob: decodeBase64Url(phase1.log_payload_encryption.blob_b64),
      }),
    ).rejects.toThrow('Space content key must be 32 bytes')
    await expect(
      decryptLogPayload({
        crypto: cryptoAdapter,
        spaceContentKey: hexToBytes(phase1.log_payload_encryption.space_content_key_hex),
        blob: new Uint8Array(12 + 16),
      }),
    ).rejects.toThrow('Invalid encrypted log payload blob')
  })

  it('rejects log payload tamper and wrong-key decrypt attempts', async () => {
    const encryptedLogPayload = await encryptLogPayload({
      crypto: cryptoAdapter,
      spaceContentKey: hexToBytes(phase1.log_payload_encryption.space_content_key_hex),
      deviceId: phase1.log_payload_encryption.device_id,
      seq: phase1.log_payload_encryption.seq,
      plaintext: new TextEncoder().encode(phase1.log_payload_encryption.plaintext),
    })
    const tamperedBlob = new Uint8Array(encryptedLogPayload.blob)
    tamperedBlob[tamperedBlob.length - 1] ^= 0xff
    const bodyTamperedBlob = new Uint8Array(encryptedLogPayload.blob)
    bodyTamperedBlob[encryptedLogPayload.nonce.length] ^= 0xff
    const wrongKey = hexToBytes(phase1.log_payload_encryption.space_content_key_hex)
    wrongKey[0] ^= 0xff

    await expect(
      decryptLogPayload({
        crypto: cryptoAdapter,
        spaceContentKey: hexToBytes(phase1.log_payload_encryption.space_content_key_hex),
        blob: bodyTamperedBlob,
      }),
    ).rejects.toThrow()
    await expect(
      decryptLogPayload({
        crypto: cryptoAdapter,
        spaceContentKey: hexToBytes(phase1.log_payload_encryption.space_content_key_hex),
        blob: tamperedBlob,
      }),
    ).rejects.toThrow()
    await expect(
      decryptLogPayload({
        crypto: cryptoAdapter,
        spaceContentKey: wrongKey,
        blob: encryptedLogPayload.blob,
      }),
    ).rejects.toThrow()
  })

  it('derives admin, personal-doc, and SD-JWT VC vectors', async () => {
    const adminKey = await deriveSpaceAdminKeyFromSeedHex(
      phase1.identity.bip39_seed_hex,
      phase1.admin_key_derivation.space_id,
      cryptoAdapter,
    )
    expect(adminKey.hkdfInfo).toBe(phase1.admin_key_derivation.hkdf_info)
    expect(bytesToHex(adminKey.ed25519Seed)).toBe(phase1.admin_key_derivation.ed25519_seed_hex)
    expect(bytesToHex(adminKey.ed25519PublicKey)).toBe(phase1.admin_key_derivation.ed25519_public_hex)
    expect(adminKey.did).toBe(phase1.admin_key_derivation.did)

    const personalDoc = await derivePersonalDocFromSeedHex(phase1.identity.bip39_seed_hex, cryptoAdapter)
    expect(personalDoc.hkdfInfo).toBe(phase1.personal_doc.hkdf_info)
    expect(bytesToHex(personalDoc.key)).toBe(phase1.personal_doc.key_hex)
    expect(personalDoc.docId).toBe(phase1.personal_doc.doc_id)

    const encodedDisclosure = encodeSdJwtDisclosure(phase1.sd_jwt_vc_trust_list.disclosure as JsonValue)
    const disclosureDigest = await digestSdJwtDisclosure(encodedDisclosure, cryptoAdapter)
    expect(disclosureDigest).toBe(phase1.sd_jwt_vc_trust_list.disclosure_digest)
    expect(
      createSdJwtVcCompact(phase1.sd_jwt_vc_trust_list.issuer_signed_jwt, [
        phase1.sd_jwt_vc_trust_list.disclosure as JsonValue,
      ]),
    ).toBe(phase1.sd_jwt_vc_trust_list.sd_jwt_compact)

    const verifiedSdJwt = await verifySdJwtVc(phase1.sd_jwt_vc_trust_list.sd_jwt_compact, {
      crypto: cryptoAdapter,
    })
    expect(verifiedSdJwt.disclosures).toEqual([phase1.sd_jwt_vc_trust_list.disclosure])
    expect(verifiedSdJwt.disclosureDigests).toEqual([phase1.sd_jwt_vc_trust_list.disclosure_digest])
  })

  it('verifies the DeviceKeyBinding-JWS vector', async () => {
    const binding = await verifyDeviceKeyBindingJws(deviceDelegation.device_key_binding_jws.jws, { crypto: cryptoAdapter })

    expect(binding).toEqual(deviceDelegation.device_key_binding_jws.payload)
  })

  it('verifies delegated attestation bundles and rejects invalid cases', async () => {
    const result = await verifyDelegatedAttestationBundle(deviceDelegation.delegated_attestation_bundle.bundle, {
      crypto: cryptoAdapter,
    })

    expect(result.bindingPayload).toEqual(deviceDelegation.device_key_binding_jws.payload)
    expect(result.attestationPayload).toEqual(deviceDelegation.delegated_attestation_bundle.attestationPayload)

    for (const invalidCase of Object.values(deviceDelegation.invalid_cases) as Array<{ bundle: unknown }>) {
      await expect(
        verifyDelegatedAttestationBundle(invalidCase.bundle as any, { crypto: cryptoAdapter }),
      ).rejects.toThrow()
    }
  })

  describe('Trust 002 QR challenge and online nonce acceptance', () => {
    it('parses the raw JSON QR challenge format and validates required fields', () => {
      expect(parseQrChallenge(JSON.stringify(trust002Challenge))).toEqual(trust002Challenge)
      expect(parseQrChallenge(validQrChallengeExampleJson)).toEqual(loadSpecVector(
        './fixtures/wot-spec/schemas/examples/valid/qr-challenge.json',
      ))
      expect(() => parseQrChallenge(invalidQrChallengeExampleJson)).toThrow()
      expect(parseQrChallenge(JSON.stringify({
        ...trust002Challenge,
        nonce: trust002Challenge.nonce.toUpperCase(),
      })).nonce).toBe(trust002Challenge.nonce)

      for (const field of ['did', 'name', 'enc', 'nonce', 'ts'] as const) {
        const invalid = Object.fromEntries(
          Object.entries(trust002Challenge).filter(([key]) => key !== field),
        )
        expect(() => parseQrChallenge(JSON.stringify(invalid)), `missing ${field}`).toThrow()
      }

      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, extra: true }))).toThrow()
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, did: 'alice' }))).toThrow()
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, name: '' }))).toThrow()
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, name: 123 }))).toThrow(
        'Invalid QR challenge field: name',
      )
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, nonce: 'not-a-uuid' }))).toThrow()
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, ts: 'not-a-date' }))).toThrow()
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, ts: '2026-02-31T10:00:00Z' }))).toThrow()
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, broker: 'ftp://broker.example.com' }))).toThrow()
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, broker: 'wss://user:pass@broker.example.com' }))).toThrow()
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, broker: 'wss://bad_host.example.com' }))).toThrow()
    })

    it('requires enc to be base64url and decode to exactly 32 bytes', () => {
      expect(decodeBase64Url(parseQrChallenge(JSON.stringify(trust002Challenge)).enc)).toHaveLength(32)

      const thirtyOneBytes = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      const thirtyThreeBytes = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

      expect(decodeBase64Url(thirtyOneBytes)).toHaveLength(31)
      expect(decodeBase64Url(thirtyThreeBytes)).toHaveLength(33)
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, enc: thirtyOneBytes }))).toThrow()
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, enc: thirtyThreeBytes }))).toThrow()
      expect(() => parseQrChallenge(JSON.stringify({ ...trust002Challenge, enc: 'not+base64url' }))).toThrow()
    })

    it('evaluates active challenge age with an injectable current time', () => {
      const challenge = parseQrChallenge(JSON.stringify(trust002Challenge))

      expect(isActiveQrChallengeValid(challenge, { now: new Date('2026-04-22T09:59:59Z') })).toBe(false)
      expect(isActiveQrChallengeValid(challenge, { now: new Date('2026-04-22T10:04:59Z') })).toBe(true)
      expect(isActiveQrChallengeValid(challenge, { now: new Date('2026-04-22T10:05:00Z') })).toBe(true)
      expect(isActiveQrChallengeValid(challenge, { now: new Date('2026-04-22T10:05:01Z') })).toBe(false)
    })

    it('accepts online in-person Verification-Attestations only for the local DID and active nonce', () => {
      const activeChallenge = parseQrChallenge(JSON.stringify(trust002Challenge))
      const consumedNonces = new Set<string>()

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload(),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces,
        }),
      ).toEqual({
        decision: 'accept-in-person',
        nonce: trust002Challenge.nonce,
      })
      expect(consumedNonces.size).toBe(0)

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload({ jti: `urn:uuid:other-${trust002Challenge.nonce}-bob` }),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces,
        }),
      ).toEqual({ decision: 'accept-in-person', nonce: trust002Challenge.nonce })

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload({
            jti: `urn:uuid:ver-123e4567-e89b-42d3-a456-426614174000-${trust002Challenge.nonce}-bob`,
          }),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces,
        }),
      ).toEqual({ decision: 'accept-in-person', nonce: trust002Challenge.nonce })

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload({
            credentialSubject: { id: trust002Challenge.did, claim: 'kann gut programmieren' },
          }),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces,
        }),
      ).toEqual({ decision: 'reject', reason: 'not-verification-attestation' })

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload({ type: ['VerifiableCredential'] }),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces,
        }),
      ).toEqual({ decision: 'reject', reason: 'not-verification-attestation' })

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload({ type: ['WotAttestation'] }),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces,
        }),
      ).toEqual({ decision: 'reject', reason: 'not-verification-attestation' })

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload({
            credentialSubject: { id: trust002Challenge.did, claim: 'kann gut programmieren' },
            jti: undefined,
          }),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces,
        }),
      ).toEqual({ decision: 'reject', reason: 'not-verification-attestation' })

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload({ sub: 'did:key:z6Mkwrong' }),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces,
        }),
      ).toEqual({ decision: 'reject', reason: 'wrong-subject' })

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload({
            credentialSubject: { id: 'did:key:z6Mkwrong', claim: 'in-person verifiziert' },
          }),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces,
        }),
      ).toEqual({ decision: 'reject', reason: 'wrong-subject' })
    })

    it('rejects missing, mismatched, consumed, and expired active nonces without mutating caller state', () => {
      const activeChallenge = parseQrChallenge(JSON.stringify(trust002Challenge))
      const consumedNonces = new Set<string>([trust002Challenge.nonce])

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload({ jti: undefined }),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces: new Set<string>(),
        }),
      ).toEqual({ decision: 'remote-unbound', reason: 'missing-jti-nonce' })

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload({ jti: 'urn:uuid:ver-other-nonce-bob' }),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces: new Set<string>(),
        }),
      ).toEqual({ decision: 'remote-unbound', reason: 'no-active-matching-nonce' })

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload({ jti: `urn:uuid:ver-${trust002Challenge.nonce.toUpperCase()}-bob` }),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces: new Set<string>(),
        }),
      ).toEqual({ decision: 'accept-in-person', nonce: trust002Challenge.nonce })

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload(),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces,
        }),
      ).toEqual({ decision: 'reject', reason: 'nonce-consumed' })
      expect([...consumedNonces]).toEqual([trust002Challenge.nonce])

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload(),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces: new Set<string>([trust002Challenge.nonce.toUpperCase()]),
        }),
      ).toEqual({ decision: 'reject', reason: 'nonce-consumed' })

      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload(),
          localDid: trust002Challenge.did,
          activeChallenge,
          now: new Date('2026-04-22T10:05:01Z'),
          consumedNonces: new Set<string>(),
        }),
      ).toEqual({ decision: 'reject', reason: 'challenge-expired' })
    })

    it('classifies attestations without an active matching challenge as remote and unbound', () => {
      expect(
        decideVerificationAttestationAcceptance({
          payload: verificationAttestationPayload(),
          localDid: trust002Challenge.did,
          activeChallenge: undefined,
          now: new Date('2026-04-22T10:04:59Z'),
          consumedNonces: new Set<string>(),
        }),
      ).toEqual({ decision: 'remote-unbound', reason: 'no-active-matching-nonce' })
    })
  })
})
