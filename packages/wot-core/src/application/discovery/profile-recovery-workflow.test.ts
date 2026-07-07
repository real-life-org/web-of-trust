import { describe, it, expect } from 'vitest'
import { createProfileRecoveryWorkflow } from './profile-recovery-workflow'
import { ProfileResourceRollbackError } from '../../ports/DiscoveryAdapter'
import type { ProfileResolveResult, ProfileVersionCache } from '../../ports/DiscoveryAdapter'
import type { Attestation } from '../../types/attestation'
import type { PublicProfile } from '../../types/identity'
import type { DidDocument, ProfileServiceResourceKind } from '../../protocol'
import {
  classifyProfileRecoveryArtifact,
} from '../../protocol'

const DID = 'did:key:zRecoveryTestSubject'

function makeAttestation(id: string, to: string, claim: string): Attestation {
  return {
    id,
    from: 'did:key:zIssuer',
    to,
    claim,
    createdAt: '2026-06-14T00:00:00.000Z',
    vcJws: `header.${id}.sig`,
  }
}

const PROFILE: PublicProfile = { did: DID, name: 'Recovered Name', bio: 'hi', updatedAt: '2026-06-14T00:00:00.000Z' }

const DID_DOCUMENT: DidDocument = {
  '@context': ['https://www.w3.org/ns/did/v1'],
  id: DID,
  verificationMethod: [],
  authentication: [],
  assertionMethod: [],
  keyAgreement: [{ id: `${DID}#ka`, type: 'X25519KeyAgreementKey2020', controller: DID, publicKeyMultibase: 'zKA' }],
  service: [{ id: `${DID}#relay`, type: 'Relay', serviceEndpoint: 'wss://relay.example' }],
} as unknown as DidDocument

class InMemoryVersionCache implements ProfileVersionCache {
  private store = new Map<string, number>()
  async getLastSeenVersion(did: string, resource: ProfileServiceResourceKind): Promise<number | undefined> {
    return this.store.get(`${did}:${resource}`)
  }
  async setLastSeenVersion(did: string, resource: ProfileServiceResourceKind, version: number): Promise<void> {
    this.store.set(`${did}:${resource}`, version)
  }
}

/**
 * Fake discovery adapter that mirrors how the real HttpDiscoveryAdapter writes
 * the version cache on a successful resolve. Lets us assert the workflow reads
 * the version from the cache the resolve path just wrote (Z.220 — no extra
 * fetch).
 */
function makeDiscovery(opts: {
  cache: ProfileVersionCache
  profile?: { result: ProfileResolveResult; version?: number }
  verifications?: { items: Attestation[]; version: number }
  attestations?: { items: Attestation[]; version: number }
  resolveProfileThrows?: Error
  resolveVerificationsThrows?: Error
  resolveAttestationsThrows?: Error
}) {
  return {
    async resolveProfile(did: string): Promise<ProfileResolveResult> {
      if (opts.resolveProfileThrows) throw opts.resolveProfileThrows
      const r = opts.profile?.result ?? { profile: null, fromCache: false }
      if (r.profile !== null && opts.profile?.version !== undefined) {
        await opts.cache.setLastSeenVersion(did, 'profile', opts.profile.version)
      }
      return r
    },
    async resolveVerifications(did: string): Promise<Attestation[]> {
      if (opts.resolveVerificationsThrows) throw opts.resolveVerificationsThrows
      if (opts.verifications) {
        await opts.cache.setLastSeenVersion(did, 'verifications', opts.verifications.version)
        return opts.verifications.items
      }
      return []
    },
    async resolveAttestations(did: string): Promise<Attestation[]> {
      if (opts.resolveAttestationsThrows) throw opts.resolveAttestationsThrows
      if (opts.attestations) {
        await opts.cache.setLastSeenVersion(did, 'attestations', opts.attestations.version)
        return opts.attestations.items
      }
      return []
    },
  }
}

describe('createProfileRecoveryWorkflow (Sync 004 Z.207-220)', () => {
  it('happy path: reconstructs all three resources with their versions', async () => {
    const cache = new InMemoryVersionCache()
    const verifications = [makeAttestation('v1', DID, 'in-person verifiziert')]
    const attestations = [makeAttestation('a1', DID, 'helped in the garden')]
    const discovery = makeDiscovery({
      cache,
      profile: { result: { profile: PROFILE, didDocument: DID_DOCUMENT, version: 5, fromCache: false }, version: 5 },
      verifications: { items: verifications, version: 7 },
      attestations: { items: attestations, version: 3 },
    })

    const workflow = createProfileRecoveryWorkflow({ discovery, versionCache: cache })
    const result = await workflow.recoverPublicState(DID)

    expect(result.did).toBe(DID)
    expect(result.profile?.value).toEqual(PROFILE)
    expect(result.profile?.version).toBe(5)
    expect(result.profile?.source).toBe('profile-service-fallback')
    expect(result.didDocument?.value).toEqual(DID_DOCUMENT)
    expect(result.didDocument?.version).toBe(5)
    expect(result.verifications.value).toEqual(verifications)
    expect(result.verifications.version).toBe(7)
    expect(result.attestations.value).toEqual(attestations)
    expect(result.attestations.version).toBe(3)
    // keyAgreement + service recorded as allowed recovered artifacts (Z.215/216)
    expect(result.recoveredArtifacts).toContain('did-document-keyAgreement')
    expect(result.recoveredArtifacts).toContain('did-document-service')
  })

  it('result carries re-import-able data (accepted:true import is Step-6 consumer)', async () => {
    // The workflow returns the derived Attestation[] form verbatim so the
    // consumer can re-import them with accepted:true. Assert the carried items
    // are the full attestation objects (id + vcJws present), not a lossy view.
    const cache = new InMemoryVersionCache()
    const verifications = [makeAttestation('v1', DID, 'in-person verifiziert')]
    const attestations = [makeAttestation('a1', DID, 'helped')]
    const discovery = makeDiscovery({
      cache,
      profile: { result: { profile: PROFILE, version: 1, fromCache: false }, version: 1 },
      verifications: { items: verifications, version: 1 },
      attestations: { items: attestations, version: 1 },
    })
    const workflow = createProfileRecoveryWorkflow({ discovery, versionCache: cache })
    const result = await workflow.recoverPublicState(DID)

    for (const att of [...result.verifications.value, ...result.attestations.value]) {
      expect(att.id).toBeTruthy()
      expect(att.vcJws).toBeTruthy()
      expect(att.to).toBe(DID)
    }
  })

  it('rollback during recovery propagates as error (Z.220, not swallowed)', async () => {
    const cache = new InMemoryVersionCache()
    const rollback = new ProfileResourceRollbackError(DID, 6, 7, 'verifications')
    const discovery = makeDiscovery({
      cache,
      profile: { result: { profile: PROFILE, version: 5, fromCache: false }, version: 5 },
      resolveVerificationsThrows: rollback,
    })
    const workflow = createProfileRecoveryWorkflow({ discovery, versionCache: cache })

    await expect(workflow.recoverPublicState(DID)).rejects.toBeInstanceOf(ProfileResourceRollbackError)
    await expect(workflow.recoverPublicState(DID)).rejects.toMatchObject({ resource: 'verifications' })
  })

  it('rollback on profile resolve also propagates', async () => {
    const cache = new InMemoryVersionCache()
    const discovery = makeDiscovery({
      cache,
      resolveProfileThrows: new ProfileResourceRollbackError(DID, 4, 9, 'profile'),
    })
    const workflow = createProfileRecoveryWorkflow({ discovery, versionCache: cache })
    await expect(workflow.recoverPublicState(DID)).rejects.toBeInstanceOf(ProfileResourceRollbackError)
  })

  it('404 profile → empty result without error', async () => {
    const cache = new InMemoryVersionCache()
    // resolveProfile returns { profile: null } (HttpDiscoveryAdapter 404 shape).
    const discovery = makeDiscovery({ cache })
    const workflow = createProfileRecoveryWorkflow({ discovery, versionCache: cache })

    const result = await workflow.recoverPublicState(DID)
    expect(result.profile).toBeNull()
    expect(result.didDocument).toBeNull()
    expect(result.verifications.value).toEqual([])
    expect(result.attestations.value).toEqual([])
    // No profile/didDocument artifacts recovered, but /v + /a were attempted.
    expect(result.recoveredArtifacts).not.toContain('public-profile-data')
    expect(result.recoveredArtifacts).not.toContain('did-document')
  })

  it('forbidden artifacts are structurally unreachable (negative test)', async () => {
    // 1) The workflow result type only carries allowed artifact kinds — there is
    //    no field for private wallet state, contacts, space keys, vault secrets.
    //    Enforced structurally: the classify guard only passes `allowed`.
    const cache = new InMemoryVersionCache()
    const discovery = makeDiscovery({
      cache,
      profile: { result: { profile: PROFILE, didDocument: DID_DOCUMENT, version: 2, fromCache: false }, version: 2 },
      verifications: { items: [], version: 1 },
      attestations: { items: [], version: 1 },
    })
    const workflow = createProfileRecoveryWorkflow({ discovery, versionCache: cache })
    const result = await workflow.recoverPublicState(DID)

    // Every recovered artifact name MUST classify as `allowed` (Z.211-218).
    for (const artifact of result.recoveredArtifacts) {
      expect(classifyProfileRecoveryArtifact(artifact).disposition).toBe('allowed')
    }

    // 2) The forbidden artifact names from the Z.218 catalogue never appear in
    //    the recovered set — the workflow has no path to produce them.
    const forbidden = [
      'private-wallet-state',
      'unpublished-received-attestations',
      'private-contacts-not-public-profile-derived',
      'space-content-keys',
      'space-membership-secrets',
      'personal-doc-only-state',
      'vault-secrets',
      'private-sync-state',
    ]
    for (const f of forbidden) {
      expect(result.recoveredArtifacts).not.toContain(f)
      expect(classifyProfileRecoveryArtifact(f).disposition).toBe('forbidden')
    }
  })

  it('structurally never reaches private state: only the resolve surface is used', async () => {
    // Structural guard (Z.218): the workflow depends ONLY on the read-only
    // resolve surface. We hand it an object that ALSO carries private-state
    // mutators (saveAttestation/addContact/setAttestationAccepted/markDirty) as
    // spies. If the workflow had any path into private state it would invoke one
    // of them; since it has none, they stay untouched.
    const cache = new InMemoryVersionCache()
    const verifications = [makeAttestation('v1', DID, 'in-person verifiziert')]
    const attestations = [makeAttestation('a1', DID, 'helped')]
    const base = makeDiscovery({
      cache,
      profile: { result: { profile: PROFILE, didDocument: DID_DOCUMENT, version: 2, fromCache: false }, version: 2 },
      verifications: { items: verifications, version: 1 },
      attestations: { items: attestations, version: 1 },
    })
    const privateStateCalls: string[] = []
    const trap = new Proxy(base as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        // Any other property access (e.g. a private-state mutator) is recorded.
        return (...args: unknown[]) => {
          privateStateCalls.push(`${prop}(${args.length})`)
        }
      },
    }) as unknown as Parameters<typeof createProfileRecoveryWorkflow>[0]['discovery']

    const workflow = createProfileRecoveryWorkflow({ discovery: trap, versionCache: cache })
    const result = await workflow.recoverPublicState(DID)

    // The workflow reconstructed public data...
    expect(result.profile?.value).toEqual(PROFILE)
    expect(result.verifications.value).toEqual(verifications)
    // ...without ever touching any non-resolve (private-state) method.
    expect(privateStateCalls).toEqual([])
  })
})
