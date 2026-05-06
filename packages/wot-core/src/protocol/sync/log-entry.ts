import type { ProtocolCryptoAdapter } from '../crypto/ports'
import type { JsonValue } from '../crypto/jcs'
import { createJcsEd25519Jws, decodeJws, verifyJwsWithPublicKey } from '../crypto/jws'
import { didKeyToPublicKeyBytes } from '../identity/did-key'
import {
  assertPlaintextMessage,
  createPlaintextMessage,
  type DidcommPlaintextMessage,
} from './membership-messages'

export interface LogEntryPayload {
  seq: number
  deviceId: string
  docId: string
  authorKid: string
  keyGeneration: number
  data: string
  timestamp: string
}

export interface CreateLogEntryJwsOptions {
  payload: LogEntryPayload
  signingSeed: Uint8Array
}

export interface VerifyLogEntryJwsOptions {
  crypto: ProtocolCryptoAdapter
}

// Sync 002 defines the LogEntryPayload JWS; Sync 003 defines the plaintext log-entry wrapper.
export const LOG_ENTRY_MESSAGE_TYPE = 'https://web-of-trust.de/protocols/log-entry/1.0' as const
const BASE64URL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/

export interface LogEntryMessageBody {
  entry: string
}

export type LogEntryMessage = DidcommPlaintextMessage<LogEntryMessageBody, typeof LOG_ENTRY_MESSAGE_TYPE> & {
  type: typeof LOG_ENTRY_MESSAGE_TYPE
  to: string[]
}

export interface CreateLogEntryMessageOptions {
  id: string
  from: string
  to: string[]
  createdTime: number
  entry: string
  thid?: string
  pthid?: string
}

export async function createLogEntryJws(options: CreateLogEntryJwsOptions): Promise<string> {
  assertLogEntryPayload(options.payload)
  return createJcsEd25519Jws(
    { alg: 'EdDSA', kid: options.payload.authorKid },
    options.payload as unknown as JsonValue,
    options.signingSeed,
  )
}

export async function verifyLogEntryJws(jws: string, options: VerifyLogEntryJwsOptions): Promise<LogEntryPayload> {
  const { header, payload } = decodeJws<{ alg?: string; kid?: string }, LogEntryPayload>(jws)
  if (header.alg !== 'EdDSA') throw new Error('Invalid log entry alg')
  if (!header.kid) throw new Error('Missing log entry kid')
  if (payload.authorKid !== header.kid) throw new Error('Log entry authorKid mismatch')

  await verifyJwsWithPublicKey(jws, {
    publicKey: didKeyToPublicKeyBytes(payload.authorKid),
    crypto: options.crypto,
  })
  assertLogEntryPayload(payload)
  return payload
}

export function createLogEntryMessage(options: CreateLogEntryMessageOptions): LogEntryMessage {
  const message = createPlaintextMessage({
    id: options.id,
    type: LOG_ENTRY_MESSAGE_TYPE,
    from: options.from,
    to: options.to,
    createdTime: options.createdTime,
    thid: options.thid,
    pthid: options.pthid,
    body: { entry: options.entry },
  })
  assertLogEntryMessage(message)
  return message
}

export function parseLogEntryMessage(value: unknown): LogEntryMessage {
  assertLogEntryMessage(value)
  return value
}

export function assertLogEntryMessage(value: unknown): asserts value is LogEntryMessage {
  assertPlaintextMessage(value)
  if (value.type !== LOG_ENTRY_MESSAGE_TYPE) throw new Error('Invalid log-entry message type')
  assertDidArray(value.to, 'log-entry message to')
  assertLogEntryMessageBody(value.body)
}

export function assertLogEntryMessageBody(value: unknown): asserts value is LogEntryMessageBody {
  const body = assertRecord(value, 'log-entry body')
  assertNoExtraKeys(body, ['entry'], 'log-entry body')
  assertJwsCompactString(body.entry, 'log-entry body entry')
}

export function assertLogEntryPayload(payload: unknown): asserts payload is LogEntryPayload {
  const record = assertRecord(payload, 'log entry payload')
  assertNoExtraKeys(record, ['seq', 'deviceId', 'docId', 'authorKid', 'keyGeneration', 'data', 'timestamp'], 'log entry payload')
  assertNonNegativeInteger(record.seq, 'log entry seq')
  assertUuid(record.deviceId, 'log entry deviceId')
  assertUuid(record.docId, 'log entry docId')
  assertDidUrl(record.authorKid, 'log entry authorKid')
  if (!Number.isInteger(record.keyGeneration) || (record.keyGeneration as number) < 0) {
    throw new Error('Invalid log entry keyGeneration')
  }
  assertBase64Url(record.data, 'log entry data')
  assertDateTime(record.timestamp, 'log entry timestamp')
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertNoExtraKeys(value: Record<string, unknown>, allowed: string[], name: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`Invalid ${name} property: ${key}`)
  }
}

function assertUuid(value: unknown, name: string): void {
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
  // [NEEDS CLARIFICATION: wot-spec#23] Sync 002 prose says v4, schema currently encodes generic uuid.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid ${name}`)
  }
}

function assertDidUrl(value: unknown, name: string): void {
  if (typeof value !== 'string' || !/^did:[a-z0-9]+:.+#.+/.test(value)) throw new Error(`Invalid ${name}`)
}

function assertDid(value: unknown, name: string): void {
  if (typeof value !== 'string' || !/^did:[a-z0-9]+:.+/.test(value)) throw new Error(`Invalid ${name}`)
}

function assertDidArray(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Invalid ${name}`)
  for (const item of value) assertDid(item, name)
}

function assertNonNegativeInteger(value: unknown, name: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid ${name}`)
}

function assertBase64Url(value: unknown, name: string): void {
  if (typeof value !== 'string' || !isValidBase64UrlSegment(value)) throw new Error(`Invalid ${name}`)
}

function assertDateTime(value: unknown, name: string): void {
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match || Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${name}`)

  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match
  if (
    !isValidDateTimeParts(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10),
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10),
      offsetHour === undefined ? undefined : Number.parseInt(offsetHour, 10),
      offsetMinute === undefined ? undefined : Number.parseInt(offsetMinute, 10),
    )
  ) {
    throw new Error(`Invalid ${name}`)
  }
}

function isValidDateTimeParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offsetHour: number | undefined,
  offsetMinute: number | undefined,
): boolean {
  if (month < 1 || month > 12) return false
  if (day < 1 || day > daysInMonth(year, month)) return false
  if (hour < 0 || hour > 23) return false
  if (minute < 0 || minute > 59) return false
  if (second < 0 || second > 59) return false
  if (offsetHour !== undefined && (offsetHour < 0 || offsetHour > 23)) return false
  if (offsetMinute !== undefined && (offsetMinute < 0 || offsetMinute > 59)) return false
  return true
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function assertJwsCompactString(value: unknown, name: string): void {
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
  const parts = value.split('.')
  if (parts.length !== 3 || parts.some((part) => !isValidBase64UrlSegment(part))) {
    throw new Error(`Invalid ${name}`)
  }
}

function isValidBase64UrlSegment(value: string): boolean {
  return BASE64URL_SEGMENT_PATTERN.test(value) && value.length % 4 !== 1
}
