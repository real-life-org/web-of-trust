import { describe, expect, it } from 'vitest'
import {
  createSyncRequestMessage,
  createSyncResponseMessage,
  parseSyncRequestMessage,
  parseSyncResponseMessage,
  SYNC_REQUEST_MESSAGE_TYPE,
  SYNC_RESPONSE_MESSAGE_TYPE,
} from '../src/protocol'

const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440000'
const RESPONSE_ID = '550e8400-e29b-41d4-a716-446655440001'
const THREAD_ID = '550e8400-e29b-41d4-a716-446655440002'
const PARENT_THREAD_ID = '550e8400-e29b-41d4-a716-446655440003'
const DOC_ID = '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b'
const DEVICE_A = '11111111-2222-4333-8444-555555555555'
const DEVICE_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const FROM_DID = 'did:key:z6Mko3ZEjKJWQAM5nDXKoZ9jErvvxbWbYgS8KJXYpC5Hbu8a'
const TO_DID = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
const CREATED_TIME = 1776514800
const LOG_ENTRY_JWS = 'eyJhbGciOiJFZERTQSIsImtpZCI6ImRpZDprZXk6ejZNa28ifQ.eyJzZXEiOjB9.c2lnbmF0dXJl'

function validSyncRequestBody() {
  return {
    docId: DOC_ID,
    heads: {
      [DEVICE_A]: 0,
      [DEVICE_B]: 42,
    },
    limit: 100,
  }
}

function validSyncResponseBody() {
  return {
    docId: DOC_ID,
    entries: [LOG_ENTRY_JWS],
    heads: {
      [DEVICE_A]: 1,
      [DEVICE_B]: 42,
    },
    truncated: false,
  }
}

describe('WoT Sync 003 sync-request/response plaintext messages', () => {
  it('exports the normative sync-request and sync-response type URIs', () => {
    expect(SYNC_REQUEST_MESSAGE_TYPE).toBe('https://web-of-trust.de/protocols/sync-request/1.0')
    expect(SYNC_RESPONSE_MESSAGE_TYPE).toBe('https://web-of-trust.de/protocols/sync-response/1.0')
  })

  it('creates and parses a sync-request plaintext message without requiring to', () => {
    const message = createSyncRequestMessage({
      id: MESSAGE_ID,
      from: FROM_DID,
      createdTime: CREATED_TIME,
      thid: THREAD_ID,
      pthid: PARENT_THREAD_ID,
      body: validSyncRequestBody(),
    })

    expect(message).toEqual({
      id: MESSAGE_ID,
      typ: 'application/didcomm-plain+json',
      type: SYNC_REQUEST_MESSAGE_TYPE,
      from: FROM_DID,
      created_time: CREATED_TIME,
      thid: THREAD_ID,
      pthid: PARENT_THREAD_ID,
      body: validSyncRequestBody(),
    })
    expect(parseSyncRequestMessage(message)).toEqual(message)
  })

  it('creates and parses a sync-response plaintext message and requires response thid', () => {
    const message = createSyncResponseMessage({
      id: RESPONSE_ID,
      from: TO_DID,
      to: [FROM_DID],
      createdTime: CREATED_TIME + 1,
      thid: THREAD_ID,
      body: validSyncResponseBody(),
    })

    expect(message).toEqual({
      id: RESPONSE_ID,
      typ: 'application/didcomm-plain+json',
      type: SYNC_RESPONSE_MESSAGE_TYPE,
      from: TO_DID,
      to: [FROM_DID],
      created_time: CREATED_TIME + 1,
      thid: THREAD_ID,
      body: validSyncResponseBody(),
    })
    expect(parseSyncResponseMessage(message)).toEqual(message)
  })

  it('validates common plaintext envelope fields with the current generic plaintext rules', () => {
    const message = createSyncRequestMessage({
      id: MESSAGE_ID,
      from: FROM_DID,
      to: [TO_DID],
      createdTime: CREATED_TIME,
      body: validSyncRequestBody(),
    })

    expect(() => parseSyncRequestMessage({ ...message, id: MESSAGE_ID.toUpperCase() })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, id: '550e8400-e29b-51d4-a716-446655440000' })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, typ: 'application/json' })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, type: SYNC_RESPONSE_MESSAGE_TYPE })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, from: 'alice' })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, to: ['alice'] })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, created_time: -1 })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, created_time: 1.5 })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, thid: '' })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, pthid: '' })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, body: null })).toThrow()
  })

  it('keeps the generic thid/pthid UUID-v4 tightening deferred for sync-request', () => {
    const message = createSyncRequestMessage({
      id: MESSAGE_ID,
      from: FROM_DID,
      createdTime: CREATED_TIME,
      thid: 'request-thread-that-is-not-a-uuid',
      pthid: 'parent-thread-that-is-not-a-uuid',
      body: validSyncRequestBody(),
    })

    expect(parseSyncRequestMessage(message).thid).toBe('request-thread-that-is-not-a-uuid')
    expect(parseSyncRequestMessage(message).pthid).toBe('parent-thread-that-is-not-a-uuid')
  })

  it('requires sync-response thid while keeping exact UUID-v4 thid enforcement deferred', () => {
    const message = createSyncResponseMessage({
      id: RESPONSE_ID,
      from: TO_DID,
      createdTime: CREATED_TIME,
      thid: 'non-empty-request-thread',
      body: validSyncResponseBody(),
    })

    expect(parseSyncResponseMessage(message).thid).toBe('non-empty-request-thread')
    expect(() => createSyncResponseMessage({
      id: RESPONSE_ID,
      from: TO_DID,
      createdTime: CREATED_TIME,
      body: validSyncResponseBody(),
    } as any)).toThrow()
    expect(() => parseSyncResponseMessage({ ...message, thid: '' })).toThrow()
  })

  it('rejects missing required sync-request body fields and extra body fields', () => {
    const message = createSyncRequestMessage({
      id: MESSAGE_ID,
      from: FROM_DID,
      createdTime: CREATED_TIME,
      body: validSyncRequestBody(),
    })

    expect(() => parseSyncRequestMessage({ ...message, body: { heads: validSyncRequestBody().heads } })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, body: { docId: DOC_ID } })).toThrow()
    expect(() => parseSyncRequestMessage({ ...message, body: { ...validSyncRequestBody(), entries: [] } })).toThrow()
  })

  it('rejects malformed sync-request docId, heads keys and seq values', () => {
    const message = createSyncRequestMessage({
      id: MESSAGE_ID,
      from: FROM_DID,
      createdTime: CREATED_TIME,
      body: validSyncRequestBody(),
    })

    expect(() => parseSyncRequestMessage({
      ...message,
      body: { ...validSyncRequestBody(), docId: DOC_ID.toUpperCase() },
    })).toThrow()
    expect(() => parseSyncRequestMessage({
      ...message,
      body: { ...validSyncRequestBody(), docId: '7f3a2b10-4c5d-5e6f-8a7b-9c0d1e2f3a4b' },
    })).toThrow()
    expect(() => parseSyncRequestMessage({
      ...message,
      body: { ...validSyncRequestBody(), heads: { [DEVICE_B.toUpperCase()]: 0 } },
    })).toThrow()
    expect(() => parseSyncRequestMessage({
      ...message,
      body: { ...validSyncRequestBody(), heads: { 'not-a-device-uuid': 0 } },
    })).toThrow()
    expect(() => parseSyncRequestMessage({
      ...message,
      body: { ...validSyncRequestBody(), heads: { [DEVICE_A]: -1 } },
    })).toThrow()
    expect(() => parseSyncRequestMessage({
      ...message,
      body: { ...validSyncRequestBody(), heads: { [DEVICE_A]: 1.5 } },
    })).toThrow()
    expect(() => parseSyncRequestMessage({
      ...message,
      body: { ...validSyncRequestBody(), heads: { [DEVICE_A]: Number.MAX_SAFE_INTEGER + 1 } },
    })).toThrow()
  })

  it('allows empty sync-request heads but rejects malformed limit values', () => {
    expect(createSyncRequestMessage({
      id: MESSAGE_ID,
      from: FROM_DID,
      createdTime: CREATED_TIME,
      body: {
        docId: DOC_ID,
        heads: {},
      },
    }).body.heads).toEqual({})

    for (const limit of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100']) {
      expect(() => createSyncRequestMessage({
        id: MESSAGE_ID,
        from: FROM_DID,
        createdTime: CREATED_TIME,
        body: {
          ...validSyncRequestBody(),
          limit: limit as number,
        },
      })).toThrow()
    }
  })

  it('rejects missing required sync-response body fields and extra body fields', () => {
    const message = createSyncResponseMessage({
      id: RESPONSE_ID,
      from: TO_DID,
      createdTime: CREATED_TIME,
      thid: THREAD_ID,
      body: validSyncResponseBody(),
    })

    expect(() => parseSyncResponseMessage({
      ...message,
      body: {
        entries: validSyncResponseBody().entries,
        heads: validSyncResponseBody().heads,
        truncated: false,
      },
    })).toThrow()
    expect(() => parseSyncResponseMessage({
      ...message,
      body: {
        docId: DOC_ID,
        heads: validSyncResponseBody().heads,
        truncated: false,
      },
    })).toThrow()
    expect(() => parseSyncResponseMessage({
      ...message,
      body: {
        docId: DOC_ID,
        entries: validSyncResponseBody().entries,
        truncated: false,
      },
    })).toThrow()
    expect(() => parseSyncResponseMessage({
      ...message,
      body: {
        docId: DOC_ID,
        entries: validSyncResponseBody().entries,
        heads: validSyncResponseBody().heads,
      },
    })).toThrow()
    expect(() => parseSyncResponseMessage({
      ...message,
      body: { ...validSyncResponseBody(), limit: 100 },
    })).toThrow()
  })

  it('rejects malformed sync-response docId, heads, entries and truncated values', () => {
    const message = createSyncResponseMessage({
      id: RESPONSE_ID,
      from: TO_DID,
      createdTime: CREATED_TIME,
      thid: THREAD_ID,
      body: validSyncResponseBody(),
    })

    expect(() => parseSyncResponseMessage({
      ...message,
      body: { ...validSyncResponseBody(), docId: DOC_ID.toUpperCase() },
    })).toThrow()
    expect(() => parseSyncResponseMessage({
      ...message,
      body: { ...validSyncResponseBody(), heads: { [DEVICE_B.toUpperCase()]: 1 } },
    })).toThrow()
    expect(() => parseSyncResponseMessage({
      ...message,
      body: { ...validSyncResponseBody(), heads: { [DEVICE_A]: -1 } },
    })).toThrow()
    expect(() => parseSyncResponseMessage({
      ...message,
      body: { ...validSyncResponseBody(), entries: [] },
    })).not.toThrow()
    expect(() => parseSyncResponseMessage({
      ...message,
      body: { ...validSyncResponseBody(), entries: ['a.b'] },
    })).toThrow()
    expect(() => parseSyncResponseMessage({
      ...message,
      body: { ...validSyncResponseBody(), entries: ['a..c'] },
    })).toThrow()
    expect(() => parseSyncResponseMessage({
      ...message,
      body: { ...validSyncResponseBody(), entries: ['abc=.def.ghi'] },
    })).toThrow()
    expect(() => parseSyncResponseMessage({
      ...message,
      body: { ...validSyncResponseBody(), truncated: 'false' },
    })).toThrow()
  })
})
