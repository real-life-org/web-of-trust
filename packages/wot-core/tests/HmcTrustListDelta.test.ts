import { beforeEach, describe, expect, it } from 'vitest'
import {
  TRUST_LIST_DELTA_MESSAGE_TYPE,
  assertTrustListDeltaMessage,
  createTrustListDeltaMessage,
  parseTrustListDeltaMessage,
} from '../src/protocol'
import type { TrustListDeltaMessage } from '../src/protocol'

const VALID_ID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_THID = '123e4567-e89b-42d3-a456-426614174000'
const VALID_PTHID = '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b'
const ALICE_DID = 'did:key:z6Mkalice'
const BOB_DID = 'did:key:z6Mkbob'
const CAROL_DID = 'did:key:z6Mkcarol'
const VALID_DELTA = 'eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJkaWQ6a2V5Ono2TWthbGljZSJ9.c2ln~ZGlzY2xvc3VyZQ~'

function expectTrustListDeltaProtocolExports(): void {
  expect(TRUST_LIST_DELTA_MESSAGE_TYPE).toBe('https://web-of-trust.de/protocols/trust-list-delta/1.0')
  expect(typeof createTrustListDeltaMessage).toBe('function')
  expect(typeof parseTrustListDeltaMessage).toBe('function')
  expect(typeof assertTrustListDeltaMessage).toBe('function')
}

function validMessage(overrides: Partial<TrustListDeltaMessage> = {}): TrustListDeltaMessage {
  return {
    id: VALID_ID,
    typ: 'application/didcomm-plain+json',
    type: TRUST_LIST_DELTA_MESSAGE_TYPE,
    from: ALICE_DID,
    to: [BOB_DID],
    created_time: 1776514800,
    body: {
      delta: VALID_DELTA,
    },
    ...overrides,
  }
}

function withoutEnvelopeField(key: keyof TrustListDeltaMessage): unknown {
  const message = { ...validMessage() } as Record<string, unknown>
  delete message[key]
  return message
}

describe('HMC H03 trust-list-delta plaintext envelope', () => {
  beforeEach(() => {
    expectTrustListDeltaProtocolExports()
  })

  it('creates and parses the normative trust-list-delta envelope shape', () => {
    const message = createTrustListDeltaMessage({
      id: VALID_ID,
      from: ALICE_DID,
      to: [BOB_DID, CAROL_DID],
      createdTime: 1776514800,
      delta: VALID_DELTA,
      thid: VALID_THID,
      pthid: VALID_PTHID,
    })

    expect(message).toEqual({
      id: VALID_ID,
      typ: 'application/didcomm-plain+json',
      type: 'https://web-of-trust.de/protocols/trust-list-delta/1.0',
      from: ALICE_DID,
      to: [BOB_DID, CAROL_DID],
      created_time: 1776514800,
      thid: VALID_THID,
      pthid: VALID_PTHID,
      body: {
        delta: VALID_DELTA,
      },
    })
    expect(parseTrustListDeltaMessage(message)).toEqual(message)
    expect(() => assertTrustListDeltaMessage(message)).not.toThrow()
  })

  it('allows unknown top-level envelope extension fields', () => {
    const message = {
      ...validMessage(),
      expires_time: 1776518400,
      localExtension: { ignoredByThisSlice: true },
    }

    expect(parseTrustListDeltaMessage(message)).toEqual(message)
  })

  it('rejects invalid envelope fields covered by the H03 schema', () => {
    const invalidMessages: Array<[string, unknown]> = [
      ['missing typ', withoutEnvelopeField('typ')],
      ['missing type', withoutEnvelopeField('type')],
      ['missing id', withoutEnvelopeField('id')],
      ['missing from', withoutEnvelopeField('from')],
      ['missing created_time', withoutEnvelopeField('created_time')],
      ['invalid typ', validMessage({ typ: 'application/json' as any })],
      ['invalid type', validMessage({ type: 'https://web-of-trust.de/protocols/other/1.0' as any })],
      ['invalid id', validMessage({ id: 'not-a-uuid' })],
      ['invalid from', validMessage({ from: 'alice' })],
      ['missing to', { ...validMessage(), to: undefined }],
      ['empty to', validMessage({ to: [] })],
      ['invalid to DID', validMessage({ to: [BOB_DID, 'bob'] })],
      ['invalid created_time type', validMessage({ created_time: '1776514800' as any })],
      ['negative created_time', validMessage({ created_time: -1 })],
      ['fractional created_time', validMessage({ created_time: 1776514800.5 })],
      ['invalid thid', validMessage({ thid: 'not-a-uuid' })],
      ['invalid pthid', validMessage({ pthid: 'not-a-uuid' })],
    ]

    for (const [name, message] of invalidMessages) {
      expect(() => parseTrustListDeltaMessage(message), name).toThrow()
    }
  })

  it('validates body.delta as an SD-JWT-VC compact string without verifying its signature or disclosures', () => {
    const validDeltas = [
      // Mirrors the current schema exactly; wot-spec#44 tracks whether empty disclosure segments should be valid.
      'aaa.bbb.ccc~',
      'aaa.bbb.ccc~~',
      'aaa.bbb.ccc~disclosure~',
      'aaa.bbb.ccc~disclosure~holderbinding',
    ]

    for (const delta of validDeltas) {
      expect(parseTrustListDeltaMessage(validMessage({ body: { delta } })).body.delta, delta).toBe(delta)
    }

    const invalidBodies: Array<[string, unknown]> = [
      ['missing delta', {}],
      ['non-string delta', { delta: 123 }],
      ['missing disclosure separator', { delta: 'aaa.bbb.ccc' }],
      ['invalid compact JWS prefix', { delta: 'aaa.bbb~disclosure~' }],
      ['invalid base64url characters', { delta: 'aaa.bbb.ccc~not+base64url~' }],
      ['empty delta', { delta: '' }],
    ]

    for (const [name, body] of invalidBodies) {
      expect(() => parseTrustListDeltaMessage(validMessage({ body: body as any })), name).toThrow()
    }
  })

  it('rejects unknown body fields and non-object bodies', () => {
    expect(() =>
      parseTrustListDeltaMessage(validMessage({
        body: {
          delta: VALID_DELTA,
          hopLimit: 2,
        } as any,
      })),
    ).toThrow()
    expect(() => parseTrustListDeltaMessage(validMessage({ body: VALID_DELTA as any }))).toThrow()
    expect(() => parseTrustListDeltaMessage(validMessage({ body: null as any }))).toThrow()
    expect(() => parseTrustListDeltaMessage(validMessage({ body: [VALID_DELTA] as any }))).toThrow()
  })
})
