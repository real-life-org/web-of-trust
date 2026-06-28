import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as Automerge from '@automerge/automerge'
import { Repo } from '@automerge/automerge-repo'
import { sanitizeLegacyPersonalDoc, sanitizePersonalDocHandle } from '../src/PersonalDocManager'
import type { PersonalDoc } from '../src/PersonalDocManager'

/**
 * Legacy PersonalDoc snapshots may contain top-level `publishState` and
 * `cachedGraph` fields from earlier versions. Demo publish-state persistence
 * and graph cache persistence are now owned by LocalCacheStore — PersonalDoc
 * must not re-introduce those schemas on load/migration.
 */
describe('sanitizeLegacyPersonalDoc', () => {
  it('keeps legacy cache-only PersonalDoc schema out of the source surface', () => {
    const sourceFiles = [
      resolve(process.cwd(), 'src/PersonalDocManager.ts'),
      resolve(process.cwd(), 'src/index.ts'),
      resolve(process.cwd(), '../../apps/demo/src/context/AdapterContext.tsx'),
    ]

    const forbiddenNeedles = [
      'PublishStateDoc',
      'verificationsDirty',
      'CachedGraphEntryDoc',
      'CachedGraphVerificationDoc',
      'CachedGraphAttestationDoc',
      'doc.cachedGraph',
      'delete d.cachedGraph',
      'Copied cachedGraph',
    ]

    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8')

      for (const needle of forbiddenNeedles) {
        expect(source).not.toContain(needle)
      }
    }
  })

  it('keeps legacy verification PersonalDoc schema out of the source surface', () => {
    const sourceFiles = [
      resolve(process.cwd(), 'src/PersonalDocManager.ts'),
      resolve(process.cwd(), 'src/index.ts'),
      resolve(process.cwd(), '../../apps/demo/src/personalDocManager.ts'),
    ]

    const forbiddenNeedles = [
      'VerificationDoc',
      'verifications:',
    ]

    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8')

      for (const needle of forbiddenNeedles) {
        expect(source).not.toContain(needle)
      }
    }
  })

  it('strips top-level publishState, cachedGraph, and verifications from legacy data', () => {
    const cachedGraph = { entries: { 'did:key:bob': { name: 'Bob' } } }
    const legacy = {
      profile: null,
      contacts: {},
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
      cachedGraph,
      publishState: {
        profileDirty: true,
        verificationsDirty: true,
        attestationsDirty: true,
      },
    }

    const sanitized = sanitizeLegacyPersonalDoc(legacy)

    expect('publishState' in sanitized).toBe(false)
    expect((sanitized as Record<string, unknown>).publishState).toBeUndefined()
    expect('cachedGraph' in sanitized).toBe(false)
    expect((sanitized as Record<string, unknown>).cachedGraph).toBeUndefined()
    expect('verifications' in sanitized).toBe(false)
    expect((sanitized as Record<string, unknown>).verifications).toBeUndefined()
  })

  it('preserves current PersonalDoc fields', () => {
    const input: Omit<PersonalDoc, 'verifications'> & { publishState?: unknown; verifications?: unknown } = {
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
    expect(sanitized.attestations).toEqual({})
    expect(sanitized.attestationMetadata).toEqual({})
    expect(sanitized.outbox).toEqual({})
    expect(sanitized.spaces).toEqual({})
    expect(sanitized.groupKeys).toEqual({})
    expect('publishState' in sanitized).toBe(false)
    expect('verifications' in sanitized).toBe(false)
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

    const target = {
      profile: null,
      contacts: {},
      attestations: {},
      attestationMetadata: {},
      outbox: {},
      spaces: {},
      groupKeys: {},
    } as PersonalDoc
    Object.assign(target, sanitized)

    expect('publishState' in target).toBe(false)
    expect('verifications' in target).toBe(false)
  })

  it('sanitizes a saved Automerge snapshot that has top-level publishState, cachedGraph, and verifications', () => {
    const cachedGraph = { entries: { 'did:key:bob': { name: 'Bob' } } }
    const legacyDoc = Automerge.from<Record<string, unknown>>({
      profile: null,
      contacts: {},
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
      cachedGraph,
      publishState: {
        profileDirty: true,
        verificationsDirty: true,
        attestationsDirty: false,
      },
    })
    const snapshot = Automerge.save(legacyDoc)

    const reloaded = Automerge.load<Record<string, unknown>>(snapshot)
    expect('publishState' in reloaded).toBe(true)
    expect('cachedGraph' in reloaded).toBe(true)
    expect('verifications' in reloaded).toBe(true)

    const sanitized = sanitizeLegacyPersonalDoc(reloaded as Partial<PersonalDoc> & Record<string, unknown>)
    expect('publishState' in sanitized).toBe(false)
    expect('cachedGraph' in sanitized).toBe(false)
    expect('verifications' in sanitized).toBe(false)
    expect(sanitized.profile).toBeNull()
    expect(sanitized.contacts).toEqual({})
    expect(sanitized.spaces).toEqual({})
  })

  it('strips top-level publishState, cachedGraph, and verifications before re-saving a loaded Automerge handle', () => {
    const cachedGraph = { entries: { 'did:key:bob': { name: 'Bob' } } }
    const legacyDoc = Automerge.from<Record<string, unknown>>({
      profile: null,
      contacts: {},
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
      cachedGraph,
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
      expect('cachedGraph' in (handle.doc() as unknown as Record<string, unknown>)).toBe(true)
      expect('verifications' in (handle.doc() as unknown as Record<string, unknown>)).toBe(true)

      expect(sanitizePersonalDocHandle(handle)).toBe(true)

      const cleanedSnapshot = Automerge.save(handle.doc()!)
      const reloaded = Automerge.load<Record<string, unknown>>(cleanedSnapshot)
      expect('publishState' in reloaded).toBe(false)
      expect('cachedGraph' in reloaded).toBe(false)
      expect('verifications' in reloaded).toBe(false)
      expect(reloaded.profile).toBeNull()
      expect(reloaded.contacts).toEqual({})
      expect(reloaded.spaces).toEqual({})
    } finally {
      try { repo.shutdown() } catch { /* best effort */ }
    }
  })
})
