import { describe, expect, it } from 'vitest'
import {
  decideBrokerChallengeNonceConsumption,
  formatBrokerChallengeNonce,
  parseBrokerChallengeNonce,
} from '../src/protocol'

const THIRTY_TWO_BYTE_NONCE = Uint8Array.from({ length: 32 }, (_, index) => index)
const CANONICAL_NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

describe('Sync 003 broker auth nonce policy', () => {
  it('formats exactly 32 nonce bytes as an unpadded Base64URL challenge nonce', () => {
    expect(formatBrokerChallengeNonce(THIRTY_TWO_BYTE_NONCE)).toBe(CANONICAL_NONCE)
    expect(formatBrokerChallengeNonce(new Uint8Array(32))).toBe(
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    )

    expect(() => formatBrokerChallengeNonce(new Uint8Array(31))).toThrow('Expected 32-byte broker nonce')
    expect(() => formatBrokerChallengeNonce(new Uint8Array(33))).toThrow('Expected 32-byte broker nonce')
    expect(() => formatBrokerChallengeNonce(new Uint8Array())).toThrow('Expected 32-byte broker nonce')
  })

  it('parses only canonical unpadded Base64URL nonces that decode to exactly 32 bytes', () => {
    const parsed = parseBrokerChallengeNonce(CANONICAL_NONCE)

    expect(parsed).toEqual({
      canonicalNonce: CANONICAL_NONCE,
      bytes: THIRTY_TWO_BYTE_NONCE,
    })

    for (const invalidNonce of [
      '',
      `${CANONICAL_NONCE}=`,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'not+base64url',
      'not/base64url',
      'has whitespace',
      'abc=',
      'A'.repeat(10_000),
    ]) {
      expect(() => parseBrokerChallengeNonce(invalidNonce), invalidNonce).toThrow()
    }
  })

  it('rejects replayed consumed nonces without mutating caller-supplied history', () => {
    const parsed = parseBrokerChallengeNonce(CANONICAL_NONCE)
    const consumedNonces = new Set<string>([CANONICAL_NONCE])

    expect(
      decideBrokerChallengeNonceConsumption({
        nonce: parsed,
        consumedNonces,
        now: new Date('2026-04-22T10:00:00Z'),
      }),
    ).toEqual({
      decision: 'reject',
      reason: 'nonce-replay',
      canonicalNonce: CANONICAL_NONCE,
    })
    expect([...consumedNonces]).toEqual([CANONICAL_NONCE])
  })

  it('returns a deterministic remember action retaining accepted nonces for at least 24 hours', () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const parsed = parseBrokerChallengeNonce(CANONICAL_NONCE)
    const decision = decideBrokerChallengeNonceConsumption({
      nonce: parsed,
      consumedNonces: new Set<string>(),
      now,
    })

    expect(decision).toEqual({
      decision: 'accept',
      canonicalNonce: CANONICAL_NONCE,
      remember: {
        type: 'remember-consumed-nonce',
        canonicalNonce: CANONICAL_NONCE,
        until: new Date('2026-04-23T10:00:00Z'),
      },
    })
    if (decision.decision !== 'accept') throw new Error('Expected nonce acceptance')
    expect(decision.remember.until.getTime() - now.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
  })

  it('rejects invalid current time before computing nonce retention', () => {
    const parsed = parseBrokerChallengeNonce(CANONICAL_NONCE)

    expect(() =>
      decideBrokerChallengeNonceConsumption({
        nonce: parsed,
        consumedNonces: new Set<string>(),
        now: new Date('not-a-date'),
      }),
    ).toThrow('Invalid broker nonce consumption time')
  })
})
