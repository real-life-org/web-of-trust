import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeToBytes,
  createAttestationVcJws,
  createDelegatedAttestationBundle,
  createDeviceKeyBindingJws,
  createJcsEd25519Jws,
  createJcsEd25519JwsWithSigner,
  createLogEntryJws,
  createMemberUpdateMessage,
  createSdJwtVcCompact,
  createSpaceCapabilityJws,
  decodeJws,
  decodeBase64Url,
  decryptEcies,
  decryptLogPayload,
  derivePersonalDocFromSeedHex,
  deriveEciesMaterial,
  deriveLogPayloadNonce,
  deriveSpaceAdminKeyFromSeedHex,
  deriveProtocolIdentityFromSeedHex,
  ed25519PublicKeyToMultibase,
  ed25519MultibaseToPublicKeyBytes,
  encryptEcies,
  encryptLogPayload,
  encodeSdJwtDisclosure,
  evaluateMemberUpdateDisposition,
  digestSdJwtDisclosure,
  encodeBase64Url,
  verifyAttestationVcJws,
  verifyDelegatedAttestationBundle,
  verifyDeviceKeyBindingJws,
  verifyJwsWithPublicKey,
  verifyLogEntryJws,
  parseMemberUpdateMessage,
  verifySdJwtVc,
  verifySpaceCapabilityJws,
  resolveDidKey,
  x25519PublicKeyToMultibase,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'
import type { JsonValue, ProtocolCryptoAdapter } from '../src/protocol'

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')
const deviceDelegation = loadSpecVector('./fixtures/wot-spec/device-delegation.json')
const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

function loadSpecVector(relativePath: string): any {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
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

describe('WoT protocol interop vectors', () => {
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

    const didDocument = resolveDidKey(phase1.identity.did, {
      keyAgreement: phase1.did_resolution.did_document.keyAgreement,
      service: phase1.did_resolution.did_document.service,
    })
    const didDocumentHash = await cryptoAdapter.sha256(canonicalizeToBytes(didDocument as unknown as JsonValue))
    expect(didDocument).toEqual(phase1.did_resolution.did_document)
    expect(bytesToHex(didDocumentHash)).toBe(phase1.did_resolution.jcs_sha256)
  })

  it('canonicalizes and verifies the attestation VC-JWS vector', async () => {
    const payloadHash = await cryptoAdapter.sha256(canonicalizeToBytes(phase1.attestation_vc_jws.payload as JsonValue))

    expect(bytesToHex(payloadHash)).toBe(phase1.attestation_vc_jws.payload_jcs_sha256)

    const payload = await verifyAttestationVcJws(phase1.attestation_vc_jws.jws, { crypto: cryptoAdapter })
    expect(payload).toEqual(phase1.attestation_vc_jws.payload)
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
      body: { ...message.body, action: 'joined' },
    })).toThrow('Invalid member-update body action')
    expect(() => parseMemberUpdateMessage({
      ...message,
      body: { ...message.body, members: [message.body.memberDid] },
    })).toThrow('Invalid member-update body property: members')
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
})
