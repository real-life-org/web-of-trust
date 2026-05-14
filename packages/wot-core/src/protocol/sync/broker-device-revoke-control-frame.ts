import { decodeJws, type DecodedJws } from '../crypto/jws'
import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { didOrKidToDid } from '../identity/did-key'
import type { BrokerErrorCode } from './broker-error'
import {
  validateDeviceRevokePayload,
  type DeviceRevokePayload,
} from './device-revocation-disposition'

export const BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE = 'device-revoke' as const

export interface BrokerDeviceRevokeControlFrame {
  type: typeof BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE
  revocationJws: string
}

export interface BrokerDeviceRevokeJwsHeader {
  alg: 'EdDSA'
  kid: string
  typ?: string
  [key: string]: unknown
}

export interface ParsedBrokerDeviceRevokeControlFrame extends BrokerDeviceRevokeControlFrame {
  header: Record<string, unknown>
  payload: DeviceRevokePayload
  signingBytes: Uint8Array
  signatureBytes: Uint8Array
}

export interface CreateBrokerDeviceRevokeControlFrameOptions {
  revocationJws: string
}

export interface VerifyBrokerDeviceRevokeControlFrameOptions {
  frame: unknown
  publicKey: Uint8Array
  crypto: Pick<ProtocolCryptoAdapter, 'verifyEd25519'>
}

export type BrokerDeviceRevokeVerificationResult =
  | {
      disposition: 'accepted'
      frame: BrokerDeviceRevokeControlFrame
      header: Record<string, unknown>
      payload: DeviceRevokePayload
      signingBytes: Uint8Array
      signatureBytes: Uint8Array
    }
  | {
      disposition: 'rejected'
      errorCode: Extract<BrokerErrorCode, 'MALFORMED_MESSAGE' | 'AUTH_INVALID'>
    }

/**
 * Creates the Sync 003 signed `device-revoke` Broker Control-Frame wire shape.
 *
 * This helper is intentionally protocol-only: it parses the closed outer
 * frame, decodes the inner JWS payload, and exposes bytes for verification.
 * Broker storage mutation, DID resolution policy, routing, inbox cleanup, and
 * runtime error emission remain caller responsibilities.
 */
export function createBrokerDeviceRevokeControlFrame(
  options: CreateBrokerDeviceRevokeControlFrameOptions,
): BrokerDeviceRevokeControlFrame {
  const parsed = parseBrokerDeviceRevokeControlFrame({
    type: BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE,
    revocationJws: options.revocationJws,
  })

  return {
    type: parsed.type,
    revocationJws: parsed.revocationJws,
  }
}

export function parseBrokerDeviceRevokeControlFrame(
  value: unknown,
): ParsedBrokerDeviceRevokeControlFrame {
  const frame = assertRecord(value, 'broker device-revoke control-frame')
  assertTopLevelKeys(frame)
  assertRequiredOwnProperty(frame, 'type')
  assertRequiredOwnProperty(frame, 'revocationJws')
  if (frame.type !== BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE) {
    throw new Error('Invalid broker device-revoke control-frame type')
  }
  if (typeof frame.revocationJws !== 'string' || !isCompactJws(frame.revocationJws)) {
    throw new Error('Invalid broker device-revoke revocationJws')
  }

  const decoded = decodeDeviceRevokeJws(frame.revocationJws)
  const validation = validateDeviceRevokePayload(decoded.payload)
  if (!validation.valid) throw new Error('Invalid broker device-revoke payload')

  return {
    type: BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE,
    revocationJws: frame.revocationJws,
    header: decoded.header,
    payload: validation.payload,
    signingBytes: decoded.signingInput,
    signatureBytes: decoded.signature,
  }
}

export function assertBrokerDeviceRevokeControlFrame(
  value: unknown,
): asserts value is BrokerDeviceRevokeControlFrame {
  parseBrokerDeviceRevokeControlFrame(value)
}

export async function verifyBrokerDeviceRevokeControlFrame(
  options: VerifyBrokerDeviceRevokeControlFrameOptions,
): Promise<BrokerDeviceRevokeVerificationResult> {
  assertEd25519PublicKey(options.publicKey)
  assertVerifier(options.crypto)

  let parsed: ParsedBrokerDeviceRevokeControlFrame
  try {
    parsed = parseBrokerDeviceRevokeControlFrame(options.frame)
  } catch {
    return {
      disposition: 'rejected',
      errorCode: 'MALFORMED_MESSAGE',
    }
  }

  if (!isDeviceRevokeAuthHeader(parsed.header, parsed.payload.did)) {
    return {
      disposition: 'rejected',
      errorCode: 'AUTH_INVALID',
    }
  }

  const signatureValid = await options.crypto.verifyEd25519(
    parsed.signingBytes,
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
      revocationJws: parsed.revocationJws,
    },
    header: parsed.header,
    payload: parsed.payload,
    signingBytes: parsed.signingBytes,
    signatureBytes: parsed.signatureBytes,
  }
}

function decodeDeviceRevokeJws(
  jws: string,
): DecodedJws<Record<string, unknown>, Record<string, unknown>> {
  try {
    return decodeJws<Record<string, unknown>, Record<string, unknown>>(jws)
  } catch {
    throw new Error('Invalid broker device-revoke revocationJws')
  }
}

function isDeviceRevokeAuthHeader(
  header: Record<string, unknown>,
  payloadDid: string,
): header is BrokerDeviceRevokeJwsHeader {
  if (header.alg !== 'EdDSA') return false
  if (typeof header.kid !== 'string' || header.kid.length === 0) return false
  if (!header.kid.includes('#')) return false
  return didOrKidToDid(header.kid) === payloadDid
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertTopLevelKeys(frame: Record<string, unknown>): void {
  const allowed = new Set(['type', 'revocationJws'])
  for (const key of Reflect.ownKeys(frame)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`Invalid broker device-revoke control-frame property: ${String(key)}`)
    }
  }
}

function assertRequiredOwnProperty(
  frame: Record<string, unknown>,
  key: 'type' | 'revocationJws',
): void {
  if (!Object.prototype.hasOwnProperty.call(frame, key)) {
    throw new Error(`Invalid broker device-revoke control-frame ${key}`)
  }
}

function isCompactJws(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 3 && parts.every((part) => part.length > 0)
}

function assertEd25519PublicKey(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error('Invalid broker device-revoke public key')
  }
}

function assertVerifier(value: unknown): asserts value is Pick<ProtocolCryptoAdapter, 'verifyEd25519'> {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Pick<ProtocolCryptoAdapter, 'verifyEd25519'>).verifyEd25519 !== 'function'
  ) {
    throw new Error('Invalid broker device-revoke verifier')
  }
}
