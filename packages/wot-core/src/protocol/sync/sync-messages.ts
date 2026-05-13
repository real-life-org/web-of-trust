import {
  assertPlaintextMessage,
  createPlaintextMessage,
  type DidcommPlaintextMessage,
} from './membership-messages'
import type { SyncHeads } from './heads'

export const SYNC_REQUEST_MESSAGE_TYPE = 'https://web-of-trust.de/protocols/sync-request/1.0' as const
export const SYNC_RESPONSE_MESSAGE_TYPE = 'https://web-of-trust.de/protocols/sync-response/1.0' as const

export type SyncMessageHeads = SyncHeads

export interface SyncRequestBody {
  docId: string
  heads: SyncHeads
  limit?: number
}

export interface SyncResponseBody {
  docId: string
  entries: string[]
  heads: SyncHeads
  truncated: boolean
}

export type SyncRequestMessage = DidcommPlaintextMessage<
  SyncRequestBody,
  typeof SYNC_REQUEST_MESSAGE_TYPE
> & {
  type: typeof SYNC_REQUEST_MESSAGE_TYPE
}

export type SyncResponseMessage = DidcommPlaintextMessage<
  SyncResponseBody,
  typeof SYNC_RESPONSE_MESSAGE_TYPE
> & {
  type: typeof SYNC_RESPONSE_MESSAGE_TYPE
  thid: string
}

export interface CreateSyncRequestMessageOptions {
  id: string
  from: string
  to?: string[]
  createdTime: number
  body: SyncRequestBody
  thid?: string
  pthid?: string
}

export interface CreateSyncResponseMessageOptions {
  id: string
  from: string
  to?: string[]
  createdTime: number
  body: SyncResponseBody
  thid: string
  pthid?: string
}

const BASE64URL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/

export function createSyncRequestMessage(options: CreateSyncRequestMessageOptions): SyncRequestMessage {
  const message = createPlaintextMessage({
    id: options.id,
    type: SYNC_REQUEST_MESSAGE_TYPE,
    from: options.from,
    to: options.to,
    createdTime: options.createdTime,
    body: options.body,
    thid: options.thid,
    pthid: options.pthid,
  })
  assertSyncRequestMessage(message)
  return message
}

export function createSyncResponseMessage(options: CreateSyncResponseMessageOptions): SyncResponseMessage {
  const message = createPlaintextMessage({
    id: options.id,
    type: SYNC_RESPONSE_MESSAGE_TYPE,
    from: options.from,
    to: options.to,
    createdTime: options.createdTime,
    body: options.body,
    thid: options.thid,
    pthid: options.pthid,
  })
  assertSyncResponseMessage(message)
  return message
}

export function parseSyncRequestMessage(value: unknown): SyncRequestMessage {
  assertSyncRequestMessage(value)
  return value
}

export function parseSyncResponseMessage(value: unknown): SyncResponseMessage {
  assertSyncResponseMessage(value)
  return value
}

export function assertSyncRequestMessage(value: unknown): asserts value is SyncRequestMessage {
  assertPlaintextMessage(value)
  if (value.type !== SYNC_REQUEST_MESSAGE_TYPE) throw new Error('Invalid sync-request type')
  assertSyncRequestBody(value.body)
}

export function assertSyncResponseMessage(value: unknown): asserts value is SyncResponseMessage {
  assertPlaintextMessage(value)
  if (value.type !== SYNC_RESPONSE_MESSAGE_TYPE) throw new Error('Invalid sync-response type')
  if (value.thid === undefined || value.thid.length === 0) throw new Error('Invalid sync-response thid')
  assertSyncResponseBody(value.body)
}

export function assertSyncRequestBody(value: unknown): asserts value is SyncRequestBody {
  const body = assertRecord(value, 'sync-request body')
  assertNoExtraKeys(body, ['docId', 'heads', 'limit'], 'sync-request body')
  assertCanonicalUuidV4(body.docId, 'sync-request body docId')
  assertSyncMessageHeads(body.heads, 'sync-request body heads')
  if (body.limit !== undefined) assertNonNegativeSafeInteger(body.limit, 'sync-request body limit')
}

export function assertSyncResponseBody(value: unknown): asserts value is SyncResponseBody {
  const body = assertRecord(value, 'sync-response body')
  assertNoExtraKeys(body, ['docId', 'entries', 'heads', 'truncated'], 'sync-response body')
  assertCanonicalUuidV4(body.docId, 'sync-response body docId')
  assertJwsCompactStringArray(body.entries, 'sync-response body entries')
  assertSyncMessageHeads(body.heads, 'sync-response body heads')
  if (typeof body.truncated !== 'boolean') throw new Error('Invalid sync-response body truncated')
}

function assertSyncMessageHeads(value: unknown, name: string): asserts value is SyncMessageHeads {
  const heads = assertRecord(value, name)
  for (const [deviceId, seq] of Object.entries(heads)) {
    assertCanonicalUuidV4(deviceId, `${name} deviceId`)
    assertNonNegativeSafeInteger(seq, `${name} seq`)
  }
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

function assertCanonicalUuidV4(value: unknown, name: string): void {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new Error(`Invalid ${name}`)
  }
}

function assertNonNegativeSafeInteger(value: unknown, name: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${name}`)
}

function assertJwsCompactStringArray(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${name}`)
  for (const item of value) assertJwsCompactString(item, name)
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
