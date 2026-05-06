import { decodeBase64Url } from '../crypto/encoding'
import type { AttestationVcPayload } from './attestation-vc-jws'

const QR_CHALLENGE_FIELDS = new Set(['did', 'name', 'enc', 'nonce', 'ts', 'broker'])
const DID_PATTERN = /^did:[a-z0-9]+:.+/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_TOKEN_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const BROKER_PATTERN = /^(wss?|https?):\/\/.+/
const ACTIVE_CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000

export interface QrChallenge {
  did: string
  name: string
  enc: string
  nonce: string
  ts: string
  broker?: string
}

export interface ActiveQrChallengeValidityOptions {
  now: Date
  maxAgeMs?: number
}

export interface VerificationAttestationAcceptanceOptions {
  payload: AttestationVcPayload
  localDid: string
  activeChallenge?: Pick<QrChallenge, 'nonce' | 'ts'>
  now: Date
  consumedNonces: ReadonlySet<string>
}

export type VerificationAttestationAcceptanceDecision =
  | { decision: 'accept-in-person'; nonce: string }
  | { decision: 'remote-unbound'; reason: 'missing-jti-nonce' | 'no-active-matching-nonce' }
  | { decision: 'reject'; reason: 'wrong-subject' | 'nonce-consumed' | 'challenge-expired' }

export function parseQrChallenge(rawJson: string): QrChallenge {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new Error('Invalid QR challenge JSON')
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) throw new Error('Invalid QR challenge object')
  for (const field of Object.keys(parsed)) {
    if (!QR_CHALLENGE_FIELDS.has(field)) throw new Error(`Invalid QR challenge field: ${field}`)
  }

  const challenge = parsed as Record<string, unknown>
  assertStringField(challenge, 'did')
  assertStringField(challenge, 'name')
  assertStringField(challenge, 'enc')
  assertStringField(challenge, 'nonce')
  assertStringField(challenge, 'ts')
  if (challenge.broker !== undefined && typeof challenge.broker !== 'string') {
    throw new Error('Invalid QR challenge broker')
  }

  if (!DID_PATTERN.test(challenge.did)) throw new Error('Invalid QR challenge did')
  if (challenge.name.length < 1) throw new Error('Invalid QR challenge name')
  if (!BASE64URL_PATTERN.test(challenge.enc)) throw new Error('Invalid QR challenge enc')
  if (decodeBase64Url(challenge.enc).byteLength !== 32) throw new Error('Invalid QR challenge enc length')
  if (!UUID_PATTERN.test(challenge.nonce)) throw new Error('Invalid QR challenge nonce')
  if (!isValidDateTime(challenge.ts)) throw new Error('Invalid QR challenge ts')
  if (challenge.broker !== undefined && !BROKER_PATTERN.test(challenge.broker)) {
    throw new Error('Invalid QR challenge broker')
  }

  const result: QrChallenge = {
    did: challenge.did,
    name: challenge.name,
    enc: challenge.enc,
    nonce: challenge.nonce.toLowerCase(),
    ts: challenge.ts,
  }
  if (challenge.broker !== undefined) result.broker = challenge.broker
  return result
}

export function isActiveQrChallengeValid(
  challenge: Pick<QrChallenge, 'ts'>,
  options: ActiveQrChallengeValidityOptions,
): boolean {
  const challengeTime = Date.parse(challenge.ts)
  if (!Number.isFinite(challengeTime)) return false
  const ageMs = options.now.getTime() - challengeTime
  const maxAgeMs = options.maxAgeMs ?? ACTIVE_CHALLENGE_MAX_AGE_MS
  return ageMs >= 0 && ageMs <= maxAgeMs
}

export function decideVerificationAttestationAcceptance(
  options: VerificationAttestationAcceptanceOptions,
): VerificationAttestationAcceptanceDecision {
  if (options.payload.sub !== options.localDid || options.payload.credentialSubject?.id !== options.localDid) {
    return { decision: 'reject', reason: 'wrong-subject' }
  }
  if (!options.payload.jti) return { decision: 'remote-unbound', reason: 'missing-jti-nonce' }
  const activeNonce = options.activeChallenge?.nonce.toLowerCase()
  if (!options.activeChallenge || !activeNonce || !jtiContainsNonce(options.payload.jti, activeNonce)) {
    return { decision: 'remote-unbound', reason: 'no-active-matching-nonce' }
  }
  if (hasConsumedNonce(options.consumedNonces, activeNonce)) {
    return { decision: 'reject', reason: 'nonce-consumed' }
  }
  if (!isActiveQrChallengeValid(options.activeChallenge, { now: options.now })) {
    return { decision: 'reject', reason: 'challenge-expired' }
  }
  return { decision: 'accept-in-person', nonce: activeNonce }
}

function assertStringField<K extends string>(
  record: Record<string, unknown>,
  field: K,
): asserts record is Record<string, unknown> & Record<K, string> {
  if (typeof record[field] !== 'string') throw new Error(`Missing QR challenge field: ${field}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isValidDateTime(value: string): boolean {
  return DATE_TIME_PATTERN.test(value) && Number.isFinite(Date.parse(value))
}

function jtiContainsNonce(jti: string, nonce: string): boolean {
  UUID_TOKEN_PATTERN.lastIndex = 0
  for (const match of jti.matchAll(UUID_TOKEN_PATTERN)) {
    if (match[0].toLowerCase() === nonce) return true
  }
  return false
}

function hasConsumedNonce(consumedNonces: ReadonlySet<string>, nonce: string): boolean {
  for (const consumedNonce of consumedNonces) {
    if (consumedNonce.toLowerCase() === nonce) return true
  }
  return false
}
