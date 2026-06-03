import { decodeBase64Url, encodeBase64Url } from '../crypto/encoding'
import { canonicalizeToBytes } from '../crypto/jcs'
import type { JsonValue } from '../crypto/jcs'
import type { ProtocolCryptoAdapter } from '../crypto/ports'

export const P2P_AUTH_TRANSCRIPT_PROTOCOL = 'wot/p2p-auth/v1'
export type P2pAuthTranscriptRole = 'initiator' | 'responder'

export interface P2pAuthTranscriptInput {
  initiatorDid: string
  initiatorDeviceId: string
  initiatorNonce: string
  responderDid: string
  responderDeviceId: string
  responderNonce: string
}

export interface P2pAuthTranscript {
  protocol: typeof P2P_AUTH_TRANSCRIPT_PROTOCOL
  initiatorDid: string
  initiatorDeviceId: string
  initiatorNonce: string
  responderDid: string
  responderDeviceId: string
  responderNonce: string
}

export interface VerifyP2pAuthSignatureOptions {
  transcript: P2pAuthTranscript
  role: P2pAuthTranscriptRole
  signature: Uint8Array
  publicKey: Uint8Array
  crypto: Pick<ProtocolCryptoAdapter, 'verifyEd25519'>
}

export function buildP2pAuthTranscript(input: P2pAuthTranscriptInput): P2pAuthTranscript {
  return p2pAuthTranscriptFromCanonical(canonicalP2pAuthTranscriptInput(input))
}

export function createP2pAuthTranscriptBytes(transcript: P2pAuthTranscript): Uint8Array {
  assertP2pAuthTranscriptProtocol(transcript)
  const canonicalTranscript = p2pAuthTranscriptFromCanonical(
    canonicalP2pAuthTranscriptInput(transcript),
  )
  return canonicalizeToBytes(canonicalTranscript as unknown as JsonValue)
}

export function createP2pAuthTranscriptSigningBytes(
  transcript: P2pAuthTranscript,
  role: P2pAuthTranscriptRole,
): Uint8Array {
  const rolePrefix = new TextEncoder().encode(`role:${canonicalP2pAuthTranscriptRole(role)}\n`)
  const transcriptBytes = createP2pAuthTranscriptBytes(transcript)
  const signingBytes = new Uint8Array(rolePrefix.byteLength + transcriptBytes.byteLength)
  signingBytes.set(rolePrefix)
  signingBytes.set(transcriptBytes, rolePrefix.byteLength)
  return signingBytes
}

export async function verifyP2pAuthTranscriptSignature(
  options: VerifyP2pAuthSignatureOptions,
): Promise<boolean> {
  assertEd25519Bytes(options.signature, 64, 'Invalid p2p auth signature')
  assertEd25519Bytes(options.publicKey, 32, 'Invalid p2p auth public key')
  assertP2pAuthVerifier(options.crypto)

  return options.crypto.verifyEd25519(
    createP2pAuthTranscriptSigningBytes(options.transcript, options.role),
    options.signature,
    options.publicKey,
  )
}

function canonicalP2pAuthTranscriptInput(input: P2pAuthTranscriptInput): P2pAuthTranscriptInput {
  return {
    initiatorDid: canonicalDid(input.initiatorDid, 'initiatorDid'),
    initiatorDeviceId: canonicalDeviceId(input.initiatorDeviceId, 'initiatorDeviceId'),
    initiatorNonce: canonicalNonce(input.initiatorNonce, 'initiatorNonce'),
    responderDid: canonicalDid(input.responderDid, 'responderDid'),
    responderDeviceId: canonicalDeviceId(input.responderDeviceId, 'responderDeviceId'),
    responderNonce: canonicalNonce(input.responderNonce, 'responderNonce'),
  }
}

function p2pAuthTranscriptFromCanonical(input: P2pAuthTranscriptInput): P2pAuthTranscript {
  return {
    protocol: P2P_AUTH_TRANSCRIPT_PROTOCOL,
    initiatorDid: input.initiatorDid,
    initiatorDeviceId: input.initiatorDeviceId,
    initiatorNonce: input.initiatorNonce,
    responderDid: input.responderDid,
    responderDeviceId: input.responderDeviceId,
    responderNonce: input.responderNonce,
  }
}

function canonicalDid(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid p2p auth ${fieldName}`)
  return value
}

function canonicalDeviceId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !isCanonicalLowercaseUuidV4(value)) {
    throw new Error(`Invalid p2p auth ${fieldName}`)
  }
  return value
}

function canonicalNonce(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid p2p auth ${fieldName}`)
  }

  let bytes: Uint8Array
  try {
    bytes = decodeBase64Url(value)
  } catch {
    throw new Error(`Invalid p2p auth ${fieldName}`)
  }

  if (bytes.byteLength < 32) throw new Error(`Invalid p2p auth ${fieldName} length`)
  if (encodeBase64Url(bytes) !== value) throw new Error(`Invalid p2p auth ${fieldName} canonical form`)
  return value
}

function canonicalP2pAuthTranscriptRole(role: unknown): P2pAuthTranscriptRole {
  if (role !== 'initiator' && role !== 'responder') throw new Error('Invalid p2p auth role')
  return role
}

function assertP2pAuthTranscriptProtocol(transcript: P2pAuthTranscript): void {
  if (transcript.protocol !== P2P_AUTH_TRANSCRIPT_PROTOCOL) throw new Error('Invalid p2p auth transcript')
}

function assertEd25519Bytes(value: unknown, byteLength: number, message: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== byteLength) {
    throw new Error(message)
  }
}

function assertP2pAuthVerifier(value: unknown): asserts value is Pick<ProtocolCryptoAdapter, 'verifyEd25519'> {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Pick<ProtocolCryptoAdapter, 'verifyEd25519'>).verifyEd25519 !== 'function'
  ) {
    throw new Error('Invalid p2p auth verifier')
  }
}

function isCanonicalLowercaseUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}
