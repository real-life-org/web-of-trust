/**
 * Profile JWS verification backed by the shared protocol helpers.
 */

import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

const { decodeJws, didKeyToPublicKeyBytes, verifyJwsWithPublicKey } = protocol
const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

export interface JwsVerifyResult {
  valid: boolean
  payload?: Record<string, unknown>
  error?: string
}

export async function verifyProfileJws(jws: string): Promise<JwsVerifyResult> {
  let decoded
  try {
    decoded = decodeJws(jws)
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Verification failed',
    }
  }

  const payload = decoded.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, error: 'Invalid JWS payload' }
  }
  const did = (payload as Record<string, unknown>).did
  if (typeof did !== 'string' || did.length === 0) {
    return { valid: false, error: 'Missing DID in payload' }
  }

  let publicKey: Uint8Array
  try {
    publicKey = didKeyToPublicKeyBytes(did)
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Verification failed',
    }
  }

  try {
    await verifyJwsWithPublicKey(jws, { publicKey, crypto: protocolCrypto })
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Verification failed',
    }
  }

  return { valid: true, payload: payload as Record<string, unknown> }
}

export function extractJwsPayload(jws: string): Record<string, unknown> | null {
  try {
    const decoded = decodeJws(jws)
    const payload = decoded.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    return payload as Record<string, unknown>
  } catch {
    return null
  }
}
