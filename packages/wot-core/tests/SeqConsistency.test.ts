import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  classifyBrokerSeqCollision,
  classifyLocalBrokerSeqConsistency,
} from '../src/protocol'

const phase1 = JSON.parse(readFileSync('tests/fixtures/wot-spec/phase-1-interop.json', 'utf8'))

describe('sync seq consistency dispositions', () => {
  it('requires restore/clone handling when the broker has a higher seq than local persistence', () => {
    expect(classifyLocalBrokerSeqConsistency({
      docId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
      deviceId: '550e8400-e29b-41d4-a716-446655440000',
      localSeq: 41,
      brokerSeq: 42,
    })).toEqual({
      disposition: 'restore-clone-required',
      reason: 'broker-seq-greater-than-local-seq',
    })
  })

  it('does not require restore/clone when broker seq equals local seq', () => {
    expect(classifyLocalBrokerSeqConsistency({
      docId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
      deviceId: '550e8400-e29b-41d4-a716-446655440000',
      localSeq: 42,
      brokerSeq: 42,
    })).toEqual({
      disposition: 'no-restore-clone-detected',
      reason: 'broker-seq-not-greater-than-local-seq',
    })
  })

  it('does not require restore/clone when broker seq is lower than local seq', () => {
    expect(classifyLocalBrokerSeqConsistency({
      docId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
      deviceId: '550e8400-e29b-41d4-a716-446655440000',
      localSeq: 42,
      brokerSeq: 41,
    })).toEqual({
      disposition: 'no-restore-clone-detected',
      reason: 'broker-seq-not-greater-than-local-seq',
    })
  })

  it('validates local and broker seq values as non-negative safe integers', () => {
    const valid = {
      docId: 'not-uuid-v4-in-this-slice',
      deviceId: 'not-uuid-v4-in-this-slice',
      localSeq: 0,
      brokerSeq: 0,
    }

    for (const badSeq of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => classifyLocalBrokerSeqConsistency({ ...valid, localSeq: badSeq })).toThrow('Invalid localSeq')
      expect(() => classifyLocalBrokerSeqConsistency({ ...valid, brokerSeq: badSeq })).toThrow('Invalid brokerSeq')
    }
  })

  it('uses the phase-1 log_entry_jws payload seq example without validating UUID versions in this slice', () => {
    const payload = phase1.log_entry_jws.payload

    // UUID-version scope remains tracked in real-life-org/wot-spec#23; this helper only classifies seq state.
    expect(classifyLocalBrokerSeqConsistency({
      docId: payload.docId,
      deviceId: payload.deviceId,
      localSeq: payload.seq - 1,
      brokerSeq: payload.seq,
    })).toMatchObject({
      disposition: 'restore-clone-required',
    })
  })
})

describe('broker seq collision dispositions', () => {
  it('accepts a new entry when no existing content hash is present', () => {
    expect(classifyBrokerSeqCollision({
      docId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
      deviceId: '550e8400-e29b-41d4-a716-446655440000',
      seq: 42,
      existingContentHash: null,
      incomingContentHash: 'opaque-hash-token-1',
    })).toEqual({
      disposition: 'accept-new-entry',
    })
  })

  it('accepts a new entry when the existing content hash is undefined', () => {
    expect(classifyBrokerSeqCollision({
      docId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
      deviceId: '550e8400-e29b-41d4-a716-446655440000',
      seq: 42,
      existingContentHash: undefined,
      incomingContentHash: 'opaque-hash-token-1',
    })).toEqual({
      disposition: 'accept-new-entry',
    })
  })

  it('treats equal existing and incoming content hashes as idempotent retransmission', () => {
    expect(classifyBrokerSeqCollision({
      docId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
      deviceId: '550e8400-e29b-41d4-a716-446655440000',
      seq: 42,
      existingContentHash: 'opaque-hash-token-1',
      incomingContentHash: 'opaque-hash-token-1',
    })).toEqual({
      disposition: 'idempotent-retransmission',
    })
  })

  it('rejects different content hashes for the same docId/deviceId/seq as a seq collision', () => {
    expect(classifyBrokerSeqCollision({
      docId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
      deviceId: '550e8400-e29b-41d4-a716-446655440000',
      seq: 42,
      existingContentHash: 'opaque-hash-token-1',
      incomingContentHash: 'opaque-hash-token-2',
    })).toEqual({
      disposition: 'reject-seq-collision',
      errorCode: 'SEQ_COLLISION_DETECTED',
      clientHint: 'restore-clone-required',
    })
  })

  it('validates seq and content hashes without computing or canonicalizing hashes', () => {
    const valid = {
      docId: 'not-uuid-v4-in-this-slice',
      deviceId: 'not-uuid-v4-in-this-slice',
      seq: 0,
      existingContentHash: null,
      incomingContentHash: 'opaque-hash-token-1',
    }

    for (const badSeq of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => classifyBrokerSeqCollision({ ...valid, seq: badSeq })).toThrow('Invalid seq')
    }

    expect(() => classifyBrokerSeqCollision({ ...valid, incomingContentHash: '' })).toThrow(
      'Invalid incomingContentHash',
    )
    expect(() => classifyBrokerSeqCollision({ ...valid, existingContentHash: '' })).toThrow(
      'Invalid existingContentHash',
    )
  })
})
