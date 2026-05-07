import { decodeBase64Url } from '../crypto/encoding'
import type { AttestationVcPayload } from './attestation-vc-jws'

const QR_CHALLENGE_FIELDS = new Set(['did', 'name', 'enc', 'nonce', 'ts', 'broker'])
const DID_PATTERN = /^did:[a-z0-9]+:.+/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const DATE_TIME_PARTS_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/
const BROKER_PROTOCOLS = new Set(['ws:', 'wss:', 'http:', 'https:'])
const ACTIVE_CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000
const VERIFICATION_ATTESTATION_CLAIM = 'in-person verifiziert'

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
  | { decision: 'reject'; reason: 'wrong-subject' | 'not-verification-attestation' | 'nonce-consumed' | 'challenge-expired' }

/**
 * Implements wot-spec Trust 002 QR challenge parsing and online nonce acceptance.
 * References: Trust 002 `QR-Code-Format`, `Acceptance Gate fuer Online-Verifikation`, and `qr-challenge.schema.json`.
 */
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
  if (challenge.broker !== undefined) assertValidBroker(challenge.broker)

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
  if (!isValidDateTime(challenge.ts)) return false
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
  if (!isVerificationAttestationPayload(options.payload)) {
    return { decision: 'reject', reason: 'not-verification-attestation' }
  }
  if (!options.payload.jti) return { decision: 'remote-unbound', reason: 'missing-jti-nonce' }
  const activeNonce = options.activeChallenge?.nonce.toLowerCase()
  if (!options.activeChallenge || !activeNonce || !jtiContainsActiveNonce(options.payload.jti, activeNonce)) {
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
  if (record[field] === undefined) throw new Error(`Missing QR challenge field: ${field}`)
  if (typeof record[field] !== 'string') throw new Error(`Invalid QR challenge field: ${field}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isValidDateTime(value: string): boolean {
  const match = DATE_TIME_PARTS_PATTERN.exec(value)
  if (!match) return false
  if (!DATE_TIME_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) return false

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText)
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText)
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false

  const localTime = Date.UTC(year, month - 1, day, hour, minute, second)
  const localDate = new Date(localTime)
  return (
    localDate.getUTCFullYear() === year &&
    localDate.getUTCMonth() === month - 1 &&
    localDate.getUTCDate() === day &&
    localDate.getUTCHours() === hour &&
    localDate.getUTCMinutes() === minute &&
    localDate.getUTCSeconds() === second
  )
}

function isVerificationAttestationPayload(payload: AttestationVcPayload): boolean {
  return (
    payload.type.includes('VerifiableCredential') &&
    payload.type.includes('WotAttestation') &&
    payload.credentialSubject.claim === VERIFICATION_ATTESTATION_CLAIM
  )
}

function assertValidBroker(value: string): void {
  if (value.trim() !== value || /\s/.test(value)) throw new Error('Invalid QR challenge broker')

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid QR challenge broker')
  }

  if (!BROKER_PROTOCOLS.has(url.protocol)) throw new Error('Invalid QR challenge broker')
  if (url.username || url.password) throw new Error('Invalid QR challenge broker')
  if (!isValidBrokerHostname(url.hostname)) throw new Error('Invalid QR challenge broker')
  if (url.port && !/^\d+$/.test(url.port)) throw new Error('Invalid QR challenge broker')
}

function isValidBrokerHostname(hostname: string): boolean {
  if (hostname.length === 0) return false
  if (hostname === 'localhost') return true
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true
  if (/^\d+(?:\.\d+){3}$/.test(hostname)) {
    return hostname.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  }
  return hostname.split('.').every((part) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))
}

function jtiContainsActiveNonce(jti: string, nonce: string): boolean {
  if (!UUID_PATTERN.test(nonce)) return false

  // Trust 002 requires that the Verification-Attestation ID contains the active challenge nonce.
  return jti.toLowerCase().includes(nonce)
}

function hasConsumedNonce(consumedNonces: ReadonlySet<string>, nonce: string): boolean {
  for (const consumedNonce of consumedNonces) {
    if (consumedNonce.toLowerCase() === nonce) return true
  }
  return false
}
