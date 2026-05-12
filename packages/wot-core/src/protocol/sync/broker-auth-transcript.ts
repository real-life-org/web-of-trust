import { canonicalizeToBytes } from '../crypto/jcs'
import type { JsonValue } from '../crypto/jcs'
import type { BrokerErrorCode } from './broker-error'
import { parseBrokerChallengeNonce } from './broker-auth-nonce'

export const BROKER_AUTH_TRANSCRIPT_PROTOCOL = 'wot/broker-auth/v1'
export const BROKER_AUTH_TRANSCRIPT_TYPE = 'challenge-response'

export interface BrokerAuthTranscriptInput {
  did: string
  deviceId: string
  nonce: string
}

export interface BrokerAuthTranscript {
  protocol: typeof BROKER_AUTH_TRANSCRIPT_PROTOCOL
  type: typeof BROKER_AUTH_TRANSCRIPT_TYPE
  did: string
  deviceId: string
  nonce: string
}

export interface BrokerAuthPendingChallenge {
  did: string
  deviceId: string
  nonce: string
}

export interface BrokerAuthChallengeResponseCandidate {
  type: typeof BROKER_AUTH_TRANSCRIPT_TYPE
  did: string
  deviceId: string
  nonce: string
}

export interface BrokerAuthChallengeResponseBindingInput {
  pendingChallenge: BrokerAuthPendingChallenge
  candidate: BrokerAuthChallengeResponseCandidate
}

export type BrokerAuthChallengeResponseBindingDisposition =
  | {
      disposition: 'accepted'
      transcript: BrokerAuthTranscript
      signingBytes: Uint8Array
    }
  | {
      disposition: 'rejected'
      errorCode: Extract<BrokerErrorCode, 'MALFORMED_MESSAGE' | 'AUTH_INVALID'>
    }

/**
 * Builds the Sync 003 Broker-Auth-Transcript object signed by
 * `challenge-response`. The `signature` wire field is intentionally excluded
 * until real-life-org/wot-spec#50 clarifies its canonical encoding.
 */
export function buildBrokerAuthTranscript(input: BrokerAuthTranscriptInput): BrokerAuthTranscript {
  const did = canonicalDid(input.did)
  const deviceId = canonicalDeviceId(input.deviceId)
  const nonce = canonicalNonce(input.nonce)

  return {
    protocol: BROKER_AUTH_TRANSCRIPT_PROTOCOL,
    type: BROKER_AUTH_TRANSCRIPT_TYPE,
    did,
    deviceId,
    nonce,
  }
}

export function createBrokerAuthTranscriptSigningBytes(transcript: BrokerAuthTranscript): Uint8Array {
  assertBrokerAuthTranscriptConstants(transcript)
  return canonicalizeToBytes(transcript as unknown as JsonValue)
}

/**
 * Applies the Sync 003 pending-challenge binding rule before signature
 * verification: `did`, `deviceId`, and `nonce` must exactly match the
 * caller-owned outstanding challenge.
 */
export function classifyBrokerAuthChallengeResponseBinding(
  input: BrokerAuthChallengeResponseBindingInput,
): BrokerAuthChallengeResponseBindingDisposition {
  let pendingChallenge: BrokerAuthPendingChallenge
  let candidate: BrokerAuthChallengeResponseCandidate

  try {
    pendingChallenge = {
      did: canonicalDid(input.pendingChallenge.did),
      deviceId: canonicalDeviceId(input.pendingChallenge.deviceId),
      nonce: canonicalNonce(input.pendingChallenge.nonce),
    }
    candidate = {
      type: canonicalChallengeResponseType(input.candidate.type),
      did: canonicalDid(input.candidate.did),
      deviceId: canonicalDeviceId(input.candidate.deviceId),
      nonce: canonicalNonce(input.candidate.nonce),
    }
  } catch {
    return {
      disposition: 'rejected',
      errorCode: 'MALFORMED_MESSAGE',
    }
  }

  if (
    candidate.did !== pendingChallenge.did ||
    candidate.deviceId !== pendingChallenge.deviceId ||
    candidate.nonce !== pendingChallenge.nonce
  ) {
    return {
      disposition: 'rejected',
      errorCode: 'AUTH_INVALID',
    }
  }

  const transcript = buildBrokerAuthTranscript(candidate)
  return {
    disposition: 'accepted',
    transcript,
    signingBytes: createBrokerAuthTranscriptSigningBytes(transcript),
  }
}

function canonicalDid(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid broker auth DID')
  return value
}

function canonicalDeviceId(value: unknown): string {
  if (typeof value !== 'string' || !isCanonicalLowercaseUuidV4(value)) {
    throw new Error('Invalid broker auth deviceId')
  }
  return value
}

function canonicalNonce(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid broker auth nonce')
  return parseBrokerChallengeNonce(value).canonicalNonce
}

function canonicalChallengeResponseType(value: unknown): typeof BROKER_AUTH_TRANSCRIPT_TYPE {
  if (value !== BROKER_AUTH_TRANSCRIPT_TYPE) throw new Error('Invalid broker auth response type')
  return BROKER_AUTH_TRANSCRIPT_TYPE
}

function assertBrokerAuthTranscriptConstants(
  transcript: BrokerAuthTranscript,
): asserts transcript is BrokerAuthTranscript {
  if (
    transcript.protocol !== BROKER_AUTH_TRANSCRIPT_PROTOCOL ||
    transcript.type !== BROKER_AUTH_TRANSCRIPT_TYPE
  ) {
    throw new Error('Invalid broker auth transcript')
  }
}

function isCanonicalLowercaseUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}
