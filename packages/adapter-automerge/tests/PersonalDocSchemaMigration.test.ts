import { describe, it, expect } from 'vitest'
import * as Automerge from '@automerge/automerge'
import { Repo } from '@automerge/automerge-repo'
import { sanitizeLegacyPersonalDoc, sanitizePersonalDocHandle } from '../src/PersonalDocManager'
import type { PersonalDoc } from '../src/PersonalDocManager'

/**
 * Legacy PersonalDoc snapshots may contain a top-level `publishState` field
 * (and other deprecated fields) from earlier versions. Demo publish-state
 * persistence is now owned by LocalCacheStore — PersonalDoc must not
 * re-introduce that schema on load/migration.
 */
describe('sanitizeLegacyPersonalDoc', () => {
  it('strips top-level publishState from legacy data', () => {
    const legacy = {
      profile: null,
      contacts: {},
      verifications: {},
      attestations: {},
      attestationMetadata: {},
      outbox: {},
      spaces: {},
      groupKeys: {},
      publishState: {
        profileDirty: true,
        verificationsDirty: true,
        attestationsDirty: true,
      },
    }

    const sanitized = sanitizeLegacyPersonalDoc(legacy)

    expect('publishState' in sanitized).toBe(false)
    expect((sanitized as Record<string, unknown>).publishState).toBeUndefined()
  })

  it('preserves current PersonalDoc fields', () => {
    const input: PersonalDoc & { publishState?: unknown } = {
      profile: {
        did: 'did:key:alice',
        name: 'Alice',
        bio: null,
        avatar: null,
        offersJson: null,
        needsJson: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
      contacts: {
        'did:key:bob': {
          did: 'did:key:bob',
          publicKey: 'pk',
          name: 'Bob',
          avatar: null,
          bio: null,
          status: 'active',
          verifiedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      verifications: {
        v1: {
          id: 'v1',
          fromDid: 'did:key:alice',
          toDid: 'did:key:bob',
          timestamp: '2026-01-01T00:00:00Z',
          proofJson: '{}',
          locationJson: null,
        },
      },
      attestations: {},
      attestationMetadata: {},
      outbox: {},
      spaces: {},
      groupKeys: {},
      publishState: { profileDirty: true },
    }

    const sanitized = sanitizeLegacyPersonalDoc(input)

    expect(sanitized.profile?.name).toBe('Alice')
    expect(sanitized.contacts['did:key:bob']?.name).toBe('Bob')
    expect(sanitized.verifications.v1?.id).toBe('v1')
    expect(sanitized.attestations).toEqual({})
    expect(sanitized.attestationMetadata).toEqual({})
    expect(sanitized.outbox).toEqual({})
    expect(sanitized.spaces).toEqual({})
    expect(sanitized.groupKeys).toEqual({})
    expect('publishState' in sanitized).toBe(false)
  })

  it('returns a doc safe to Object.assign into a current PersonalDoc', () => {
    const legacy = {
      profile: null,
      contacts: {},
      verifications: {},
      attestations: {},
      attestationMetadata: {},
      outbox: {},
      spaces: {},
      groupKeys: {},
      publishState: { profileDirty: true, verificationsDirty: true, attestationsDirty: false },
    }

    const sanitized = sanitizeLegacyPersonalDoc(legacy)

    const target: PersonalDoc = {
      profile: null,
      contacts: {},
      verifications: {},
      attestations: {},
      attestationMetadata: {},
      outbox: {},
      spaces: {},
      groupKeys: {},
    }
    Object.assign(target, sanitized)

    expect('publishState' in target).toBe(false)
  })

  it('sanitizes a saved Automerge snapshot that has top-level publishState', () => {
    const legacyDoc = Automerge.from<Record<string, unknown>>({
      profile: null,
      contacts: {},
      verifications: {},
      attestations: {},
      attestationMetadata: {},
      outbox: {},
      spaces: {},
      groupKeys: {},
      publishState: {
        profileDirty: true,
        verificationsDirty: true,
        attestationsDirty: false,
      },
    })
    const snapshot = Automerge.save(legacyDoc)

    const reloaded = Automerge.load<Record<string, unknown>>(snapshot)
    expect('publishState' in reloaded).toBe(true)

    const sanitized = sanitizeLegacyPersonalDoc(reloaded as Partial<PersonalDoc> & Record<string, unknown>)
    expect('publishState' in sanitized).toBe(false)
    expect(sanitized.profile).toBeNull()
    expect(sanitized.contacts).toEqual({})
    expect(sanitized.spaces).toEqual({})
  })

  it('strips top-level publishState before re-saving a loaded Automerge handle', () => {
    const legacyDoc = Automerge.from<Record<string, unknown>>({
      profile: null,
      contacts: {},
      verifications: {},
      attestations: {},
      attestationMetadata: {},
      outbox: {},
      spaces: {},
      groupKeys: {},
      publishState: {
        profileDirty: true,
        verificationsDirty: true,
        attestationsDirty: false,
      },
    })
    const snapshot = Automerge.save(legacyDoc)
    const repo = new Repo({ peerId: 'personal-doc-schema-test' as any, network: [], sharePolicy: async () => true })

    try {
      const handle = repo.import<PersonalDoc>(snapshot)
      if (!handle.isReady()) handle.doneLoading()
      expect('publishState' in (handle.doc() as unknown as Record<string, unknown>)).toBe(true)

      expect(sanitizePersonalDocHandle(handle)).toBe(true)

      const cleanedSnapshot = Automerge.save(handle.doc()!)
      const reloaded = Automerge.load<Record<string, unknown>>(cleanedSnapshot)
      expect('publishState' in reloaded).toBe(false)
      expect(reloaded.profile).toBeNull()
      expect(reloaded.contacts).toEqual({})
      expect(reloaded.spaces).toEqual({})
    } finally {
      try { repo.shutdown() } catch { /* best effort */ }
    }
  })
})
