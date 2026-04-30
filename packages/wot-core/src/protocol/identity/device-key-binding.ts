import type { ProtocolCryptoAdapter } from '../crypto/ports'
import type { JcsEd25519SignFn } from '../crypto/jws'
import { createJcsEd25519Jws, createJcsEd25519JwsWithSigner, decodeJws, verifyJwsWithPublicKey } from '../crypto/jws'
import type { JsonValue } from '../crypto/jcs'
import { didKeyToPublicKeyBytes, didOrKidToDid, ed25519PublicKeyToMultibase } from './did-key'

export type DeviceCapability = 'sign-log-entry' | 'sign-verification' | 'sign-attestation' | 'broker-auth' | 'device-admin'

export interface DeviceKeyBindingPayload {
  type: 'device-key-binding'
  iss: string
  sub: string
  deviceKid: string
  devicePublicKeyMultibase: string
  deviceName?: string
  capabilities: DeviceCapability[]
  validFrom: string
  validUntil: string
  iat: number
}

export interface CreateDeviceKeyBindingJwsOptions {
  payload: DeviceKeyBindingPayload
  issuerKid: string
  signingSeed: Uint8Array
}

export interface CreateDeviceKeyBindingJwsWithSignerOptions {
  payload: DeviceKeyBindingPayload
  issuerKid: string
  sign: JcsEd25519SignFn
}

export interface VerifyDeviceKeyBindingJwsOptions {
  crypto: ProtocolCryptoAdapter
}

export async function createDeviceKeyBindingJws(options: CreateDeviceKeyBindingJwsOptions): Promise<string> {
  if (options.payload.iss !== didOrKidToDid(options.issuerKid)) throw new Error('DeviceKeyBinding issuer mismatch')
  assertDeviceBindingPayload(options.payload)

  return createJcsEd25519Jws(
    { alg: 'EdDSA', kid: options.issuerKid, typ: 'wot-device-key-binding+jwt' },
    options.payload as unknown as JsonValue,
    options.signingSeed,
  )
}

export async function createDeviceKeyBindingJwsWithSigner(
  options: CreateDeviceKeyBindingJwsWithSignerOptions,
): Promise<string> {
  if (options.payload.iss !== didOrKidToDid(options.issuerKid)) throw new Error('DeviceKeyBinding issuer mismatch')
  assertDeviceBindingPayload(options.payload)

  return createJcsEd25519JwsWithSigner(
    { alg: 'EdDSA', kid: options.issuerKid, typ: 'wot-device-key-binding+jwt' },
    options.payload as unknown as JsonValue,
    options.sign,
  )
}

export async function verifyDeviceKeyBindingJws(
  jws: string,
  options: VerifyDeviceKeyBindingJwsOptions,
): Promise<DeviceKeyBindingPayload> {
  const { header, payload } = decodeJws<{ alg?: string; kid?: string; typ?: string }, DeviceKeyBindingPayload>(jws)
  if (header.alg !== 'EdDSA') throw new Error('Invalid DeviceKeyBinding alg')
  if (header.typ !== 'wot-device-key-binding+jwt') throw new Error('Invalid DeviceKeyBinding typ')
  if (!header.kid) throw new Error('Missing DeviceKeyBinding kid')
  if (payload.type !== 'device-key-binding') throw new Error('Invalid DeviceKeyBinding type')
  if (payload.iss !== didOrKidToDid(header.kid)) throw new Error('DeviceKeyBinding issuer mismatch')

  await verifyJwsWithPublicKey(jws, {
    publicKey: didKeyToPublicKeyBytes(header.kid),
    crypto: options.crypto,
  })
  assertDeviceBindingPayload(payload)
  return payload
}

function assertDeviceBindingPayload(payload: DeviceKeyBindingPayload): void {
  if (payload.sub !== payload.deviceKid) throw new Error('DeviceKeyBinding sub/deviceKid mismatch')
  const devicePublicKey = didKeyToPublicKeyBytes(payload.deviceKid)
  if (payload.devicePublicKeyMultibase !== ed25519PublicKeyToMultibase(devicePublicKey)) {
    throw new Error('DeviceKeyBinding public key mismatch')
  }
}
