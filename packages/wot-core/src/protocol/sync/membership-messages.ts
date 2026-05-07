export const DIDCOMM_PLAINTEXT_TYP = 'application/didcomm-plain+json' as const
export const SPACE_INVITE_MESSAGE_TYPE = 'https://web-of-trust.de/protocols/space-invite/1.0' as const
export const MEMBER_UPDATE_MESSAGE_TYPE = 'https://web-of-trust.de/protocols/member-update/1.0' as const
export const KEY_ROTATION_MESSAGE_TYPE = 'https://web-of-trust.de/protocols/key-rotation/1.0' as const

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

export interface SpaceContentKeyMaterial {
  generation: number
  key: string
}

export interface SpaceInviteBody {
  spaceId: string
  brokerUrls: string[]
  currentKeyGeneration: number
  spaceContentKeys: SpaceContentKeyMaterial[]
  spaceCapabilitySigningKey: string
  adminDids: string[]
  capability: string
}

export interface MemberUpdateBody {
  spaceId: string
  action: MemberUpdateAction
  memberDid: string
  effectiveKeyGeneration: number
  reason?: string
}

export interface KeyRotationBody {
  spaceId: string
  generation: number
  spaceContentKey: string
  spaceCapabilitySigningKey: string
  capability: string
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

export type SpaceInviteMessage = DidcommPlaintextMessage<SpaceInviteBody, typeof SPACE_INVITE_MESSAGE_TYPE> & {
  type: typeof SPACE_INVITE_MESSAGE_TYPE
  to: string[]
}

export type MemberUpdateMessage = DidcommPlaintextMessage<MemberUpdateBody, typeof MEMBER_UPDATE_MESSAGE_TYPE> & {
  type: typeof MEMBER_UPDATE_MESSAGE_TYPE
  to: string[]
}

export type KeyRotationMessage = DidcommPlaintextMessage<KeyRotationBody, typeof KEY_ROTATION_MESSAGE_TYPE> & {
  type: typeof KEY_ROTATION_MESSAGE_TYPE
  to: string[]
}

export interface CreateSpaceInviteMessageOptions {
  id: string
  from: string
  to: string[]
  createdTime: number
  body: SpaceInviteBody
  thid?: string
  pthid?: string
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

export interface CreateKeyRotationMessageOptions {
  id: string
  from: string
  to: string[]
  createdTime: number
  body: KeyRotationBody
  thid?: string
  pthid?: string
}

// Sync 003 "Plaintext Message" envelope shape; DIDComm library compatibility stays in wot-spec.
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

// Sync 003 plaintext envelopes are transport metadata, not the authority anchor for inner objects.
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

export function createSpaceInviteMessage(options: CreateSpaceInviteMessageOptions): SpaceInviteMessage {
  const message = createPlaintextMessage({
    id: options.id,
    type: SPACE_INVITE_MESSAGE_TYPE,
    from: options.from,
    to: options.to,
    createdTime: options.createdTime,
    body: options.body,
    thid: options.thid,
    pthid: options.pthid,
  })
  assertSpaceInviteMessage(message)
  return message
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

export function createKeyRotationMessage(options: CreateKeyRotationMessageOptions): KeyRotationMessage {
  const message = createPlaintextMessage({
    id: options.id,
    type: KEY_ROTATION_MESSAGE_TYPE,
    from: options.from,
    to: options.to,
    createdTime: options.createdTime,
    body: options.body,
    thid: options.thid,
    pthid: options.pthid,
  })
  assertKeyRotationMessage(message)
  return message
}

export function parseSpaceInviteMessage(value: unknown): SpaceInviteMessage {
  assertSpaceInviteMessage(value)
  return value
}

export function parseMemberUpdateMessage(value: unknown): MemberUpdateMessage {
  assertMemberUpdateMessage(value)
  return value
}

export function parseKeyRotationMessage(value: unknown): KeyRotationMessage {
  assertKeyRotationMessage(value)
  return value
}

export function assertSpaceInviteMessage(value: unknown): asserts value is SpaceInviteMessage {
  const message = assertPlaintextEnvelope(value, 'space-invite')
  if (message.type !== SPACE_INVITE_MESSAGE_TYPE) throw new Error('Invalid space-invite type')
  assertSpaceInviteBody(message.body)
}

export function assertMemberUpdateMessage(value: unknown): asserts value is MemberUpdateMessage {
  const message = assertPlaintextEnvelope(value, 'member-update')
  if (message.type !== MEMBER_UPDATE_MESSAGE_TYPE) throw new Error('Invalid member-update type')
  assertMemberUpdateBody(message.body)
}

export function assertKeyRotationMessage(value: unknown): asserts value is KeyRotationMessage {
  const message = assertPlaintextEnvelope(value, 'key-rotation')
  if (message.type !== KEY_ROTATION_MESSAGE_TYPE) throw new Error('Invalid key-rotation type')
  assertKeyRotationBody(message.body)
}

export function assertSpaceInviteBody(value: unknown): asserts value is SpaceInviteBody {
  const body = assertRecord(value, 'space-invite body')
  assertNoExtraKeys(
    body,
    [
      'spaceId',
      'brokerUrls',
      'currentKeyGeneration',
      'spaceContentKeys',
      'spaceCapabilitySigningKey',
      'adminDids',
      'capability',
    ],
    'space-invite body',
  )
  assertUuid(body.spaceId, 'space-invite body spaceId')
  assertUriArray(body.brokerUrls, 'space-invite body brokerUrls')
  assertNonNegativeInteger(body.currentKeyGeneration, 'space-invite body currentKeyGeneration')
  assertSpaceContentKeys(body.spaceContentKeys, 'space-invite body spaceContentKeys')
  const highestContentKeyGeneration = Math.max(
    ...body.spaceContentKeys.map((keyMaterial) => keyMaterial.generation),
  )
  if (body.currentKeyGeneration !== highestContentKeyGeneration) {
    throw new Error('Invalid space-invite body currentKeyGeneration')
  }
  assertBase64UrlLike(body.spaceCapabilitySigningKey, 'space-invite body spaceCapabilitySigningKey')
  assertDidArray(body.adminDids, 'space-invite body adminDids', { allowEmpty: true })
  assertCompactJwsLike(body.capability, 'space-invite body capability')
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

export function assertKeyRotationBody(value: unknown): asserts value is KeyRotationBody {
  const body = assertRecord(value, 'key-rotation body')
  assertNoExtraKeys(
    body,
    ['spaceId', 'generation', 'spaceContentKey', 'spaceCapabilitySigningKey', 'capability'],
    'key-rotation body',
  )
  assertUuid(body.spaceId, 'key-rotation body spaceId')
  assertNonNegativeInteger(body.generation, 'key-rotation body generation')
  assertBase64UrlLike(body.spaceContentKey, 'key-rotation body spaceContentKey')
  assertBase64UrlLike(body.spaceCapabilitySigningKey, 'key-rotation body spaceCapabilitySigningKey')
  assertCompactJwsLike(body.capability, 'key-rotation body capability')
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertPlaintextEnvelope(value: unknown, messageName: string): Record<string, unknown> {
  const message = assertRecord(value, `${messageName} message`)
  assertUuid(message.id, `${messageName} id`)
  if (message.typ !== DIDCOMM_PLAINTEXT_TYP) throw new Error(`Invalid ${messageName} typ`)
  assertDid(message.from, `${messageName} from`)
  assertDidArray(message.to, `${messageName} to`)
  assertNonNegativeInteger(message.created_time, `${messageName} created_time`)
  if (message.thid !== undefined) assertUuid(message.thid, `${messageName} thid`)
  if (message.pthid !== undefined) assertUuid(message.pthid, `${messageName} pthid`)
  assertRecord(message.body, `${messageName} body`)
  return message
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

function assertDidArray(value: unknown, name: string, options: { allowEmpty?: boolean } = {}): void {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) throw new Error(`Invalid ${name}`)
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

function assertUriArray(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Invalid ${name}`)
  for (const item of value) assertUri(item, name)
}

function assertSpaceContentKeys(value: unknown, name: string): asserts value is SpaceContentKeyMaterial[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Invalid ${name}`)
  for (const item of value) {
    const keyMaterial = assertRecord(item, name)
    assertNoExtraKeys(keyMaterial, ['generation', 'key'], name)
    assertNonNegativeInteger(keyMaterial.generation, `${name} generation`)
    assertBase64UrlLike(keyMaterial.key, `${name} key`)
  }
}

function assertBase64UrlLike(value: unknown, name: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${name}`)
}

function assertCompactJwsLike(value: unknown, name: string): void {
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
  const parts = value.split('.')
  if (parts.length !== 3) throw new Error(`Invalid ${name}`)
  for (const part of parts) assertBase64UrlLike(part, name)
}
