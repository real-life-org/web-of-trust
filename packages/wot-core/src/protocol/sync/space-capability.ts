import type { ProtocolCryptoAdapter } from '../crypto/ports'
import type { JsonValue } from '../crypto/jcs'
import { createJcsEd25519Jws, verifyJwsWithPublicKey } from '../crypto/jws'

export type SpaceCapabilityPermission = 'read' | 'write'

export interface SpaceCapabilityPayload {
  type: 'capability'
  spaceId: string
  audience: string
  permissions: SpaceCapabilityPermission[]
  generation: number
  issuedAt: string
  validUntil: string
}

export interface CreateSpaceCapabilityJwsOptions {
  payload: SpaceCapabilityPayload
  signingSeed: Uint8Array
}

export interface VerifySpaceCapabilityJwsOptions {
  crypto: ProtocolCryptoAdapter
  publicKey: Uint8Array
  expectedSpaceId?: string
  expectedAudience?: string
  expectedGeneration?: number
  now?: Date
}

const CAPABILITY_PAYLOAD_KEYS = [
  'audience',
  'generation',
  'issuedAt',
  'permissions',
  'spaceId',
  'type',
  'validUntil',
]
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DID_PATTERN = /^did:[a-z0-9]+:.+/
const RFC3339_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/

export async function createSpaceCapabilityJws(options: CreateSpaceCapabilityJwsOptions): Promise<string> {
  assertSpaceCapabilityPayload(options.payload)
  return createJcsEd25519Jws(
    { alg: 'EdDSA', kid: capabilityKid(options.payload), typ: 'wot-capability+jwt' },
    options.payload as unknown as JsonValue,
    options.signingSeed,
  )
}

export async function verifySpaceCapabilityJws(
  jws: string,
  options: VerifySpaceCapabilityJwsOptions,
): Promise<SpaceCapabilityPayload> {
  const { header, payload } = await verifyJwsWithPublicKey(jws, {
    publicKey: options.publicKey,
    crypto: options.crypto,
  })
  if (header.alg !== 'EdDSA') throw new Error('Invalid capability alg')
  if (header.typ !== 'wot-capability+jwt') throw new Error('Invalid capability typ')
  assertSpaceCapabilityPayload(payload)
  if (header.kid !== capabilityKid(payload)) throw new Error('Capability kid mismatch')

  assertSpaceCapabilityContext(payload, options)
  return payload
}

function capabilityKid(payload: SpaceCapabilityPayload): string {
  return `wot:space:${payload.spaceId}#cap-${payload.generation}`
}

function assertSpaceCapabilityPayload(payload: unknown): asserts payload is SpaceCapabilityPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid capability payload')
  }
  assertCapabilityPayloadKeys(payload)

  const candidate = payload as Record<string, unknown>
  if (candidate.type !== 'capability') throw new Error('Invalid capability type')
  if (typeof candidate.spaceId !== 'string' || !UUID_PATTERN.test(candidate.spaceId)) {
    throw new Error('Invalid capability spaceId')
  }
  if (typeof candidate.audience !== 'string' || !DID_PATTERN.test(candidate.audience)) {
    throw new Error('Invalid capability audience')
  }
  assertCapabilityPermissions(candidate.permissions)
  const generation = candidate.generation
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
    throw new Error('Invalid capability generation')
  }
  assertRfc3339DateTime(candidate.issuedAt, 'issuedAt')
  assertRfc3339DateTime(candidate.validUntil, 'validUntil')
}

function assertSpaceCapabilityContext(
  payload: SpaceCapabilityPayload,
  options: VerifySpaceCapabilityJwsOptions,
): void {
  if (payload.type !== 'capability') throw new Error('Invalid capability type')
  if (options.expectedSpaceId !== undefined && payload.spaceId !== options.expectedSpaceId) {
    throw new Error('Capability spaceId mismatch')
  }
  if (options.expectedAudience !== undefined && payload.audience !== options.expectedAudience) {
    throw new Error('Capability audience mismatch')
  }
  if (options.expectedGeneration !== undefined && payload.generation !== options.expectedGeneration) {
    throw new Error('Capability generation mismatch')
  }
  if (options.now && options.now.getTime() >= Date.parse(payload.validUntil)) throw new Error('Capability expired')
}

function assertCapabilityPayloadKeys(payload: object): void {
  const keys = Object.keys(payload).sort()
  if (
    keys.length !== CAPABILITY_PAYLOAD_KEYS.length ||
    keys.some((key, index) => key !== CAPABILITY_PAYLOAD_KEYS[index])
  ) {
    throw new Error('Invalid capability payload fields')
  }
}

function assertCapabilityPermissions(permissions: unknown): asserts permissions is SpaceCapabilityPermission[] {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw new Error('Invalid capability permissions')
  }
  const seen = new Set<string>()
  for (const permission of permissions) {
    if (permission !== 'read' && permission !== 'write') throw new Error('Invalid capability permission')
    if (seen.has(permission)) throw new Error('Duplicate capability permission')
    seen.add(permission)
  }
}

function assertRfc3339DateTime(value: unknown, field: 'issuedAt' | 'validUntil'): asserts value is string {
  if (typeof value !== 'string') throw new Error(`Invalid capability ${field}`)
  const match = RFC3339_DATE_TIME_PATTERN.exec(value)
  if (!match || !hasValidDateTimeParts(match) || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid capability ${field}`)
  }
}

function hasValidDateTimeParts(match: RegExpExecArray): boolean {
  const year = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const day = Number.parseInt(match[3], 10)
  const hour = Number.parseInt(match[4], 10)
  const minute = Number.parseInt(match[5], 10)
  const second = Number.parseInt(match[6], 10)
  const timezone = match[8]
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  if (timezone === 'Z') return true
  const offsetHour = Number.parseInt(timezone.slice(1, 3), 10)
  const offsetMinute = Number.parseInt(timezone.slice(4, 6), 10)
  return offsetHour <= 23 && offsetMinute <= 59
}
