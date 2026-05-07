import type { ProtocolCryptoAdapter } from '../crypto/ports'
import type { AttestationVcPayload } from './attestation-vc-jws'
import { assertAttestationVcPayload } from './attestation-vc-jws'
import type { DeviceCapability, DeviceKeyBindingPayload } from '../identity/device-key-binding'
import { verifyDeviceKeyBindingJws } from '../identity/device-key-binding'
import { didKeyToPublicKeyBytes } from '../identity/did-key'
import type { JcsEd25519SignFn } from '../crypto/jws'
import { createJcsEd25519Jws, createJcsEd25519JwsWithSigner, decodeJws, verifyJwsWithPublicKey } from '../crypto/jws'
import type { JsonValue } from '../crypto/jcs'

const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const RFC3339_DATE_TIME_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/

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
  now?: Date
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
  bundle: unknown,
  options: VerifyDelegatedAttestationBundleOptions,
): Promise<{ attestationPayload: AttestationVcPayload; bindingPayload: DeviceKeyBindingPayload }> {
  // Spec: Identity 004 "Delegated-Attestation-Bundle" plus
  // schemas/delegated-attestation-bundle.schema.json define the exact offline
  // container shape and compact JWS fields.
  assertDelegatedAttestationBundle(bundle)
  const requiredCapability = options.requiredCapability ?? 'sign-attestation'
  // Spec: Identity 004 verification steps 2-6 bind the DeviceKeyBinding JWS to
  // the delegating Identity DID, the device DID URL, and the device public key.
  const bindingPayload = await verifyDeviceKeyBindingJws(bundle.deviceKeyBindingJws, { crypto: options.crypto })
  const { header: attestationHeader, payload: attestationPayload } = decodeJws<{ alg?: string; kid?: string; typ?: string }, unknown>(bundle.attestationJws)
  // Spec: Identity 004 verification steps 5 and 7 require the attestation JWS
  // to use the delegated device key before Trust-001 payload checks are applied.
  if (!isRecord(attestationHeader)) throw new Error('Invalid attestation JWS header')
  if (attestationHeader.alg !== 'EdDSA') throw new Error('Invalid attestation alg')
  if (attestationHeader.typ !== 'vc+jwt') throw new Error('Invalid attestation JWS typ')
  if (attestationHeader.kid !== bindingPayload.deviceKid) throw new Error('Attestation kid does not match deviceKid')

  await verifyJwsWithPublicKey(bundle.attestationJws, {
    publicKey: didKeyToPublicKeyBytes(bindingPayload.deviceKid),
    crypto: options.crypto,
  })

  // Spec: Identity 004 verification steps 8 and 11 keep issuer/iss as the
  // Identity DID while reusing the normal Trust-001 VC payload rules.
  if (isRecord(attestationPayload)) {
    if (
      (typeof attestationPayload.issuer === 'string' && attestationPayload.issuer !== bindingPayload.iss) ||
      (typeof attestationPayload.iss === 'string' && attestationPayload.iss !== bindingPayload.iss)
    ) {
      throw new Error('Delegated attestation issuer mismatch')
    }
  }
  assertAttestationVcPayload(attestationPayload, bindingPayload.deviceKid, {
    now: options.now,
    requireIssuerKidBinding: false,
  })
  if (!bindingPayload.capabilities.includes(requiredCapability)) throw new Error('Missing required device capability')
  if (attestationPayload.iat === undefined) throw new Error('Delegated attestation requires iat')
  const iat = integerSeconds(attestationPayload.iat, 'Invalid delegated attestation iat')
  // [NEEDS CLARIFICATION: wot-device-delegation@0.1 does not yet normatively
  // define fractional validFrom/validUntil boundary precision against
  // integer-second iat; tracked in real-life-org/wot-spec#41.]
  const iatMilliseconds = iat * 1000
  const validFrom = rfc3339InstantMilliseconds(bindingPayload.validFrom, 'Invalid DeviceKeyBinding validFrom')
  const validUntil = rfc3339InstantMilliseconds(bindingPayload.validUntil, 'Invalid DeviceKeyBinding validUntil')
  if (!(validFrom <= iatMilliseconds && iatMilliseconds <= validUntil)) {
    throw new Error('Attestation iat outside delegation window')
  }

  return { attestationPayload, bindingPayload }
}

function assertDelegatedAttestationBundle(bundle: unknown): asserts bundle is DelegatedAttestationBundle {
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) {
    throw new Error('Invalid delegated attestation bundle')
  }
  const keys = Object.keys(bundle)
  for (const key of keys) {
    if (key !== 'type' && key !== 'attestationJws' && key !== 'deviceKeyBindingJws') {
      throw new Error('Invalid delegated attestation bundle field')
    }
  }
  const value = bundle as Record<string, unknown>
  if (value.type !== 'wot-delegated-attestation-bundle/v1') throw new Error('Invalid delegated attestation bundle type')
  if (typeof value.attestationJws !== 'string' || !COMPACT_JWS.test(value.attestationJws)) {
    throw new Error('Invalid delegated attestation bundle attestationJws')
  }
  if (typeof value.deviceKeyBindingJws !== 'string' || !COMPACT_JWS.test(value.deviceKeyBindingJws)) {
    throw new Error('Invalid delegated attestation bundle deviceKeyBindingJws')
  }
}

function integerSeconds(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(message)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rfc3339InstantMilliseconds(value: string, message: string): number {
  const match = RFC3339_DATE_TIME_WITH_ZONE.exec(value)
  if (!match) throw new Error(message)
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionalText = '', zone, sign, offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const fractionalMillisecond = fractionalMilliseconds(fractionalText)
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText)
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText)

  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(message)
  }

  const localTime = Date.UTC(year, month - 1, day, hour, minute, second)
  const localDate = new Date(localTime)
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second
  ) {
    throw new Error(message)
  }

  const offsetMinutes = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute)
  const time = localTime + fractionalMillisecond - offsetMinutes * 60_000
  if (!Number.isFinite(time)) throw new Error(message)
  return time
}

function fractionalMilliseconds(fractionalText: string): number {
  if (fractionalText.length === 0) return 0
  return Number(`0${fractionalText}`) * 1000
}
