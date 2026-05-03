export const DIDCOMM_PLAINTEXT_TYP = 'application/didcomm-plain+json' as const
export const MEMBER_UPDATE_MESSAGE_TYPE = 'https://web-of-trust.de/protocols/member-update/1.0' as const

export type MemberUpdateAction = 'added' | 'removed'

export interface DidcommPlaintextMessage<Body> {
  id: string
  typ: typeof DIDCOMM_PLAINTEXT_TYP
  type: string
  from: string
  to: string[]
  created_time: number
  thid?: string
  pthid?: string
  body: Body
  [key: string]: unknown
}

export interface MemberUpdateBody {
  spaceId: string
  action: MemberUpdateAction
  memberDid: string
  effectiveKeyGeneration: number
  reason?: string
}

export type MemberUpdateMessage = DidcommPlaintextMessage<MemberUpdateBody> & {
  type: typeof MEMBER_UPDATE_MESSAGE_TYPE
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

export function createMemberUpdateMessage(options: CreateMemberUpdateMessageOptions): MemberUpdateMessage {
  const message: MemberUpdateMessage = {
    id: options.id,
    typ: DIDCOMM_PLAINTEXT_TYP,
    type: MEMBER_UPDATE_MESSAGE_TYPE,
    from: options.from,
    to: options.to,
    created_time: options.createdTime,
    body: options.body,
  }
  if (options.thid !== undefined) message.thid = options.thid
  if (options.pthid !== undefined) message.pthid = options.pthid
  assertMemberUpdateMessage(message)
  return message
}

export function parseMemberUpdateMessage(value: unknown): MemberUpdateMessage {
  assertMemberUpdateMessage(value)
  return value
}

export function assertMemberUpdateMessage(value: unknown): asserts value is MemberUpdateMessage {
  const message = assertRecord(value, 'member-update message')
  assertUuid(message.id, 'member-update id')
  if (message.typ !== DIDCOMM_PLAINTEXT_TYP) throw new Error('Invalid member-update typ')
  if (message.type !== MEMBER_UPDATE_MESSAGE_TYPE) throw new Error('Invalid member-update type')
  assertDid(message.from, 'member-update from')
  assertDidArray(message.to, 'member-update to')
  assertNonNegativeInteger(message.created_time, 'member-update created_time')
  if (message.thid !== undefined) assertUuid(message.thid, 'member-update thid')
  if (message.pthid !== undefined) assertUuid(message.pthid, 'member-update pthid')
  assertMemberUpdateBody(message.body)
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
