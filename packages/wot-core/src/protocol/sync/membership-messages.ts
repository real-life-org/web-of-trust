export const DIDCOMM_PLAINTEXT_TYP = 'application/didcomm-plain+json' as const
export const MEMBER_UPDATE_MESSAGE_TYPE = 'https://web-of-trust.de/protocols/member-update/1.0' as const

export type MemberUpdateAction = 'added' | 'removed'

export interface DidcommPlaintextMessage<Body = Record<string, unknown>, Type extends string = string> {
  id: string
  typ: typeof DIDCOMM_PLAINTEXT_TYP
  type: Type
  from: string
  to?: string[]
  created_time: number
  thid?: string
  pthid?: string
  body: Body
  [key: string]: unknown
}

export interface CreatePlaintextMessageOptions<Body extends object, Type extends string> {
  id: string
  type: Type
  from: string
  to?: string[]
  createdTime: number
  body: Body
  thid?: string
  pthid?: string
}

export interface MemberUpdateBody {
  spaceId: string
  action: MemberUpdateAction
  memberDid: string
  effectiveKeyGeneration: number
  reason?: string
}

export type MemberUpdateMessage = DidcommPlaintextMessage<MemberUpdateBody, typeof MEMBER_UPDATE_MESSAGE_TYPE> & {
  type: typeof MEMBER_UPDATE_MESSAGE_TYPE
  to: string[]
}

export interface CreateMemberUpdateMessageOptions {
  id: string
  from: string
  to: string[]
  createdTime: number
  body: MemberUpdateBody
  thid?: string
  pthid?: string
}

export function createPlaintextMessage<Body extends object, Type extends string>(
  options: CreatePlaintextMessageOptions<Body, Type>,
): DidcommPlaintextMessage<Body, Type> {
  const message: DidcommPlaintextMessage<Body, Type> = {
    id: options.id,
    typ: DIDCOMM_PLAINTEXT_TYP,
    type: options.type,
    from: options.from,
    created_time: options.createdTime,
    body: options.body,
  }
  if (options.to !== undefined) message.to = options.to
  if (options.thid !== undefined) message.thid = options.thid
  if (options.pthid !== undefined) message.pthid = options.pthid
  assertPlaintextMessage(message)
  return message
}

export function parsePlaintextMessage(value: unknown): DidcommPlaintextMessage {
  assertPlaintextMessage(value)
  return value
}

export function assertPlaintextMessage(value: unknown): asserts value is DidcommPlaintextMessage {
  const message = assertRecord(value, 'plaintext message')
  assertUuid(message.id, 'plaintext message id')
  if (message.typ !== DIDCOMM_PLAINTEXT_TYP) throw new Error('Invalid plaintext message typ')
  assertUri(message.type, 'plaintext message type')
  assertDid(message.from, 'plaintext message from')
  if (message.to !== undefined) assertDidArray(message.to, 'plaintext message to')
  assertNonNegativeInteger(message.created_time, 'plaintext message created_time')
  if (message.thid !== undefined) assertNonEmptyString(message.thid, 'plaintext message thid')
  if (message.pthid !== undefined) assertNonEmptyString(message.pthid, 'plaintext message pthid')
  assertRecord(message.body, 'plaintext message body')
}

export function createMemberUpdateMessage(options: CreateMemberUpdateMessageOptions): MemberUpdateMessage {
  const message = createPlaintextMessage({
    id: options.id,
    type: MEMBER_UPDATE_MESSAGE_TYPE,
    from: options.from,
    to: options.to,
    createdTime: options.createdTime,
    body: options.body,
    thid: options.thid,
    pthid: options.pthid,
  })
  assertMemberUpdateMessage(message)
  return message
}

export function parseMemberUpdateMessage(value: unknown): MemberUpdateMessage {
  assertMemberUpdateMessage(value)
  return value
}

export function assertMemberUpdateMessage(value: unknown): asserts value is MemberUpdateMessage {
  assertPlaintextMessage(value)
  if (value.type !== MEMBER_UPDATE_MESSAGE_TYPE) throw new Error('Invalid member-update type')
  assertDidArray(value.to, 'member-update to')
  if (value.thid !== undefined) assertUuid(value.thid, 'member-update thid')
  if (value.pthid !== undefined) assertUuid(value.pthid, 'member-update pthid')
  assertMemberUpdateBody(value.body)
}

export function assertMemberUpdateBody(value: unknown): asserts value is MemberUpdateBody {
  const body = assertRecord(value, 'member-update body')
  assertNoExtraKeys(body, ['spaceId', 'action', 'memberDid', 'effectiveKeyGeneration', 'reason'], 'member-update body')
  assertUuid(body.spaceId, 'member-update body spaceId')
  if (body.action !== 'added' && body.action !== 'removed') throw new Error('Invalid member-update body action')
  assertDid(body.memberDid, 'member-update body memberDid')
  assertNonNegativeInteger(body.effectiveKeyGeneration, 'member-update body effectiveKeyGeneration')
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    throw new Error('Invalid member-update body reason')
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

function assertNonEmptyString(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${name}`)
}

function assertUri(value: unknown, name: string): void {
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
  try {
    new URL(value)
  } catch {
    throw new Error(`Invalid ${name}`)
  }
}
