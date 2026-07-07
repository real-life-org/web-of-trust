import { describe, expect, it } from 'vitest'
import {
  ACK_MESSAGE_TYPE,
  assertAckMessage,
  createAckMessage,
  parseAckMessage,
} from '../src/protocol'

const ACK_ID = '550e8400-e29b-41d4-a716-446655440010'
const ORIGINAL_MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440000'
const FROM_DID = 'did:key:z6Mko3ZEjKJWQAM5nDXKoZ9jErvvxbWbYgS8KJXYpC5Hbu8a'
const TO_DID = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
const CREATED_TIME = 1776514800

function validAck(overrides: Record<string, unknown> = {}) {
  return {
    id: ACK_ID,
    typ: 'application/didcomm-plain+json',
    type: ACK_MESSAGE_TYPE,
    from: FROM_DID,
    created_time: CREATED_TIME,
    thid: ORIGINAL_MESSAGE_ID,
    body: {
      messageId: ORIGINAL_MESSAGE_ID,
    },
    ...overrides,
  }
}

describe('Sync 003 ack/1.0 plaintext messages', () => {
  it('constructs and parses a deterministic plaintext ACK for an original inbox message id', () => {
    const message = createAckMessage({
      id: ACK_ID,
      from: FROM_DID,
      createdTime: CREATED_TIME,
      thid: ORIGINAL_MESSAGE_ID,
      body: {
        messageId: ORIGINAL_MESSAGE_ID,
      },
    })

    expect(message).toEqual(validAck())
    expect(parseAckMessage(message)).toEqual(message)
    expect(() => assertAckMessage(message)).not.toThrow()
  })

  it('allows optional to while keeping broker channel/routing semantics out of protocol-core', () => {
    expect(createAckMessage({
      id: ACK_ID,
      from: FROM_DID,
      createdTime: CREATED_TIME,
      thid: ORIGINAL_MESSAGE_ID,
      body: {
        messageId: ORIGINAL_MESSAGE_ID,
      },
    })).not.toHaveProperty('to')

    expect(createAckMessage({
      id: ACK_ID,
      from: FROM_DID,
      to: [TO_DID],
      createdTime: CREATED_TIME,
      thid: ORIGINAL_MESSAGE_ID,
      body: {
        messageId: ORIGINAL_MESSAGE_ID,
      },
    })).toMatchObject({
      to: [TO_DID],
    })
  })

  it('requires thid because ACK directly answers the original message', () => {
    expect(() => parseAckMessage(validAck({ thid: undefined }))).toThrow('Invalid ack thid')
    expect(() => parseAckMessage(validAck({ thid: '' }))).toThrow('Invalid plaintext message thid')
  })

  it('requires ACK thid to be the canonical lowercase UUID v4 of body.messageId', () => {
    const invalidThreadIds = [
      'original-message-thread-not-a-uuid',
      ORIGINAL_MESSAGE_ID.toUpperCase(),
      '550e8400-e29b-11d4-a716-446655440000',
      '550e8400-e29b-41d4-7716-446655440000',
    ]

    for (const thid of invalidThreadIds) {
      expect(() => parseAckMessage(validAck({ thid })), thid).toThrow()
      expect(() => createAckMessage({
        id: ACK_ID,
        from: FROM_DID,
        createdTime: CREATED_TIME,
        thid,
        body: {
          messageId: ORIGINAL_MESSAGE_ID,
        },
      }), thid).toThrow()
    }

    expect(() => parseAckMessage(validAck({
      thid: '550e8400-e29b-41d4-a716-446655440001',
    }))).toThrow()
    expect(() => createAckMessage({
      id: ACK_ID,
      from: FROM_DID,
      createdTime: CREATED_TIME,
      thid: '550e8400-e29b-41d4-a716-446655440001',
      body: {
        messageId: ORIGINAL_MESSAGE_ID,
      },
    })).toThrow()
  })

  it('requires body.messageId to be canonical lowercase UUID v4', () => {
    const invalidMessageIds = [
      undefined,
      '',
      'not-a-uuid',
      ORIGINAL_MESSAGE_ID.toUpperCase(),
      '550e8400-e29b-11d4-a716-446655440000',
      '550e8400-e29b-41d4-7716-446655440000',
    ]

    expect(() => parseAckMessage(validAck({ body: {} }))).toThrow('Invalid ack body messageId')

    for (const messageId of invalidMessageIds) {
      expect(() => parseAckMessage(validAck({ body: { messageId } })), String(messageId)).toThrow(
        'Invalid ack body messageId',
      )
    }
  })

  it('ignores unknown extra ACK body fields for forward-compatibility per Sync 003', () => {
    const messageWithExtras = validAck({
      body: {
        messageId: ORIGINAL_MESSAGE_ID,
        status: 'received',
        future: { nested: true },
      },
    })

    expect(() => parseAckMessage(messageWithExtras)).not.toThrow()
    expect(() => assertAckMessage(messageWithExtras)).not.toThrow()
    expect(parseAckMessage(messageWithExtras)).toEqual(messageWithExtras)
  })

  it('still requires body.messageId and still binds it to thid even when extra body fields are present', () => {
    expect(() => parseAckMessage(validAck({ body: { status: 'received' } }))).toThrow(
      'Invalid ack body messageId',
    )

    expect(() => parseAckMessage(validAck({
      body: {
        messageId: '550e8400-e29b-41d4-a716-446655440099',
        status: 'received',
      },
    }))).toThrow('Invalid ack thid')
  })

  it('rejects malformed common plaintext envelope fields', () => {
    const invalidMessages = [
      ['uppercase id', validAck({ id: ACK_ID.toUpperCase() }), /Invalid plaintext message id/],
      ['non-v4 id', validAck({ id: '550e8400-e29b-11d4-a716-446655440010' }), /Invalid plaintext message id/],
      ['invalid typ', validAck({ typ: 'application/json' }), /Invalid plaintext message typ/],
      ['invalid from', validAck({ from: 'alice' }), /Invalid plaintext message from/],
      ['empty to', validAck({ to: [] }), /Invalid plaintext message to/],
      ['invalid to DID', validAck({ to: ['not-a-did'] }), /Invalid plaintext message to/],
      ['negative created_time', validAck({ created_time: -1 }), /Invalid plaintext message created_time/],
      ['fractional created_time', validAck({ created_time: 1776514800.5 }), /Invalid plaintext message created_time/],
      ['empty pthid', validAck({ pthid: '' }), /Invalid plaintext message pthid/],
      ['invalid body', validAck({ body: null }), /Invalid plaintext message body/],
    ] as const

    for (const [name, message, expectedError] of invalidMessages) {
      expect(() => parseAckMessage(message), name).toThrow(expectedError)
    }
  })

  it('rejects plaintext type mismatches so ack/1.0 is not confused with other sync messages', () => {
    expect(() => parseAckMessage(validAck({
      type: 'https://web-of-trust.de/protocols/log-entry/1.0',
    }))).toThrow('Invalid ack message type')
    expect(() => parseAckMessage(validAck({
      type: 'https://web-of-trust.de/protocols/log-entry/1.0',
      thid: undefined,
    }))).toThrow('Invalid ack message type')
  })
})
