import { decodeBase64Url, toBuffer } from './encoding'

/**
 * JWS (JSON Web Signature) verification utilities.
 * Used by ProfileService and capability verification over exact received
 * compact-JWS bytes. The protocol JCS/EdDSA helpers in
 * packages/wot-core/src/protocol/crypto/jws.ts are the signing authority.
 */

interface JwsHeader {
  alg: 'EdDSA'
  typ?: 'JWT'
}

/**
 * Verify a JWS signature
 *
 * @param jws - JWS compact serialization string
 * @param publicKey - CryptoKey for verification (Ed25519)
 * @returns Object with verification result and decoded payload
 */
export async function verifyJws(
  jws: string,
  publicKey: CryptoKey
): Promise<{ valid: boolean; payload?: unknown; error?: string }> {
  try {
    // 1. Split JWS into parts
    const parts = jws.split('.')
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid JWS format' }
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts

    // 2. Decode header
    const headerBytes = decodeBase64Url(encodedHeader)
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as JwsHeader

    // 3. Verify algorithm
    if (header.alg !== 'EdDSA') {
      return { valid: false, error: `Unsupported algorithm: ${header.alg}` }
    }

    // 4. Decode payload
    const payloadBytes = decodeBase64Url(encodedPayload)
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes))

    // 5. Decode signature
    const signature = decodeBase64Url(encodedSignature)

    // 6. Create signing input for verification
    const signingInput = `${encodedHeader}.${encodedPayload}`
    const signingInputBytes = new TextEncoder().encode(signingInput)

    // 7. Verify signature
    const valid = await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      toBuffer(signature),
      signingInputBytes
    )

    return { valid, payload }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Verification failed',
    }
  }
}

/**
 * Extract payload from JWS without verifying signature
 * Useful for debugging or when signature verification happens separately
 */
export function extractJwsPayload(jws: string): unknown | null {
  try {
    const parts = jws.split('.')
    if (parts.length !== 3) return null

    const payloadBytes = decodeBase64Url(parts[1])
    return JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return null
  }
}
