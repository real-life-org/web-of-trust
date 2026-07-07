import { describe, expect, it } from 'vitest'
import { createProfilePublicationWorkflow } from '../src/application/discovery'
import { createDidKeyResolver, verifyProfileServiceResourceJws } from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { createTestIdentity } from './helpers/identity-session'
import type { PublicProfile } from '../src/types/identity'

describe('profile-publication-workflow', () => {
  it('signProfile returns a compact JWS (3 segments)', async () => {
    const { identity } = await createTestIdentity('pub-workflow-sign')
    const workflow = createProfilePublicationWorkflow()
    const profile: PublicProfile = { did: identity.getDid(), name: 'Alice', updatedAt: '2026-05-18T10:43:25.976Z' }
    const jws = await workflow.signProfile(profile, identity)
    expect(typeof jws).toBe('string')
    expect(jws.split('.')).toHaveLength(3)
  })

  it('signProfile output verifies through verifyProfileServiceResourceJws (round-trip)', async () => {
    const { identity } = await createTestIdentity('pub-workflow-roundtrip')
    const workflow = createProfilePublicationWorkflow()
    const profile: PublicProfile = {
      did: identity.getDid(),
      name: 'Alice Müller',
      bio: 'Gärtnerin',
      updatedAt: '2026-05-18T10:43:25.976Z',
    }
    const jws = await workflow.signProfile(profile, identity, { version: 1 })
    const payload = await verifyProfileServiceResourceJws(jws, {
      expectedDid: identity.getDid(),
      resourceKind: 'profile',
      didResolver: createDidKeyResolver(),
      crypto: new WebCryptoProtocolCryptoAdapter(),
    })
    expect(payload.did).toBe(identity.getDid())
    expect(payload.version).toBe(1)
    expect(payload.profile.name).toBe('Alice Müller')
  })
})
