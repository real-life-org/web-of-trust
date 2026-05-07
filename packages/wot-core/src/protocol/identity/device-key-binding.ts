import type { ProtocolCryptoAdapter } from '../crypto/ports'
import type { JcsEd25519SignFn } from '../crypto/jws'
import { createJcsEd25519Jws, createJcsEd25519JwsWithSigner, decodeJws, verifyJwsWithPublicKey } from '../crypto/jws'
import type { JsonValue } from '../crypto/jcs'
import { didKeyToPublicKeyBytes, didOrKidToDid, ed25519PublicKeyToMultibase } from './did-key'

export type DeviceCapability = 'sign-log-entry' | 'sign-verification' | 'sign-attestation' | 'broker-auth' | 'device-admin'

const DEVICE_CAPABILITIES = new Set<DeviceCapability>([
  'sign-log-entry',
  'sign-verification',
  'sign-attestation',
  'broker-auth',
  'device-admin',
])
const RFC3339_DATE_TIME_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/

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
  const { header, payload } = decodeJws<{ alg?: string; kid?: string; typ?: string }, unknown>(jws)
  assertRecord(header, 'Invalid DeviceKeyBinding header')
  if (header.alg !== 'EdDSA') throw new Error('Invalid DeviceKeyBinding alg')
  if (header.typ !== 'wot-device-key-binding+jwt') throw new Error('Invalid DeviceKeyBinding typ')
  if (typeof header.kid !== 'string' || header.kid.length === 0) throw new Error('Missing DeviceKeyBinding kid')

  await verifyJwsWithPublicKey(jws, {
    publicKey: didKeyToPublicKeyBytes(header.kid),
    crypto: options.crypto,
  })
  assertDeviceBindingPayload(payload)
  if (payload.iss !== didOrKidToDid(header.kid)) throw new Error('DeviceKeyBinding issuer mismatch')
  return payload
}

// Spec: Identity 004 "DeviceKeyBinding" payload/JWS-header tables and
// schemas/device-key-binding.schema.json define required fields, unique known
// capabilities, integer-second iat, and RFC3339 validity-window instants.
function assertDeviceBindingPayload(payload: unknown): asserts payload is DeviceKeyBindingPayload {
  assertRecord(payload, 'Invalid DeviceKeyBinding payload')
  if (payload.type !== 'device-key-binding') throw new Error('Invalid DeviceKeyBinding type')
  if (typeof payload.iss !== 'string' || payload.iss.length === 0) throw new Error('Missing DeviceKeyBinding iss')
  if (typeof payload.deviceKid !== 'string' || payload.deviceKid.length === 0) {
    throw new Error('Missing DeviceKeyBinding deviceKid')
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('Missing DeviceKeyBinding sub')
  if (typeof payload.devicePublicKeyMultibase !== 'string' || payload.devicePublicKeyMultibase.length === 0) {
    throw new Error('Missing DeviceKeyBinding devicePublicKeyMultibase')
  }
  if (payload.deviceName !== undefined && (typeof payload.deviceName !== 'string' || payload.deviceName.length === 0)) {
    throw new Error('Invalid DeviceKeyBinding deviceName')
  }
  assertDeviceCapabilities(payload.capabilities)
  integerSeconds(payload.iat, 'Invalid DeviceKeyBinding iat')
  const validFrom = rfc3339InstantMilliseconds(payload.validFrom, 'Missing DeviceKeyBinding validFrom', 'Invalid DeviceKeyBinding validFrom')
  const validUntil = rfc3339InstantMilliseconds(payload.validUntil, 'Missing DeviceKeyBinding validUntil', 'Invalid DeviceKeyBinding validUntil')
  if (validFrom > validUntil) throw new Error('DeviceKeyBinding validity window is reversed')
  if (payload.sub !== payload.deviceKid) throw new Error('DeviceKeyBinding sub/deviceKid mismatch')
  const devicePublicKey = didKeyToPublicKeyBytes(payload.deviceKid)
  if (payload.devicePublicKeyMultibase !== ed25519PublicKeyToMultibase(devicePublicKey)) {
    throw new Error('DeviceKeyBinding public key mismatch')
  }
}

function assertDeviceCapabilities(value: unknown): asserts value is DeviceCapability[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Invalid DeviceKeyBinding capabilities')
  const seen = new Set<string>()
  for (const capability of value) {
    if (typeof capability !== 'string' || !DEVICE_CAPABILITIES.has(capability as DeviceCapability)) {
      throw new Error('Unknown DeviceKeyBinding capability')
    }
    if (seen.has(capability)) throw new Error('Duplicate DeviceKeyBinding capability')
    seen.add(capability)
  }
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
}

function integerSeconds(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(message)
  return value
}

function rfc3339InstantMilliseconds(value: unknown, missingMessage: string, invalidMessage: string): number {
  if (typeof value !== 'string' || value.length === 0) throw new Error(missingMessage)
  const match = RFC3339_DATE_TIME_WITH_ZONE.exec(value)
  if (!match) throw new Error(invalidMessage)
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
    throw new Error(invalidMessage)
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
    throw new Error(invalidMessage)
  }

  const offsetMinutes = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute)
  const time = localTime + fractionalMillisecond - offsetMinutes * 60_000
  if (!Number.isFinite(time)) throw new Error(invalidMessage)
  return time
}

function fractionalMilliseconds(fractionalText: string): number {
  if (fractionalText.length === 0) return 0
  return Number(`0${fractionalText}`) * 1000
}
