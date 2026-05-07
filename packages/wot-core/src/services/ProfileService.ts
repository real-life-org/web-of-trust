import type { PublicProfile } from '../types/identity'
import type { IdentitySession } from '../types/identity-session'
import { extractJwsPayload, verifyJws } from '../crypto/jws'
import { didToPublicKeyBytes } from '../crypto/did'
import { toBuffer } from '../crypto/encoding'
import { resolveDidKey, x25519PublicKeyToMultibase, type DidDocument } from '../protocol'

export interface ProfileServiceDocument {
  did: string
  version: number
  didDocument: DidDocument
  profile: {
    name: string
    bio?: string
    avatar?: string
    offers?: string[]
    needs?: string[]
    protocols?: string[]
  }
  updatedAt: string
}

export interface ProfileVerificationResult {
  valid: boolean
  profile?: PublicProfile
  didDocument?: DidDocument
  version?: number
  error?: string
}

export class ProfileService {
  static async createProfileDocument(
    profile: PublicProfile,
    identity: IdentitySession,
    version = Date.now(),
  ): Promise<ProfileServiceDocument> {
    if (profile.did !== identity.getDid()) throw new Error('Profile DID does not match identity')

    const encryptionPublicKey = await identity.getEncryptionPublicKeyBytes()
    const didDocument = resolveDidKey(profile.did, {
      keyAgreement: [
        {
          id: '#enc-0',
          type: 'X25519KeyAgreementKey2020',
          controller: profile.did,
          publicKeyMultibase: x25519PublicKeyToMultibase(encryptionPublicKey),
        },
      ],
    })

    return {
      did: profile.did,
      version,
      didDocument,
      profile: compactProfileMetadata(profile),
      updatedAt: profile.updatedAt,
    }
  }

  /**
   * Sign a public profile as JWS using the identity's private key
   */
  static async signProfile(
    profile: PublicProfile,
    identity: IdentitySession,
    options: { version?: number } = {},
  ): Promise<string> {
    return identity.signJws(await this.createProfileDocument(profile, identity, options.version))
  }

  static async verifySignedPayload(
    jws: string,
  ): Promise<{ valid: boolean; payload?: Record<string, unknown>; error?: string }> {
    try {
      const payload = extractJwsPayload(jws)
      if (!isRecord(payload)) return { valid: false, error: 'Invalid JWS payload' }
      if (typeof payload.did !== 'string' || !payload.did.startsWith('did:key:z')) {
        return { valid: false, error: 'Missing or invalid DID in payload' }
      }

      const publicKeyBytes = didToPublicKeyBytes(payload.did)
      const publicKey = await crypto.subtle.importKey(
        'raw',
        toBuffer(publicKeyBytes),
        { name: 'Ed25519' },
        true,
        ['verify'],
      )

      const result = await verifyJws(jws, publicKey)
      if (!result.valid) return { valid: false, error: result.error ?? 'Signature verification failed' }
      return { valid: true, payload: result.payload as Record<string, unknown> }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Verification failed' }
    }
  }

  /**
   * Verify a JWS-signed profile.
   * Extracts the DID from the payload, resolves the public key,
   * and verifies the signature.
   */
  static async verifyProfile(
    jws: string,
  ): Promise<ProfileVerificationResult> {
    try {
      // Extract payload without verifying (to get the DID)
      const payload = extractJwsPayload(jws)
      if (!payload || typeof payload !== 'object') {
        return { valid: false, error: 'Invalid JWS payload' }
      }

      const document = payload as Partial<ProfileServiceDocument>
      if (!document.did || !document.did.startsWith('did:key:z')) {
        return { valid: false, error: 'Missing or invalid DID in profile' }
      }
      if (!Number.isInteger(document.version) || document.version! < 0) {
        return { valid: false, error: 'Missing or invalid profile version' }
      }
      if (!isRecord(document.didDocument) || document.didDocument.id !== document.did) {
        return { valid: false, error: 'Missing or invalid DID document' }
      }
      if (!isRecord(document.profile) || typeof document.profile.name !== 'string' || document.profile.name.length === 0) {
        return { valid: false, error: 'Missing or invalid profile metadata' }
      }
      if ('encryptionPublicKey' in document.profile) {
        return { valid: false, error: 'Profile metadata must not contain encryptionPublicKey' }
      }
      if (typeof document.updatedAt !== 'string') {
        return { valid: false, error: 'Missing or invalid updatedAt' }
      }

      // Resolve public key from DID
      const publicKeyBytes = didToPublicKeyBytes(document.did)
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

      const verified = result.payload as ProfileServiceDocument
      return {
        valid: true,
        profile: flattenProfileDocument(verified),
        didDocument: verified.didDocument,
        version: verified.version,
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Verification failed',
      }
    }
  }
}

function compactProfileMetadata(profile: PublicProfile): ProfileServiceDocument['profile'] {
  return {
    name: profile.name,
    ...(profile.bio ? { bio: profile.bio } : {}),
    ...(profile.avatar ? { avatar: profile.avatar } : {}),
    ...(profile.offers?.length ? { offers: profile.offers } : {}),
    ...(profile.needs?.length ? { needs: profile.needs } : {}),
    ...(profile.protocols?.length ? { protocols: profile.protocols } : {}),
  }
}

function flattenProfileDocument(document: ProfileServiceDocument): PublicProfile {
  return {
    did: document.did,
    name: document.profile.name,
    ...(document.profile.bio ? { bio: document.profile.bio } : {}),
    ...(document.profile.avatar ? { avatar: document.profile.avatar } : {}),
    ...(document.profile.offers?.length ? { offers: document.profile.offers } : {}),
    ...(document.profile.needs?.length ? { needs: document.profile.needs } : {}),
    ...(document.profile.protocols?.length ? { protocols: document.profile.protocols } : {}),
    updatedAt: document.updatedAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
