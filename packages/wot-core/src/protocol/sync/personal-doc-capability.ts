import type { ProtocolCryptoAdapter } from '../crypto/ports'
import type { JsonValue } from '../crypto/jcs'
import { createJcsEd25519Jws, verifyJwsWithPublicKey } from '../crypto/jws'
import { didOrKidToDid } from '../identity/did-key'

/**
 * Personal-Doc capability (Sync 003 `#persönliche-dokumente`).
 *
 * Reuses the **exact same Capability payload schema** as the Space capability
 * (`#capability-format`) — no separate payload type, no extra `issuer` field —
 * but with the personal-doc bindings:
 * - `kid` is the owner's Identity-Key verification-method id (`<did>#<vm>`,
 *   generic fragment), NOT `wot:space:...`.
 * - `generation` MUST be `0` (personal docs are not rotated in `wot-sync@0.1`).
 * - self-issued: kid-DID == `audience` (== authenticated DID at the broker).
 *
 * This module mirrors `space-capability.ts`. The only divergences are the kid
 * shape and the self-issued enforcement; the payload validation is identical.
 */

export type PersonalDocCapabilityPermission = 'read' | 'write'

export interface PersonalDocCapabilityPayload {
  type: 'capability'
  spaceId: string
  audience: string
  permissions: PersonalDocCapabilityPermission[]
  generation: number
  issuedAt: string
  validUntil: string
}

export interface CreatePersonalDocCapabilityJwsOptions {
  payload: PersonalDocCapabilityPayload
  /**
   * The owner's Identity-Key verification-method id (`<did>#<vm>`). Its DID
   * part MUST equal `payload.audience` (self-issued). Personal-doc capabilities
   * never use a `wot:space:...` kid.
   */
  kid: string
  /** The owner's Identity-Key Ed25519 signing seed (32 bytes). */
  signingSeed: Uint8Array
}

export interface VerifyPersonalDocCapabilityJwsOptions {
  crypto: ProtocolCryptoAdapter
  /**
   * The Ed25519 public key of the authenticated DID's Identity Key. The caller
   * (broker) resolves the authenticated DID to this key; the verifier checks
   * the JWS signature against it AND enforces kid-DID == audience.
   */
  publicKey: Uint8Array
  /** Personal-Doc-ID (= docId). When set, `payload.spaceId` MUST equal it. */
  expectedSpaceId?: string
  /** When set, `payload.audience` MUST equal it (the authenticated DID). */
  expectedAudience?: string
  now?: Date
}

const PERSONAL_DOC_GENERATION = 0
const CAPABILITY_PAYLOAD_KEYS = [
  'audience',
  'generation',
  'issuedAt',
  'permissions',
  'spaceId',
  'type',
  'validUntil',
]
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DID_PATTERN = /^did:[a-z0-9]+:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+(?::(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+)*$/
const RFC3339_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/

export async function createPersonalDocCapabilityJws(
  options: CreatePersonalDocCapabilityJwsOptions,
): Promise<string> {
  assertPersonalDocCapabilityPayload(options.payload)
  assertPersonalDocKid(options.kid, options.payload.audience)
  return createJcsEd25519Jws(
    { alg: 'EdDSA', kid: options.kid, typ: 'wot-capability+jwt' },
    options.payload as unknown as JsonValue,
    options.signingSeed,
  )
}

export async function verifyPersonalDocCapabilityJws(
  jws: string,
  options: VerifyPersonalDocCapabilityJwsOptions,
): Promise<PersonalDocCapabilityPayload> {
  const { header, payload } = await verifyJwsWithPublicKey(jws, {
    publicKey: options.publicKey,
    crypto: options.crypto,
  })
  if (header.typ !== 'wot-capability+jwt') throw new Error('Invalid capability typ')
  assertPersonalDocCapabilityPayload(payload)

  // Self-issued binding (Sync 003): the kid MUST be the owner's Identity-Key
  // verification-method id and its DID part MUST equal `audience`. A space-style
  // `wot:space:...` kid is rejected because it has no DID part.
  const kid = header.kid
  if (typeof kid !== 'string' || !kid.includes('#')) throw new Error('Invalid personal-doc capability kid')
  if (didOrKidToDid(kid) !== payload.audience) {
    throw new Error('Personal-doc capability not self-issued (kid DID != audience)')
  }

  assertPersonalDocCapabilityContext(payload, options)
  return payload
}

function assertPersonalDocKid(kid: unknown, audience: string): asserts kid is string {
  if (typeof kid !== 'string' || !kid.includes('#')) {
    throw new Error('Invalid personal-doc capability kid')
  }
  if (didOrKidToDid(kid) !== audience) {
    throw new Error('Personal-doc capability not self-issued (kid DID != audience)')
  }
}

function assertPersonalDocCapabilityPayload(
  payload: unknown,
): asserts payload is PersonalDocCapabilityPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid capability payload')
  }
  assertCapabilityPayloadKeys(payload)

  const candidate = payload as Record<string, unknown>
  if (candidate.type !== 'capability') throw new Error('Invalid capability type')
  if (typeof candidate.spaceId !== 'string' || !UUID_V4_PATTERN.test(candidate.spaceId)) {
    throw new Error('Invalid capability spaceId')
  }
  if (typeof candidate.audience !== 'string' || !DID_PATTERN.test(candidate.audience)) {
    throw new Error('Invalid capability audience')
  }
  assertCapabilityPermissions(candidate.permissions)
  if (candidate.generation !== PERSONAL_DOC_GENERATION) {
    throw new Error('Invalid personal-doc capability generation')
  }
  assertRfc3339DateTime(candidate.issuedAt, 'issuedAt')
  assertRfc3339DateTime(candidate.validUntil, 'validUntil')
}

function assertPersonalDocCapabilityContext(
  payload: PersonalDocCapabilityPayload,
  options: VerifyPersonalDocCapabilityJwsOptions,
): void {
  if (options.expectedSpaceId !== undefined && payload.spaceId !== options.expectedSpaceId) {
    throw new Error('Capability spaceId mismatch')
  }
  if (options.expectedAudience !== undefined && payload.audience !== options.expectedAudience) {
    throw new Error('Capability audience mismatch')
  }
  if (options.now !== undefined) {
    const now = options.now.getTime()
    if (Number.isNaN(now)) throw new Error('Invalid capability verifier time')
    if (now >= Date.parse(payload.validUntil)) throw new Error('Capability expired')
  }
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

function assertCapabilityPermissions(
  permissions: unknown,
): asserts permissions is PersonalDocCapabilityPermission[] {
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
  if (month < 1 || month > 12) return false
  if (day < 1 || day > daysInMonth(year, month)) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  if (timezone === 'Z') return true
  const offsetHour = Number.parseInt(timezone.slice(1, 3), 10)
  const offsetMinute = Number.parseInt(timezone.slice(4, 6), 10)
  return offsetHour <= 23 && offsetMinute <= 59
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}
