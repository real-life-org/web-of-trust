import { describe, expect, it } from 'vitest'
import {
  buildBrokerAuthTranscript,
  classifyBrokerAuthChallengeResponseBinding,
  createBrokerAuthTranscriptSigningBytes,
} from '../src/protocol'
import type {
  BrokerAuthChallengeResponseCandidate,
  BrokerAuthPendingChallenge,
} from '../src/protocol'

const DID = 'did:key:z6Mkalice'
const OTHER_DID = 'did:key:z6Mkbob'
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_DEVICE_ID = '123e4567-e89b-42d3-a456-426614174000'
const CANONICAL_NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const OTHER_CANONICAL_NONCE = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'

function pendingChallenge(
  overrides: Partial<BrokerAuthPendingChallenge> = {},
): BrokerAuthPendingChallenge {
  return {
    did: DID,
    deviceId: DEVICE_ID,
    nonce: CANONICAL_NONCE,
    ...overrides,
  }
}

function candidate(
  overrides: Partial<BrokerAuthChallengeResponseCandidate> = {},
): BrokerAuthChallengeResponseCandidate {
  return {
    type: 'challenge-response',
    did: DID,
    deviceId: DEVICE_ID,
    nonce: CANONICAL_NONCE,
    ...overrides,
  }
}

describe('Sync 003 broker auth transcript', () => {
  it('builds the exact challenge-response transcript object with canonical field values', () => {
    expect(buildBrokerAuthTranscript({
      did: DID,
      deviceId: DEVICE_ID,
      nonce: CANONICAL_NONCE,
    })).toEqual({
      protocol: 'wot/broker-auth/v1',
      type: 'challenge-response',
      did: DID,
      deviceId: DEVICE_ID,
      nonce: CANONICAL_NONCE,
    })
  })

  it('returns JCS-canonical transcript bytes with deterministic key ordering', () => {
    const transcript = buildBrokerAuthTranscript({
      did: DID,
      deviceId: DEVICE_ID,
      nonce: CANONICAL_NONCE,
    })

    const bytes = createBrokerAuthTranscriptSigningBytes(transcript)

    expect(new TextDecoder().decode(bytes)).toBe(
      '{"deviceId":"550e8400-e29b-41d4-a716-446655440000","did":"did:key:z6Mkalice","nonce":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","protocol":"wot/broker-auth/v1","type":"challenge-response"}',
    )
    expect(bytes).toEqual(createBrokerAuthTranscriptSigningBytes(transcript))
  })

  it('uses the canonical unpadded 32-byte Base64URL nonce unchanged in the transcript and signing bytes', () => {
    const transcript = buildBrokerAuthTranscript({
      did: DID,
      deviceId: DEVICE_ID,
      nonce: CANONICAL_NONCE,
    })

    expect(transcript.nonce).toBe(CANONICAL_NONCE)
    expect(new TextDecoder().decode(createBrokerAuthTranscriptSigningBytes(transcript))).toContain(
      `"nonce":"${CANONICAL_NONCE}"`,
    )
  })

  it('rejects malformed transcript inputs before signing or verification', () => {
    const invalidInputs = [
      { did: undefined, deviceId: DEVICE_ID, nonce: CANONICAL_NONCE },
      { did: '', deviceId: DEVICE_ID, nonce: CANONICAL_NONCE },
      { did: 123, deviceId: DEVICE_ID, nonce: CANONICAL_NONCE },
      { did: DID, deviceId: undefined, nonce: CANONICAL_NONCE },
      { did: DID, deviceId: '550E8400-E29B-41D4-A716-446655440000', nonce: CANONICAL_NONCE },
      { did: DID, deviceId: '550e8400-e29b-11d4-a716-446655440000', nonce: CANONICAL_NONCE },
      { did: DID, deviceId: 'not-a-uuid', nonce: CANONICAL_NONCE },
      { did: DID, deviceId: DEVICE_ID, nonce: undefined },
      { did: DID, deviceId: DEVICE_ID, nonce: `${CANONICAL_NONCE}=` },
      { did: DID, deviceId: DEVICE_ID, nonce: 'not+base64url' },
      { did: DID, deviceId: DEVICE_ID, nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    ] as const

    for (const input of invalidInputs) {
      expect(() => buildBrokerAuthTranscript(input as never), JSON.stringify(input)).toThrow()
    }
  })

  it('accepts a challenge-response candidate only when did, deviceId, and nonce exactly match the pending challenge', () => {
    expect(classifyBrokerAuthChallengeResponseBinding({
      pendingChallenge: pendingChallenge(),
      candidate: candidate(),
    })).toEqual({
      disposition: 'accepted',
      transcript: {
        protocol: 'wot/broker-auth/v1',
        type: 'challenge-response',
        did: DID,
        deviceId: DEVICE_ID,
        nonce: CANONICAL_NONCE,
      },
      signingBytes: createBrokerAuthTranscriptSigningBytes(buildBrokerAuthTranscript({
        did: DID,
        deviceId: DEVICE_ID,
        nonce: CANONICAL_NONCE,
      })),
    })
  })

  it('classifies malformed challenge-response DID, deviceId, and nonce inputs as MALFORMED_MESSAGE', () => {
    for (const malformedCandidate of [
      candidate({ did: undefined as unknown as string }),
      candidate({ did: 123 as unknown as string }),
      candidate({ deviceId: '550E8400-E29B-41D4-A716-446655440000' }),
      candidate({ deviceId: '550e8400-e29b-11d4-a716-446655440000' }),
      candidate({ nonce: `${CANONICAL_NONCE}=` }),
      candidate({ nonce: 'not/base64url' }),
      candidate({ nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    ]) {
      expect(classifyBrokerAuthChallengeResponseBinding({
        pendingChallenge: pendingChallenge(),
        candidate: malformedCandidate,
      }), JSON.stringify(malformedCandidate)).toEqual({
        disposition: 'rejected',
        errorCode: 'MALFORMED_MESSAGE',
      })
    }
  })

  it('classifies exact pending-challenge mismatches as AUTH_INVALID before signature verification', () => {
    for (const mismatchedCandidate of [
      candidate({ did: OTHER_DID }),
      candidate({ deviceId: OTHER_DEVICE_ID }),
      candidate({ nonce: OTHER_CANONICAL_NONCE }),
    ]) {
      expect(classifyBrokerAuthChallengeResponseBinding({
        pendingChallenge: pendingChallenge(),
        candidate: mismatchedCandidate,
      }), JSON.stringify(mismatchedCandidate)).toEqual({
        disposition: 'rejected',
        errorCode: 'AUTH_INVALID',
      })
    }
  })
})
