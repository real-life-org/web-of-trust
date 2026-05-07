import {
  DIDCOMM_PLAINTEXT_TYP,
  createPlaintextMessage,
  type DidcommPlaintextMessage,
} from '../sync/membership-messages'

export const TRUST_LIST_DELTA_MESSAGE_TYPE = 'https://web-of-trust.de/protocols/trust-list-delta/1.0' as const

export interface TrustListDeltaBody {
  delta: string
}

export type TrustListDeltaMessage = DidcommPlaintextMessage<
  TrustListDeltaBody,
  typeof TRUST_LIST_DELTA_MESSAGE_TYPE
> & {
  type: typeof TRUST_LIST_DELTA_MESSAGE_TYPE
  to: string[]
}

export interface CreateTrustListDeltaMessageOptions {
  id: string
  from: string
  to: string[]
  createdTime: number
  delta: string
  thid?: string
  pthid?: string
}

const SD_JWT_VC_COMPACT_WITH_DISCLOSURES_PATTERN =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(~[A-Za-z0-9_-]*)+~?$/

export function createTrustListDeltaMessage(options: CreateTrustListDeltaMessageOptions): TrustListDeltaMessage {
  const message = createPlaintextMessage({
    id: options.id,
    type: TRUST_LIST_DELTA_MESSAGE_TYPE,
    from: options.from,
    to: options.to,
    createdTime: options.createdTime,
    thid: options.thid,
    pthid: options.pthid,
    body: { delta: options.delta },
  })
  assertTrustListDeltaMessage(message)
  return message
}

export function parseTrustListDeltaMessage(value: unknown): TrustListDeltaMessage {
  assertTrustListDeltaMessage(value)
  return value
}

export function assertTrustListDeltaMessage(value: unknown): asserts value is TrustListDeltaMessage {
  const message = assertRecord(value, 'trust-list-delta message')
  assertUuid(message.id, 'trust-list-delta id')
  if (message.typ !== DIDCOMM_PLAINTEXT_TYP) throw new Error('Invalid trust-list-delta typ')
  if (message.type !== TRUST_LIST_DELTA_MESSAGE_TYPE) throw new Error('Invalid trust-list-delta type')
  assertDid(message.from, 'trust-list-delta from')
  assertDidArray(message.to, 'trust-list-delta to')
  assertNonNegativeInteger(message.created_time, 'trust-list-delta created_time')
  if (message.thid !== undefined) assertUuid(message.thid, 'trust-list-delta thid')
  if (message.pthid !== undefined) assertUuid(message.pthid, 'trust-list-delta pthid')
  assertTrustListDeltaBody(message.body)
}

export function assertTrustListDeltaBody(value: unknown): asserts value is TrustListDeltaBody {
  const body = assertRecord(value, 'trust-list-delta body')
  assertNoExtraKeys(body, ['delta'], 'trust-list-delta body')
  assertSdJwtVcCompactWithDisclosures(body.delta, 'trust-list-delta body delta')
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid ${name}`)
  }
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

function assertSdJwtVcCompactWithDisclosures(value: unknown, name: string): void {
  if (typeof value !== 'string' || !SD_JWT_VC_COMPACT_WITH_DISCLOSURES_PATTERN.test(value)) {
    throw new Error(`Invalid ${name}`)
  }
}
