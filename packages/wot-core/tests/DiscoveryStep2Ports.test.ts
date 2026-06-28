import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  LocalProfileVersionCache,
  ProfileResourceRollbackError,
} from '../src/ports/DiscoveryAdapter'
import type { ProfileVersionCache } from '../src/ports/DiscoveryAdapter'
import { detectProfileResourceRollback } from '../src/protocol/sync/profile-service-resource'
import { isVerificationAttestation, verifyAttestationVcJws } from '../src/protocol'
import type { AttestationVcPayload } from '../src/protocol'
import { VerificationWorkflow, IdentityWorkflow } from '../src/application'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { InMemoryGraphCacheStore } from '../src/adapters/discovery/InMemoryGraphCacheStore'
import type { PublicProfile } from '../src/types/identity'
import type { Attestation } from '../src/types/attestation'

const DID = 'did:key:z6MkResource'

function makeAttestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    id: 'a-1',
    from: 'did:key:z6MkIssuer',
    to: DID,
    claim: 'in-person verifiziert',
    createdAt: '2026-04-22T10:00:00.000Z',
    vcJws: 'header.payload.signature',
    ...overrides,
  }
}

const PROFILE: PublicProfile = {
  did: DID,
  name: 'Resource Owner',
  updatedAt: '2026-04-22T10:00:00.000Z',
}

// --- B) ProfileVersionCache resource-dimensional (VE-3) ---

describe('LocalProfileVersionCache — resource-dimensional (VE-3)', () => {
  // Fresh in-memory storage shim per test so keys don't bleed across cases.
  let backing: Map<string, string>
  let originalLocalStorage: PropertyDescriptor | undefined

  beforeEach(() => {
    backing = new Map<string, string>()
    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    ;(globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage
  })

  afterEach(() => {
    // Restore so the shim never leaks into other test files in this worker.
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage
    }
  })

  it('namespaces the localStorage key per resource', async () => {
    const cache: ProfileVersionCache = new LocalProfileVersionCache()
    await cache.setLastSeenVersion(DID, 'verifications', 7)
    expect(backing.get(`wot:profile-version:${DID}:verifications`)).toBe('7')
    expect(await cache.getLastSeenVersion(DID, 'verifications')).toBe(7)
    // Independent per resource.
    expect(await cache.getLastSeenVersion(DID, 'attestations')).toBeUndefined()
    expect(await cache.getLastSeenVersion(DID, 'profile')).toBeUndefined()
  })

  it('migrates the legacy single-key value into the profile resource (cache migration)', async () => {
    // Legacy May key, written before the resource dimension existed.
    backing.set(`wot:profile-version:${DID}`, '42')
    const cache = new LocalProfileVersionCache()
    expect(await cache.getLastSeenVersion(DID, 'profile')).toBe(42)
    // Other resources are not affected by the legacy key.
    expect(await cache.getLastSeenVersion(DID, 'verifications')).toBeUndefined()
  })

  it('prefers the resource-scoped key over the legacy key for profile', async () => {
    backing.set(`wot:profile-version:${DID}`, '5')
    backing.set(`wot:profile-version:${DID}:profile`, '9')
    const cache = new LocalProfileVersionCache()
    expect(await cache.getLastSeenVersion(DID, 'profile')).toBe(9)
  })
})

// --- ProfileResourceRollbackError carries the resource (VE-3) ---

describe('ProfileResourceRollbackError — resource field (VE-3)', () => {
  it('exposes the resource that rolled back', () => {
    const err = new ProfileResourceRollbackError(DID, 6, 7, 'verifications')
    expect(err.resource).toBe('verifications')
    expect(err.did).toBe(DID)
    expect(err.fetchedVersion).toBe(6)
    expect(err.lastSeenVersion).toBe(7)
  })
})

describe('detectProfileResourceRollback — resource threading (VE-3)', () => {
  it('still detects a rollback independent of the resource label', () => {
    expect(
      detectProfileResourceRollback({ fetchedVersion: 6, lastSeenVersion: 7, resource: 'attestations' }),
    ).toBe(true)
    expect(
      detectProfileResourceRollback({ fetchedVersion: 8, lastSeenVersion: 7, resource: 'attestations' }),
    ).toBe(false)
  })
})

// --- C) GraphCacheStore signature widened to carry verifications (VE-2) ---

describe('InMemoryGraphCacheStore — verifications dimension (VE-2)', () => {
  let store: InMemoryGraphCacheStore

  beforeEach(() => {
    store = new InMemoryGraphCacheStore()
  })

  it('accepts and returns verifications alongside attestations (Attestation[] derived form)', async () => {
    const attestations = [makeAttestation({ id: 'a-att', claim: 'half im Garten' })]
    const verifications = [makeAttestation({ id: 'a-ver' })]

    await store.cacheEntry(DID, { profile: PROFILE, attestations, verifications })

    expect(await store.getCachedAttestations(DID)).toHaveLength(1)
    const cachedVer = await store.getCachedVerifications(DID)
    expect(cachedVer).toHaveLength(1)
    expect(cachedVer[0].id).toBe('a-ver')
    const entry = await store.getEntry(DID)
    expect(entry!.verificationCount).toBe(1)
    expect(entry!.attestationCount).toBe(1)
  })

  it('returns empty verifications for an uncached DID', async () => {
    expect(await store.getCachedVerifications('did:key:unknown')).toEqual([])
  })
})

// --- D) Central type-based verification marker (VE-7) ---

describe('isVerificationAttestation — central type-based predicate (VE-7)', () => {
  function makePayload(type: string[]): AttestationVcPayload {
    return {
      '@context': ['https://www.w3.org/ns/credentials/v2', 'https://web-of-trust.de/vocab/v1'],
      type,
      issuer: 'did:key:z6MkIssuer',
      credentialSubject: { id: DID, claim: 'in-person verifiziert' },
      validFrom: '2026-04-22T10:00:00.000Z',
      iss: 'did:key:z6MkIssuer',
      sub: DID,
      nbf: 1,
    }
  }

  it('matches when type contains WotVerification', () => {
    expect(isVerificationAttestation(makePayload(['VerifiableCredential', 'WotAttestation', 'WotVerification']))).toBe(true)
  })

  it('does not match a plain attestation without the marker', () => {
    expect(isVerificationAttestation(makePayload(['VerifiableCredential', 'WotAttestation']))).toBe(false)
  })

  it('does not depend on the human-readable claim label', () => {
    const payload = makePayload(['VerifiableCredential', 'WotAttestation', 'WotVerification'])
    payload.credentialSubject.claim = 'irgendein label'
    expect(isVerificationAttestation(payload)).toBe(true)
  })
})

describe('VerificationWorkflow — writes WotVerification marker into type (VE-7)', () => {
  const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

  async function createTestIdentity(passphrase: string) {
    const workflow = new IdentityWorkflow({ crypto: cryptoAdapter })
    return (await workflow.createIdentity({ passphrase, storeSeed: false })).identity
  }

  it('produced verification-attestation payload satisfies the central predicate', async () => {
    const anna = await createTestIdentity('anna-step2')
    const ben = await createTestIdentity('ben-step2')
    const nonce = '550e8400-e29b-41d4-a716-446655440000'
    const now = new Date('2026-04-28T08:00:00Z')
    const annaWorkflow = new VerificationWorkflow({ crypto: cryptoAdapter, randomId: () => nonce, now: () => now })
    const benWorkflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => '123e4567-e89b-42d3-a456-426614174000',
      now: () => new Date('2026-04-28T08:01:00.789Z'),
    })

    await annaWorkflow.createOnlineQrChallenge(anna, 'Anna')
    const verification = await benWorkflow.createVerificationAttestation({
      issuer: ben,
      subjectDid: anna.getDid(),
      challengeNonce: nonce,
    })

    const payload = await verifyAttestationVcJws(verification.vcJws, {
      crypto: cryptoAdapter,
      now: new Date('2026-04-28T08:01:01Z'),
    })

    expect(payload.type).toContain('WotVerification')
    expect(isVerificationAttestation(payload)).toBe(true)
  })
})
