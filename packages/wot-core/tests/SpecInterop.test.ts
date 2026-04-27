import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeToBytes,
  createAttestationVcJws,
  createDelegatedAttestationBundle,
  createDeviceKeyBindingJws,
  createLogEntryJws,
  createSpaceCapabilityJws,
  deriveSpecIdentityFromSeedHex,
  ed25519PublicKeyToMultibase,
  ed25519MultibaseToPublicKeyBytes,
  verifyAttestationVcJws,
  verifyDelegatedAttestationBundle,
  verifyDeviceKeyBindingJws,
  verifyLogEntryJws,
  verifySpaceCapabilityJws,
  x25519PublicKeyToMultibase,
} from '../src/spec'
import { WebCryptoSpecCryptoAdapter } from '../src/spec-adapters'
import type { JsonValue } from '../src/spec'

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')
const deviceDelegation = loadSpecVector('./fixtures/wot-spec/device-delegation.json')
const cryptoAdapter = new WebCryptoSpecCryptoAdapter()

function loadSpecVector(relativePath: string): any {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

describe('WoT spec interop vectors', () => {
  it('derives identity material from the phase-1 vector', async () => {
    const identity = await deriveSpecIdentityFromSeedHex(phase1.identity.bip39_seed_hex, cryptoAdapter)

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
