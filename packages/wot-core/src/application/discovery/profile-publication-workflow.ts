import type { PublicProfile } from '../../types/identity'
import type { IdentitySession } from '../../types/identity-session'
import { buildProfilePublicationPayload, type BuildProfilePayloadOptions } from '../identity/profile-document'

export interface ProfilePublicationWorkflow {
  signProfile(profile: PublicProfile, identity: IdentitySession, options?: BuildProfilePayloadOptions): Promise<string>
}

export function createProfilePublicationWorkflow(): ProfilePublicationWorkflow {
  return {
    async signProfile(profile, identity, options = {}) {
      const payload = await buildProfilePublicationPayload(profile, identity, options)
      return identity.signJws(payload)
    },
  }
}
