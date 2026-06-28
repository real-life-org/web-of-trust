import type { PublicProfile } from '../../types/identity'
import type { IdentitySession } from '../../types/identity-session'
import { resolveDidKey, x25519PublicKeyToMultibase } from '../../protocol/identity/did-key'
import type { ProfileServiceResourcePayload } from '../../protocol/sync/profile-service-resource'

export interface BuildProfilePayloadOptions {
  version?: number
}

// Sync 004 Z.153: didDocument is the canonical key source; the profile metadata
// object must not carry redundant cryptographic keys (no encryptionPublicKey).
export async function buildProfilePublicationPayload(
  profile: PublicProfile,
  identity: IdentitySession,
  options: BuildProfilePayloadOptions = {},
): Promise<ProfileServiceResourcePayload> {
  if (profile.did !== identity.getDid()) {
    throw new Error('Profile DID does not match identity')
  }
  const encryptionPublicKey = await identity.getEncryptionPublicKeyBytes()
  const didDocument = resolveDidKey(profile.did, {
    keyAgreement: [{
      id: '#enc-0',
      type: 'X25519KeyAgreementKey2020',
      controller: profile.did,
      publicKeyMultibase: x25519PublicKeyToMultibase(encryptionPublicKey),
    }],
  })
  return {
    did: profile.did,
    version: options.version ?? Date.now(),
    didDocument,
    profile: compactProfileMetadata(profile),
    updatedAt: profile.updatedAt,
  }
}

export function flattenProfilePublicationPayload(payload: ProfileServiceResourcePayload): PublicProfile {
  return {
    did: payload.did,
    name: payload.profile.name,
    ...(payload.profile.bio ? { bio: payload.profile.bio as string } : {}),
    ...(payload.profile.avatar ? { avatar: payload.profile.avatar as string } : {}),
    ...(Array.isArray(payload.profile.offers) && payload.profile.offers.length
      ? { offers: payload.profile.offers as string[] } : {}),
    ...(Array.isArray(payload.profile.needs) && payload.profile.needs.length
      ? { needs: payload.profile.needs as string[] } : {}),
    ...(Array.isArray(payload.profile.protocols) && payload.profile.protocols.length
      ? { protocols: payload.profile.protocols as string[] } : {}),
    updatedAt: payload.updatedAt,
  }
}

function compactProfileMetadata(profile: PublicProfile): ProfileServiceResourcePayload['profile'] {
  return {
    name: profile.name,
    ...(profile.bio ? { bio: profile.bio } : {}),
    ...(profile.avatar ? { avatar: profile.avatar } : {}),
    ...(profile.offers?.length ? { offers: profile.offers } : {}),
    ...(profile.needs?.length ? { needs: profile.needs } : {}),
    ...(profile.protocols?.length ? { protocols: profile.protocols } : {}),
  }
}
