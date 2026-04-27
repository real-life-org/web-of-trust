import type { SpecCryptoAdapter } from '../crypto/ports'
import type { JsonValue } from '../crypto/jcs'
import { createJcsEd25519Jws, decodeJws, verifyJwsWithPublicKey } from '../crypto/jws'
import { didKeyToPublicKeyBytes } from '../identity/did-key'

export interface LogEntryPayload {
  seq: number
  deviceId: string
  docId: string
  authorKid: string
  keyGeneration: number
  data: string
  timestamp: string
}

export interface CreateLogEntryJwsOptions {
  payload: LogEntryPayload
  signingSeed: Uint8Array
}

export interface VerifyLogEntryJwsOptions {
  crypto: SpecCryptoAdapter
}

export async function createLogEntryJws(options: CreateLogEntryJwsOptions): Promise<string> {
  return createJcsEd25519Jws(
    { alg: 'EdDSA', kid: options.payload.authorKid },
    options.payload as unknown as JsonValue,
    options.signingSeed,
  )
}

export async function verifyLogEntryJws(jws: string, options: VerifyLogEntryJwsOptions): Promise<LogEntryPayload> {
  const { header, payload } = decodeJws<{ alg?: string; kid?: string }, LogEntryPayload>(jws)
  if (header.alg !== 'EdDSA') throw new Error('Invalid log entry alg')
  if (!header.kid) throw new Error('Missing log entry kid')
  if (payload.authorKid !== header.kid) throw new Error('Log entry authorKid mismatch')

  await verifyJwsWithPublicKey(jws, {
    publicKey: didKeyToPublicKeyBytes(payload.authorKid),
    crypto: options.crypto,
  })
  assertLogEntryPayload(payload)
  return payload
}

function assertLogEntryPayload(payload: LogEntryPayload): void {
  if (!Number.isInteger(payload.seq) || payload.seq < 0) throw new Error('Invalid log entry seq')
  if (!payload.deviceId) throw new Error('Missing log entry deviceId')
  if (!payload.docId) throw new Error('Missing log entry docId')
  if (!payload.authorKid) throw new Error('Missing log entry authorKid')
  if (!Number.isInteger(payload.keyGeneration) || payload.keyGeneration < 0) {
    throw new Error('Invalid log entry keyGeneration')
  }
  if (!payload.data) throw new Error('Missing log entry data')
  if (Number.isNaN(Date.parse(payload.timestamp))) throw new Error('Invalid log entry timestamp')
}
