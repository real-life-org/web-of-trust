import type { PublicProfile } from '../types/identity'
import type { WotIdentity } from '../identity/WotIdentity'
import { extractJwsPayload, verifyJws } from '../crypto/jws'
import { didToPublicKeyBytes } from '../crypto/did'
import { toBuffer } from '../crypto/encoding'

export class ProfileService {
  /**
   * Sign a public profile as JWS using the identity's private key
   */
  static async signProfile(
    profile: PublicProfile,
    identity: WotIdentity,
  ): Promise<string> {
    return identity.signJws(profile)
  }

  /**
   * Verify a JWS-signed profile.
   * Extracts the DID from the payload, resolves the public key,
   * and verifies the signature.
   */
  static async verifyProfile(
    jws: string,
  ): Promise<{ valid: boolean; profile?: PublicProfile; error?: string }> {
    try {
      // Extract payload without verifying (to get the DID)
      const payload = extractJwsPayload(jws)
      if (!payload || typeof payload !== 'object') {
        return { valid: false, error: 'Invalid JWS payload' }
      }

      const profile = payload as PublicProfile
      if (!profile.did || !profile.did.startsWith('did:key:z')) {
        return { valid: false, error: 'Missing or invalid DID in profile' }
      }

      // Resolve public key from DID
      const publicKeyBytes = didToPublicKeyBytes(profile.did)
      const publicKey = await crypto.subtle.importKey(
        'raw',
        toBuffer(publicKeyBytes),
        { name: 'Ed25519' },
        true,
        ['verify'],
      )

      // Verify JWS signature
      const result = await verifyJws(jws, publicKey)
      if (!result.valid) {
        return { valid: false, error: result.error ?? 'Signature verification failed' }
      }

      return { valid: true, profile: result.payload as PublicProfile }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Verification failed',
      }
    }
  }
}
