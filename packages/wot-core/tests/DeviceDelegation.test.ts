import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createDelegatedAttestationBundle,
  createDeviceKeyBindingJws,
  createJcsEd25519Jws,
  verifyDelegatedAttestationBundle,
  verifyDeviceKeyBindingJws,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'
import type { DeviceKeyBindingPayload, JsonValue } from '../src/protocol'

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')
const deviceDelegation = loadSpecVector('./fixtures/wot-spec/device-delegation.json')
const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

function loadSpecFixtureText(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

function loadSpecVector(relativePath: string): any {
  return JSON.parse(loadSpecFixtureText(relativePath))
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

async function signedDeviceBinding(
  payload: Record<string, unknown>,
  header: Record<string, JsonValue> = deviceDelegation.device_key_binding_jws.header,
): Promise<string> {
  return createJcsEd25519Jws(
    header,
    payload as JsonValue,
    hexToBytes(phase1.identity.ed25519_seed_hex),
  )
}

async function signedDelegatedAttestation(
  payload: Record<string, unknown>,
  header: Record<string, JsonValue> = deviceDelegation.delegated_attestation_bundle.attestationHeader,
): Promise<string> {
  return createJcsEd25519Jws(
    header,
    payload as JsonValue,
    hexToBytes(deviceDelegation.device.seed_hex),
  )
}

async function bundleWith(
  overrides: {
    attestationPayload?: Record<string, unknown>
    attestationHeader?: Record<string, JsonValue>
    bindingPayload?: Record<string, unknown>
    bundle?: Record<string, unknown>
  },
): Promise<Record<string, unknown>> {
  const attestationJws = await signedDelegatedAttestation(
    overrides.attestationPayload ?? deviceDelegation.delegated_attestation_bundle.attestationPayload,
    overrides.attestationHeader,
  )
  const deviceKeyBindingJws = await signedDeviceBinding(
    overrides.bindingPayload ?? deviceDelegation.device_key_binding_jws.payload,
  )

  return {
    ...deviceDelegation.delegated_attestation_bundle.bundle,
    attestationJws,
    deviceKeyBindingJws,
    ...overrides.bundle,
  }
}

describe('Device delegation protocol verification', () => {
  it('preserves device delegation vector create and verify parity', async () => {
    const deviceKeyBindingJws = await createDeviceKeyBindingJws({
      payload: deviceDelegation.device_key_binding_jws.payload,
      issuerKid: deviceDelegation.device_key_binding_jws.header.kid,
      signingSeed: hexToBytes(phase1.identity.ed25519_seed_hex),
    })
    expect(deviceKeyBindingJws).toBe(deviceDelegation.device_key_binding_jws.jws)

    const binding = await verifyDeviceKeyBindingJws(deviceDelegation.device_key_binding_jws.jws, {
      crypto: cryptoAdapter,
    })
    expect(binding).toEqual(deviceDelegation.device_key_binding_jws.payload)

    const bundle = await createDelegatedAttestationBundle({
      attestationPayload: deviceDelegation.delegated_attestation_bundle.attestationPayload,
      deviceKid: deviceDelegation.delegated_attestation_bundle.attestationHeader.kid,
      deviceSigningSeed: hexToBytes(deviceDelegation.device.seed_hex),
      deviceKeyBindingJws,
    })
    expect(bundle).toEqual(deviceDelegation.delegated_attestation_bundle.bundle)

    const verified = await verifyDelegatedAttestationBundle(deviceDelegation.delegated_attestation_bundle.bundle, {
      crypto: cryptoAdapter,
      now: new Date('2026-05-03T10:00:00Z'),
    })
    expect(verified.bindingPayload).toEqual(deviceDelegation.device_key_binding_jws.payload)
    expect(verified.attestationPayload).toEqual(deviceDelegation.delegated_attestation_bundle.attestationPayload)
  })

  it('rejects DeviceKeyBinding payloads with missing or invalid required fields', async () => {
    const validPayload = deviceDelegation.device_key_binding_jws.payload
    const invalidPayloads: Array<[string, Record<string, unknown>, string]> = [
      ['missing capabilities', omit(validPayload, 'capabilities'), 'Invalid DeviceKeyBinding capabilities'],
      ['empty capabilities', { ...validPayload, capabilities: [] }, 'Invalid DeviceKeyBinding capabilities'],
      ['duplicate capabilities', {
        ...validPayload,
        capabilities: ['sign-attestation', 'sign-attestation'],
      }, 'Duplicate DeviceKeyBinding capability'],
      ['unknown capability', {
        ...validPayload,
        capabilities: ['sign-attestation', 'publish-profile'],
      }, 'Unknown DeviceKeyBinding capability'],
      ['missing validFrom', omit(validPayload, 'validFrom'), 'Missing DeviceKeyBinding validFrom'],
      ['invalid validFrom', { ...validPayload, validFrom: '2026-02-30T10:00:00Z' }, 'Invalid DeviceKeyBinding validFrom'],
      ['invalid validUntil', { ...validPayload, validUntil: '2027-04-27T10:00:00' }, 'Invalid DeviceKeyBinding validUntil'],
      ['reversed validity window', {
        ...validPayload,
        validFrom: '2027-04-27T10:00:01Z',
      }, 'DeviceKeyBinding validity window is reversed'],
      ['fractional reversed validity window', {
        ...validPayload,
        validFrom: '2026-04-27T10:00:00.0009Z',
        validUntil: '2026-04-27T10:00:00.0001Z',
      }, 'DeviceKeyBinding validity window is reversed'],
      ['missing iat', omit(validPayload, 'iat'), 'Invalid DeviceKeyBinding iat'],
      ['fractional iat', { ...validPayload, iat: 1777284000.5 }, 'Invalid DeviceKeyBinding iat'],
      ['negative iat', { ...validPayload, iat: -1 }, 'Invalid DeviceKeyBinding iat'],
      ['empty issuer', { ...validPayload, iss: '' }, 'Missing DeviceKeyBinding iss'],
      ['non-string subject', { ...validPayload, sub: 123 }, 'Missing DeviceKeyBinding sub'],
      ['empty device kid', { ...validPayload, sub: '', deviceKid: '' }, 'Missing DeviceKeyBinding deviceKid'],
      ['non-string device multibase', {
        ...validPayload,
        devicePublicKeyMultibase: 123,
      }, 'Missing DeviceKeyBinding devicePublicKeyMultibase'],
    ]

    for (const [name, payload, expectedError] of invalidPayloads) {
      const jws = await signedDeviceBinding(payload)
      await expect(
        verifyDeviceKeyBindingJws(jws, { crypto: cryptoAdapter }),
        name,
      ).rejects.toThrow(expectedError)
    }
  })

  it('rejects delegated attestation bundle container and JOSE-header mismatches', async () => {
    const invalidBundles: Array<[string, Record<string, unknown>, string]> = [
      ['extra bundle property', await bundleWith({ bundle: { extra: true } }), 'Invalid delegated attestation bundle field'],
      ['non-compact attestation JWS', await bundleWith({ bundle: { attestationJws: 'not-a-jws' } }), 'Invalid delegated attestation bundle attestationJws'],
      ['non-compact binding JWS', await bundleWith({ bundle: { deviceKeyBindingJws: 'not-a-jws' } }), 'Invalid delegated attestation bundle deviceKeyBindingJws'],
      ['invalid attestation typ', await bundleWith({
        attestationHeader: {
          alg: 'EdDSA',
          kid: deviceDelegation.delegated_attestation_bundle.attestationHeader.kid,
          typ: 'JWT',
        },
      }), 'Invalid attestation JWS typ'],
    ]

    for (const [name, bundle, expectedError] of invalidBundles) {
      await expect(
        verifyDelegatedAttestationBundle(bundle as any, {
          crypto: cryptoAdapter,
          now: new Date('2026-05-03T10:00:00Z'),
        }),
        name,
      ).rejects.toThrow(expectedError)
    }
  })

  it('rejects delegated attestations with invalid iat and delegation-window boundaries', async () => {
    const validPayload = deviceDelegation.delegated_attestation_bundle.attestationPayload
    const invalidCases: Array<[string, Record<string, unknown>, string | RegExp]> = [
      ['missing iat', omit(validPayload, 'iat'), /Delegated attestation requires iat|Invalid delegated attestation iat/],
      ['fractional iat', { ...validPayload, iat: 1777802400.5 }, 'Invalid delegated attestation iat'],
      ['negative iat', { ...validPayload, iat: -1 }, 'Invalid delegated attestation iat'],
      ['iat before normalized validFrom', { ...validPayload, iat: 1777283999 }, 'Attestation iat outside delegation window'],
      ['iat after normalized validUntil', { ...validPayload, iat: 1808820001 }, 'Attestation iat outside delegation window'],
    ]

    for (const [name, attestationPayload, expectedError] of invalidCases) {
      await expect(
        verifyDelegatedAttestationBundle(await bundleWith({ attestationPayload }) as any, {
          crypto: cryptoAdapter,
          now: new Date('2026-05-03T10:00:00Z'),
        }),
        name,
      ).rejects.toThrow(expectedError)
    }

    await expect(
      verifyDelegatedAttestationBundle(await bundleWith({
        bindingPayload: {
          ...deviceDelegation.device_key_binding_jws.payload,
          validFrom: '2026-05-03T10:00:00.0001Z',
        },
      }) as any, {
        crypto: cryptoAdapter,
        now: new Date('2026-05-03T10:00:00Z'),
      }),
      'iat before fractional validFrom',
    ).rejects.toThrow('Attestation iat outside delegation window')

    await expect(
      verifyDelegatedAttestationBundle(await bundleWith({
        bindingPayload: {
          ...deviceDelegation.device_key_binding_jws.payload,
          validUntil: '2026-05-03T09:59:59.999Z',
        },
      }) as any, {
        crypto: cryptoAdapter,
        now: new Date('2026-05-03T10:00:00Z'),
      }),
      'iat after fractional validUntil',
    ).rejects.toThrow('Attestation iat outside delegation window')
  })

  it('applies compatible Trust 001 payload rules to delegated attestations', async () => {
    const validPayload = deviceDelegation.delegated_attestation_bundle.attestationPayload
    const invalidPayloads: Array<[string, Record<string, unknown>, string]> = [
      ['missing VC context', {
        ...validPayload,
        '@context': ['https://web-of-trust.de/vocab/v1'],
      }, 'Missing VC context'],
      ['missing WotAttestation type', {
        ...validPayload,
        type: ['VerifiableCredential'],
      }, 'Missing WotAttestation type'],
      ['issuer mismatch', { ...validPayload, issuer: validPayload.sub }, 'Delegated attestation issuer mismatch'],
      ['credentialSubject/sub mismatch', {
        ...validPayload,
        credentialSubject: { ...validPayload.credentialSubject, id: validPayload.issuer },
      }, 'Attestation subject mismatch'],
      ['missing claim', {
        ...validPayload,
        credentialSubject: { id: validPayload.credentialSubject.id },
      }, 'Missing credentialSubject claim'],
      ['validFrom and nbf mismatch', { ...validPayload, nbf: 1777802401 }, 'Attestation validFrom and nbf differ'],
      ['future nbf', {
        ...validPayload,
        validFrom: '2026-05-04T10:00:00Z',
        nbf: 1777888800,
        iat: 1777888800,
      }, 'Attestation not yet valid'],
      ['expired exp', { ...validPayload, exp: 1777802399 }, 'Attestation expired'],
    ]

    for (const [name, attestationPayload, expectedError] of invalidPayloads) {
      await expect(
        verifyDelegatedAttestationBundle(await bundleWith({ attestationPayload }) as any, {
          crypto: cryptoAdapter,
          now: new Date('2026-05-03T10:00:00Z'),
        }),
        name,
      ).rejects.toThrow(expectedError)
    }
  })

  it('checks the requested delegated capability explicitly', async () => {
    const bindingPayload = {
      ...deviceDelegation.device_key_binding_jws.payload,
      capabilities: ['sign-verification'],
    } satisfies DeviceKeyBindingPayload

    await expect(
      verifyDelegatedAttestationBundle(await bundleWith({ bindingPayload }) as any, {
        crypto: cryptoAdapter,
        requiredCapability: 'sign-attestation',
        now: new Date('2026-05-03T10:00:00Z'),
      }),
    ).rejects.toThrow('Missing required device capability')

    await expect(
      verifyDelegatedAttestationBundle(await bundleWith({ bindingPayload }) as any, {
        crypto: cryptoAdapter,
        requiredCapability: 'sign-verification',
        now: new Date('2026-05-03T10:00:00Z'),
      }),
    ).resolves.toMatchObject({
      attestationPayload: deviceDelegation.delegated_attestation_bundle.attestationPayload,
      bindingPayload,
    })
  })
})

function omit<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _removed, ...rest } = value
  return rest
}
