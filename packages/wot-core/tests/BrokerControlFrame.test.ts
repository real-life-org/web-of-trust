import { describe, expect, it } from 'vitest'
import {
  ERROR_CONTROL_FRAME_TYPE,
  assertBrokerErrorControlFrame,
  createBrokerErrorControlFrame,
  parseBrokerErrorControlFrame,
} from '../src/protocol'

const THREAD_ID = '550e8400-e29b-41d4-a716-446655440000'

function validErrorFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: ERROR_CONTROL_FRAME_TYPE,
    thid: THREAD_ID,
    body: {
      code: 'DOC_NOT_FOUND',
      message: 'Unbekannte docId',
    },
    ...overrides,
  }
}

describe('Sync 003 broker error/1.0 control frames', () => {
  it('constructs and parses a deterministic broker error control-frame with string thid', () => {
    const frame = createBrokerErrorControlFrame({
      thid: THREAD_ID,
      body: {
        code: 'DOC_NOT_FOUND',
        message: 'Unbekannte docId',
      },
    })

    expect(frame).toEqual(validErrorFrame())
    expect(parseBrokerErrorControlFrame(frame)).toEqual(frame)
    expect(() => assertBrokerErrorControlFrame(frame)).not.toThrow()
  })

  it('constructs and parses a broker error control-frame with null thid when no request is attributable', () => {
    const frame = createBrokerErrorControlFrame({
      thid: null,
      body: {
        code: 'MALFORMED_MESSAGE',
        message: 'JSON parse error',
      },
    })

    expect(frame).toEqual({
      type: ERROR_CONTROL_FRAME_TYPE,
      thid: null,
      body: {
        code: 'MALFORMED_MESSAGE',
        message: 'JSON parse error',
      },
    })
    expect(parseBrokerErrorControlFrame(frame)).toEqual(frame)
  })

  it('tolerates unknown extra body fields as forward-compatible non-authoritative metadata', () => {
    const frame = validErrorFrame({
      body: {
        code: 'RATE_LIMITED',
        message: 'Rate-Limit ueberschritten',
        retryAfterSeconds: 30,
        brokerTraceId: 'trace-123',
        details: {
          bucket: 'device-register',
        },
      },
    })

    expect(parseBrokerErrorControlFrame(frame)).toEqual(frame)
  })

  it('requires a known Sync 003 broker error code inside body', () => {
    expect(() => parseBrokerErrorControlFrame(validErrorFrame({
      body: {
        code: 'BROKER_BUSY',
        message: 'Try later',
      },
    }))).toThrow()

    expect(() => createBrokerErrorControlFrame({
      thid: THREAD_ID,
      body: {
        code: 'BROKER_BUSY',
        message: 'Try later',
      },
    })).toThrow()
  })

  it('rejects malformed or missing required error control-frame fields', () => {
    const invalidFrames = [
      ['non-object frame', null],
      ['missing type', { thid: THREAD_ID, body: validErrorFrame().body }],
      ['missing thid', { type: ERROR_CONTROL_FRAME_TYPE, body: validErrorFrame().body }],
      ['empty thid', validErrorFrame({ thid: '' })],
      ['numeric thid', validErrorFrame({ thid: 123 })],
      ['missing body', { type: ERROR_CONTROL_FRAME_TYPE, thid: THREAD_ID }],
      ['null body', validErrorFrame({ body: null })],
      ['missing body code', validErrorFrame({ body: { message: 'Unbekannte docId' } })],
      ['missing body message', validErrorFrame({ body: { code: 'DOC_NOT_FOUND' } })],
      ['empty body message', validErrorFrame({ body: { code: 'DOC_NOT_FOUND', message: '   ' } })],
    ] as const

    for (const [name, frame] of invalidFrames) {
      expect(() => parseBrokerErrorControlFrame(frame), name).toThrow()
    }
  })

  it('rejects inherited required fields on broker error control-frames', () => {
    const inheritedType = Object.create({
      type: ERROR_CONTROL_FRAME_TYPE,
    })
    inheritedType.thid = THREAD_ID
    inheritedType.body = validErrorFrame().body

    const inheritedBody = Object.create({
      body: validErrorFrame().body,
    })
    inheritedBody.type = ERROR_CONTROL_FRAME_TYPE
    inheritedBody.thid = THREAD_ID

    const inheritedThreadId = Object.create({
      thid: THREAD_ID,
    })
    inheritedThreadId.type = ERROR_CONTROL_FRAME_TYPE
    inheritedThreadId.body = validErrorFrame().body

    expect(() => parseBrokerErrorControlFrame(inheritedType)).toThrow(
      'Invalid broker error control-frame type',
    )
    expect(() => parseBrokerErrorControlFrame(inheritedBody)).toThrow(
      'Invalid broker error control-frame body',
    )
    expect(() => parseBrokerErrorControlFrame(inheritedThreadId)).toThrow(
      'Invalid broker error control-frame thid',
    )
  })

  it('rejects unknown top-level fields for the normative error/1.0 frame shape', () => {
    expect(() => parseBrokerErrorControlFrame(validErrorFrame({
      retryAfterSeconds: 30,
    }))).toThrow('Invalid broker error control-frame property: retryAfterSeconds')
  })

  it('rejects unknown control-frame types instead of treating them as extension semantics', () => {
    for (const type of [
      'registered',
      'challenge',
      'error/2.0',
      'https://web-of-trust.de/protocols/error/1.0',
    ]) {
      expect(() => parseBrokerErrorControlFrame(validErrorFrame({ type })), type).toThrow()
    }
  })

  it('rejects WoT Transport Envelope fields because error/1.0 is a Broker Control-Frame', () => {
    for (const forbiddenField of ['id', 'typ', 'from', 'to', 'created_time']) {
      expect(() =>
        parseBrokerErrorControlFrame(validErrorFrame({
          [forbiddenField]: forbiddenField === 'to' ? ['did:key:z6Mkbob'] : 'forbidden',
        })),
      forbiddenField).toThrow(`Invalid broker error control-frame property: ${forbiddenField}`)
    }
  })
})
