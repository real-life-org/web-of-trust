import { describe, expect, it } from 'vitest'
import {
  assertAdminEntry,
  resolveActiveAdmins,
  resolveAdmins,
  type AdminEntry,
} from '../src/protocol/sync/admin-set'

// Echte did:key-DIDs (Ed25519, multibase) — DIDs enthalten selbst ":".
const ALICE = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const BOB = 'did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG'
const CAROL = 'did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSdxf'

function admin(overrides: Partial<AdminEntry> = {}): AdminEntry {
  return { did: ALICE, ...overrides }
}

describe('resolveAdmins (grow-only Add-only-Set, Sync 005 Z.111-130/Z.221)', () => {
  it('returns the lexicographically sorted set of admin DIDs', () => {
    // CAROL/BOB/ALICE in unsortierter Reihenfolge → deterministische Sortierung.
    const entries: AdminEntry[] = [admin({ did: CAROL }), admin({ did: ALICE }), admin({ did: BOB })]
    expect(resolveAdmins(entries)).toEqual([ALICE, BOB, CAROL].sort())
  })

  it('dedupes the same DID promoted twice (idempotenter Doppel-Promote)', () => {
    const entries: AdminEntry[] = [
      admin({ did: ALICE, addedBy: BOB }),
      admin({ did: ALICE, addedBy: CAROL }),
      admin({ did: BOB }),
    ]
    expect(resolveAdmins(entries)).toEqual([ALICE, BOB].sort())
  })

  it('returns an empty array for an empty set (Alt-Space-Vorfeld)', () => {
    expect(resolveAdmins([])).toEqual([])
  })

  it('accepts an iterable, not only an array', () => {
    const set = new Set<AdminEntry>([admin({ did: BOB }), admin({ did: ALICE })])
    expect(resolveAdmins(set)).toEqual([ALICE, BOB].sort())
  })
})

describe('resolveActiveAdmins (∩ active members, Codex-Blocker / Risk 1)', () => {
  it('is the intersection of resolved admins and active members', () => {
    const entries: AdminEntry[] = [admin({ did: ALICE }), admin({ did: BOB })]
    expect(resolveActiveAdmins(entries, [ALICE, BOB, CAROL])).toEqual([ALICE, BOB].sort())
  })

  it('drops a promoted admin who was later removed as a member (grow-only entzieht via ∩)', () => {
    // ALICE + BOB sind beide im grow-only _admins-Set, aber BOB wurde als Member
    // entfernt → BOB DARF nicht mehr als Admin zaehlen (Sync 005 Z.130 "Teilmenge von members").
    const entries: AdminEntry[] = [admin({ did: ALICE }), admin({ did: BOB })]
    expect(resolveActiveAdmins(entries, [ALICE, CAROL])).toEqual([ALICE])
  })

  it('returns empty when no resolved admin is an active member', () => {
    const entries: AdminEntry[] = [admin({ did: BOB })]
    expect(resolveActiveAdmins(entries, [ALICE, CAROL])).toEqual([])
  })

  it('returns empty for an empty admin set even with active members', () => {
    expect(resolveActiveAdmins([], [ALICE, BOB])).toEqual([])
  })

  it('stays idempotent under a double-promoted DID intersected with active members', () => {
    const entries: AdminEntry[] = [admin({ did: ALICE }), admin({ did: ALICE }), admin({ did: BOB })]
    expect(resolveActiveAdmins(entries, [ALICE, BOB, CAROL])).toEqual([ALICE, BOB].sort())
  })

  it('is sorted and free of duplicates from the member side', () => {
    const entries: AdminEntry[] = [admin({ did: BOB }), admin({ did: ALICE })]
    expect(resolveActiveAdmins(entries, [BOB, ALICE, BOB])).toEqual([ALICE, BOB].sort())
  })
})

describe('assertAdminEntry', () => {
  it('accepts a minimal valid entry', () => {
    expect(() => assertAdminEntry({ did: ALICE })).not.toThrow()
  })

  it('accepts an entry with the informational addedBy field', () => {
    expect(() => assertAdminEntry({ did: ALICE, addedBy: BOB })).not.toThrow()
  })

  it('rejects a non-object', () => {
    expect(() => assertAdminEntry(null)).toThrow()
    expect(() => assertAdminEntry('did:key:zzz')).toThrow()
    expect(() => assertAdminEntry([])).toThrow()
  })

  it('rejects a missing or malformed did', () => {
    expect(() => assertAdminEntry({})).toThrow()
    expect(() => assertAdminEntry({ did: 'not-a-did' })).toThrow()
    expect(() => assertAdminEntry({ did: 42 })).toThrow()
  })

  it('rejects a malformed addedBy', () => {
    expect(() => assertAdminEntry({ did: ALICE, addedBy: 'not-a-did' })).toThrow()
  })

  it('rejects unknown properties', () => {
    expect(() => assertAdminEntry({ did: ALICE, generation: 1 })).toThrow()
  })
})
