import { decodeBase64Url, encodeBase64Url } from '../crypto/encoding'

const BROKER_AUTH_NONCE_BYTES = 32
const BROKER_AUTH_NONCE_RETENTION_MS = 24 * 60 * 60 * 1000
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export interface ParsedBrokerChallengeNonce {
  canonicalNonce: string
  bytes: Uint8Array
}

export interface BrokerChallengeNonceConsumptionOptions {
  nonce: ParsedBrokerChallengeNonce
  consumedNonces: ReadonlySet<string>
  now: Date
}

export type BrokerChallengeNonceConsumptionDecision =
  | {
      decision: 'accept'
      canonicalNonce: string
      remember: {
        type: 'remember-consumed-nonce'
        canonicalNonce: string
        until: Date
      }
    }
  | {
      decision: 'reject'
      reason: 'nonce-replay'
      canonicalNonce: string
    }

/**
 * Formats broker Challenge-Response nonce bytes for Sync 003.
 *
 * This helper is intentionally limited to the normative nonce policy: exactly
 * 32 random bytes in, unpadded Base64URL out. Randomness is supplied by the
 * caller so protocol-core remains deterministic and storage-free.
 */
export function formatBrokerChallengeNonce(bytes: Uint8Array): string {
  if (bytes.byteLength !== BROKER_AUTH_NONCE_BYTES) throw new Error('Expected 32-byte broker nonce')
  return encodeBase64Url(bytes)
}

/**
 * Parses a broker Challenge-Response nonce in canonical challenge form.
 *
 * Padded, empty, malformed, non-canonical, and wrong-length values are rejected.
 */
export function parseBrokerChallengeNonce(value: string): ParsedBrokerChallengeNonce {
  if (value.length === 0 || !BASE64URL_PATTERN.test(value)) throw new Error('Invalid broker nonce')

  let bytes: Uint8Array
  try {
    bytes = decodeBase64Url(value)
  } catch {
    throw new Error('Invalid broker nonce')
  }

  if (bytes.byteLength !== BROKER_AUTH_NONCE_BYTES) throw new Error('Invalid broker nonce length')
  const canonicalNonce = formatBrokerChallengeNonce(bytes)
  if (canonicalNonce !== value) throw new Error('Invalid broker nonce canonical form')
  return { canonicalNonce, bytes }
}

/**
 * Classifies an already-issued parsed broker nonce against caller-owned history.
 *
 * The returned remember action is deterministic guidance for the caller's
 * storage layer; this helper does not mutate or persist nonce history.
 */
export function decideBrokerChallengeNonceConsumption(
  options: BrokerChallengeNonceConsumptionOptions,
): BrokerChallengeNonceConsumptionDecision {
  const canonicalNonce = options.nonce.canonicalNonce
  if (options.consumedNonces.has(canonicalNonce)) {
    return { decision: 'reject', reason: 'nonce-replay', canonicalNonce }
  }

  return {
    decision: 'accept',
    canonicalNonce,
    remember: {
      type: 'remember-consumed-nonce',
      canonicalNonce,
      until: new Date(options.now.getTime() + BROKER_AUTH_NONCE_RETENTION_MS),
    },
  }
}
