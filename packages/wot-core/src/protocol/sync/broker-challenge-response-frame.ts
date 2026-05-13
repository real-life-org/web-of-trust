import { decodeBase64Url, encodeBase64Url } from '../crypto/encoding'
import {
  BROKER_AUTH_TRANSCRIPT_TYPE,
  buildBrokerAuthTranscript,
  classifyBrokerAuthChallengeResponseBinding,
  createBrokerAuthTranscriptSigningBytes,
  type BrokerAuthChallengeResponseBindingDisposition,
  type BrokerAuthPendingChallenge,
  type BrokerAuthTranscript,
} from './broker-auth-transcript'
import type { ProtocolCryptoAdapter } from '../crypto/ports'
import type { BrokerErrorCode } from './broker-error'

export const BROKER_CHALLENGE_RESPONSE_CONTROL_FRAME_TYPE = BROKER_AUTH_TRANSCRIPT_TYPE

const BROKER_CHALLENGE_RESPONSE_SIGNATURE_BYTES = 64
const BROKER_CHALLENGE_RESPONSE_SIGNATURE_BASE64URL_LENGTH = 86
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export interface BrokerChallengeResponseControlFrame {
  type: typeof BROKER_CHALLENGE_RESPONSE_CONTROL_FRAME_TYPE
  did: string
  deviceId: string
  nonce: string
  signature: string
}

export interface ParsedBrokerChallengeResponseControlFrame
  extends BrokerChallengeResponseControlFrame {
  signatureBytes: Uint8Array
  transcript: BrokerAuthTranscript
  signingBytes: Uint8Array
}

export interface CreateBrokerChallengeResponseControlFrameOptions {
  did: string
  deviceId: string
  nonce: string
  signature: Uint8Array
}

export interface VerifyBrokerChallengeResponseControlFrameOptions {
  frame: unknown
  pendingChallenge: BrokerAuthPendingChallenge
  publicKey: Uint8Array
  crypto: Pick<ProtocolCryptoAdapter, 'verifyEd25519'>
}

export type BrokerChallengeResponseVerificationResult =
  | {
      disposition: 'accepted'
      frame: BrokerChallengeResponseControlFrame
      transcript: BrokerAuthTranscript
      signingBytes: Uint8Array
    }
  | {
      disposition: 'rejected'
      errorCode: Extract<BrokerErrorCode, 'MALFORMED_MESSAGE' | 'AUTH_INVALID'>
    }

/**
 * Creates the Sync 003 `challenge-response` Broker Control-Frame wire shape.
 * See Sync 003 "Wire-Encoding der `signature` (MUSS)" and
 * real-life-org/wot-spec#50 for the normative signature field encoding.
 *
 * This helper only serializes the normative frame fields. Ed25519 signing,
 * DID resolution, pending-challenge storage, and WebSocket
 * connection binding remain caller/runtime responsibilities.
 */
export function createBrokerChallengeResponseControlFrame(
  options: CreateBrokerChallengeResponseControlFrameOptions,
): BrokerChallengeResponseControlFrame {
  const parsed = parseBrokerChallengeResponseControlFrame({
    type: BROKER_CHALLENGE_RESPONSE_CONTROL_FRAME_TYPE,
    did: options.did,
    deviceId: options.deviceId,
    nonce: options.nonce,
    signature: formatBrokerChallengeResponseSignature(options.signature),
  })

  return {
    type: parsed.type,
    did: parsed.did,
    deviceId: parsed.deviceId,
    nonce: parsed.nonce,
    signature: parsed.signature,
  }
}

export function parseBrokerChallengeResponseControlFrame(
  value: unknown,
): ParsedBrokerChallengeResponseControlFrame {
  const frame = assertRecord(value, 'broker challenge-response control-frame')
  assertBrokerChallengeResponseControlFrameTopLevelKeys(frame)
  assertRequiredOwnProperty(frame, 'type')
  assertRequiredOwnProperty(frame, 'did')
  assertRequiredOwnProperty(frame, 'deviceId')
  assertRequiredOwnProperty(frame, 'nonce')
  assertRequiredOwnProperty(frame, 'signature')
  assertChallengeResponseControlFrameType(frame.type)

  const signature = parseBrokerChallengeResponseSignature(frame.signature)
  const transcript = buildBrokerAuthTranscript({
    did: frame.did as string,
    deviceId: frame.deviceId as string,
    nonce: frame.nonce as string,
  })

  return {
    type: BROKER_CHALLENGE_RESPONSE_CONTROL_FRAME_TYPE,
    did: transcript.did,
    deviceId: transcript.deviceId,
    nonce: transcript.nonce,
    signature: signature.canonicalSignature,
    signatureBytes: signature.bytes,
    transcript,
    signingBytes: createBrokerAuthTranscriptSigningBytes(transcript),
  }
}

export function assertBrokerChallengeResponseControlFrame(
  value: unknown,
): asserts value is BrokerChallengeResponseControlFrame {
  parseBrokerChallengeResponseControlFrame(value)
}

/**
 * Verifies a Sync 003 `challenge-response` Broker Control-Frame against a
 * caller-owned pending challenge and caller-supplied Ed25519 public key bytes.
 * See Sync 003 `03-wot-sync/003-transport-und-broker.md`
 * "Broker-Auth-Transcript (MUSS)", "Wire-Encoding der `signature` (MUSS)",
 * and the pending-challenge binding rule.
 *
 * This protocol helper is deterministic and storage-free: it does not resolve
 * DIDs, bind WebSocket connections, consume nonce history, emit runtime broker
 * errors, or mutate device registration state.
 */
export async function verifyBrokerChallengeResponseControlFrame(
  options: VerifyBrokerChallengeResponseControlFrameOptions,
): Promise<BrokerChallengeResponseVerificationResult> {
  assertEd25519PublicKey(options.publicKey)
  assertVerifier(options.crypto)

  let parsed: ParsedBrokerChallengeResponseControlFrame
  try {
    parsed = parseBrokerChallengeResponseControlFrame(options.frame)
  } catch {
    return {
      disposition: 'rejected',
      errorCode: 'MALFORMED_MESSAGE',
    }
  }

  let binding: BrokerAuthChallengeResponseBindingDisposition
  try {
    binding = classifyBrokerAuthChallengeResponseBinding({
      pendingChallenge: options.pendingChallenge,
      candidate: {
        type: parsed.type,
        did: parsed.did,
        deviceId: parsed.deviceId,
        nonce: parsed.nonce,
      },
    })
  } catch {
    return {
      disposition: 'rejected',
      errorCode: 'MALFORMED_MESSAGE',
    }
  }

  if (binding.disposition === 'rejected') return binding

  // Sync 003 defines AUTH_INVALID for well-formed invalid signatures. Local
  // verifier adapter faults are not peer-auth failures, so they propagate.
  const signatureValid = await options.crypto.verifyEd25519(
    binding.signingBytes,
    parsed.signatureBytes,
    options.publicKey,
  )

  if (!signatureValid) {
    return {
      disposition: 'rejected',
      errorCode: 'AUTH_INVALID',
    }
  }

  return {
    disposition: 'accepted',
    frame: {
      type: parsed.type,
      did: parsed.did,
      deviceId: parsed.deviceId,
      nonce: parsed.nonce,
      signature: parsed.signature,
    },
    transcript: binding.transcript,
    signingBytes: binding.signingBytes,
  }
}

export function formatBrokerChallengeResponseSignature(bytes: Uint8Array): string {
  if (bytes.byteLength !== BROKER_CHALLENGE_RESPONSE_SIGNATURE_BYTES) {
    throw new Error('Invalid broker challenge-response signature length')
  }
  return encodeBase64Url(bytes)
}

function parseBrokerChallengeResponseSignature(value: unknown): {
  canonicalSignature: string
  bytes: Uint8Array
} {
  if (
    typeof value !== 'string' ||
    value.length !== BROKER_CHALLENGE_RESPONSE_SIGNATURE_BASE64URL_LENGTH ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new Error('Invalid broker challenge-response signature')
  }

  let bytes: Uint8Array
  try {
    bytes = decodeBase64Url(value)
  } catch {
    throw new Error('Invalid broker challenge-response signature')
  }

  if (bytes.byteLength !== BROKER_CHALLENGE_RESPONSE_SIGNATURE_BYTES) {
    throw new Error('Invalid broker challenge-response signature length')
  }

  const canonicalSignature = formatBrokerChallengeResponseSignature(bytes)
  if (canonicalSignature !== value) {
    throw new Error('Invalid broker challenge-response signature canonical form')
  }

  return { canonicalSignature, bytes }
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertBrokerChallengeResponseControlFrameTopLevelKeys(frame: Record<string, unknown>): void {
  const allowedKeys = new Set(['type', 'did', 'deviceId', 'nonce', 'signature'])
  for (const key of Object.keys(frame)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Invalid broker challenge-response control-frame property: ${key}`)
    }
  }
}

function assertRequiredOwnProperty(
  frame: Record<string, unknown>,
  key: 'type' | 'did' | 'deviceId' | 'nonce' | 'signature',
): void {
  if (!Object.prototype.hasOwnProperty.call(frame, key)) {
    throw new Error(`Invalid broker challenge-response control-frame ${key}`)
  }
}

function assertChallengeResponseControlFrameType(
  value: unknown,
): asserts value is typeof BROKER_CHALLENGE_RESPONSE_CONTROL_FRAME_TYPE {
  if (value !== BROKER_CHALLENGE_RESPONSE_CONTROL_FRAME_TYPE) {
    throw new Error('Invalid broker challenge-response control-frame type')
  }
}

function assertEd25519PublicKey(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error('Invalid broker challenge-response public key')
  }
}

function assertVerifier(value: unknown): asserts value is Pick<ProtocolCryptoAdapter, 'verifyEd25519'> {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Pick<ProtocolCryptoAdapter, 'verifyEd25519'>).verifyEd25519 !== 'function'
  ) {
    throw new Error('Invalid broker challenge-response verifier')
  }
}
