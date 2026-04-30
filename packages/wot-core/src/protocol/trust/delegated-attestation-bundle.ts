import type { ProtocolCryptoAdapter } from '../crypto/ports'
import type { AttestationVcPayload } from './attestation-vc-jws'
import type { DeviceCapability, DeviceKeyBindingPayload } from '../identity/device-key-binding'
import { verifyDeviceKeyBindingJws } from '../identity/device-key-binding'
import { didKeyToPublicKeyBytes } from '../identity/did-key'
import type { JcsEd25519SignFn } from '../crypto/jws'
import { createJcsEd25519Jws, createJcsEd25519JwsWithSigner, decodeJws, verifyJwsWithPublicKey } from '../crypto/jws'
import type { JsonValue } from '../crypto/jcs'

export interface DelegatedAttestationBundle {
  type: 'wot-delegated-attestation-bundle/v1'
  attestationJws: string
  deviceKeyBindingJws: string
}

export interface CreateDelegatedAttestationBundleOptions {
  attestationPayload: AttestationVcPayload
  deviceKid: string
  deviceSigningSeed: Uint8Array
  deviceKeyBindingJws: string
}

export interface CreateDelegatedAttestationBundleWithSignerOptions {
  attestationPayload: AttestationVcPayload
  deviceKid: string
  sign: JcsEd25519SignFn
  deviceKeyBindingJws: string
}

export interface VerifyDelegatedAttestationBundleOptions {
  crypto: ProtocolCryptoAdapter
  requiredCapability?: DeviceCapability
}

export async function createDelegatedAttestationBundle(
  options: CreateDelegatedAttestationBundleOptions,
): Promise<DelegatedAttestationBundle> {
  const attestationJws = await createJcsEd25519Jws(
    { alg: 'EdDSA', kid: options.deviceKid, typ: 'vc+jwt' },
    options.attestationPayload as unknown as JsonValue,
    options.deviceSigningSeed,
  )

  return {
    type: 'wot-delegated-attestation-bundle/v1',
    attestationJws,
    deviceKeyBindingJws: options.deviceKeyBindingJws,
  }
}

export async function createDelegatedAttestationBundleWithSigner(
  options: CreateDelegatedAttestationBundleWithSignerOptions,
): Promise<DelegatedAttestationBundle> {
  const attestationJws = await createJcsEd25519JwsWithSigner(
    { alg: 'EdDSA', kid: options.deviceKid, typ: 'vc+jwt' },
    options.attestationPayload as unknown as JsonValue,
    options.sign,
  )

  return {
    type: 'wot-delegated-attestation-bundle/v1',
    attestationJws,
    deviceKeyBindingJws: options.deviceKeyBindingJws,
  }
}

export async function verifyDelegatedAttestationBundle(
  bundle: DelegatedAttestationBundle,
  options: VerifyDelegatedAttestationBundleOptions,
): Promise<{ attestationPayload: Record<string, unknown>; bindingPayload: DeviceKeyBindingPayload }> {
  if (bundle.type !== 'wot-delegated-attestation-bundle/v1') throw new Error('Invalid delegated attestation bundle type')
  const requiredCapability = options.requiredCapability ?? 'sign-attestation'
  const bindingPayload = await verifyDeviceKeyBindingJws(bundle.deviceKeyBindingJws, { crypto: options.crypto })
  const { header: attestationHeader, payload: attestationPayload } = decodeJws<{ alg?: string; kid?: string }, Record<string, unknown>>(bundle.attestationJws)
  if (attestationHeader.alg !== 'EdDSA') throw new Error('Invalid attestation alg')
  if (attestationHeader.kid !== bindingPayload.deviceKid) throw new Error('Attestation kid does not match deviceKid')

  await verifyJwsWithPublicKey(bundle.attestationJws, {
    publicKey: didKeyToPublicKeyBytes(bindingPayload.deviceKid),
    crypto: options.crypto,
  })

  if (attestationPayload.issuer !== bindingPayload.iss || attestationPayload.iss !== bindingPayload.iss) {
    throw new Error('Delegated attestation issuer mismatch')
  }
  if (!bindingPayload.capabilities.includes(requiredCapability)) throw new Error('Missing required device capability')
  if (typeof attestationPayload.iat !== 'number') throw new Error('Delegated attestation requires iat')
  const validFrom = Date.parse(bindingPayload.validFrom) / 1000
  const validUntil = Date.parse(bindingPayload.validUntil) / 1000
  if (!(validFrom <= attestationPayload.iat && attestationPayload.iat <= validUntil)) {
    throw new Error('Attestation iat outside delegation window')
  }

  return { attestationPayload, bindingPayload }
}
