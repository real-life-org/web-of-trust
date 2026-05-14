import {
  assertPlaintextMessage,
  createPlaintextMessage,
  type DidcommPlaintextMessage,
} from './membership-messages'

export const ACK_MESSAGE_TYPE = 'https://web-of-trust.de/protocols/ack/1.0' as const

export interface AckMessageBody {
  messageId: string
}

export type AckMessage = DidcommPlaintextMessage<AckMessageBody, typeof ACK_MESSAGE_TYPE> & {
  type: typeof ACK_MESSAGE_TYPE
  thid: string
}

export interface CreateAckMessageOptions {
  id: string
  from: string
  to?: string[]
  createdTime: number
  thid: string
  pthid?: string
  body: AckMessageBody
}

export function createAckMessage(options: CreateAckMessageOptions): AckMessage {
  const message = createPlaintextMessage({
    id: options.id,
    type: ACK_MESSAGE_TYPE,
    from: options.from,
    to: options.to,
    createdTime: options.createdTime,
    thid: options.thid,
    pthid: options.pthid,
    body: options.body,
  })
  assertAckMessage(message)
  return message
}

export function parseAckMessage(value: unknown): AckMessage {
  assertAckMessage(value)
  return value
}

export function assertAckMessage(value: unknown): asserts value is AckMessage {
  assertPlaintextMessage(value)
  // spec-anchor: protocol/ack-type-exact
  if (value.type !== ACK_MESSAGE_TYPE) throw new Error('Invalid ack message type')
  if (value.thid === undefined) throw new Error('Invalid ack thid')
  // Original-message existence, authenticated device scoping, and referenced
  // message type are runtime checks outside this shape helper.
  assertAckMessageBody(value.body)
  // spec-anchor: protocol/ack-thid-message-id-binding
  if (value.thid !== value.body.messageId) throw new Error('Invalid ack thid')
}

export function assertAckMessageBody(value: unknown): asserts value is AckMessageBody {
  const body = assertRecord(value, 'ack body')
  // spec-anchor: protocol/ack-message-id-uuid-v4
  // spec-anchor: protocol/ack-body-extra-fields-forward-compatible
  // Unknown extra body fields are accepted for forward-compatibility per Sync 003.
  assertCanonicalUuidV4(body.messageId, 'ack body messageId')
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertCanonicalUuidV4(value: unknown, name: string): void {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new Error(`Invalid ${name}`)
  }
}
