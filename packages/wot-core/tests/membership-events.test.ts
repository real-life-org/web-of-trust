import { describe, expect, it } from 'vitest'
import {
  assertMembershipEvent,
  formatMembershipEventKey,
  parseMembershipEventKey,
  resolveActiveMembers,
  type MembershipEvent,
} from '../src/protocol/sync/membership-events'

// Echte did:key-DIDs (Ed25519, multibase) — DIDs enthalten selbst ":".
const ALICE = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const BOB = 'did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG'
const CAROL = 'did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSdxf'
// did:web mit zusaetzlichen ":"-Segmenten — der Codec muss ueber das SUFFIX parsen.
const COLON_HEAVY = 'did:web:example.com:user:alice'

function event(overrides: Partial<MembershipEvent> = {}): MembershipEvent {
  return { did: ALICE, status: 'active', sinceGeneration: 0, ...overrides }
}

describe('membership-event key codec (`${did}:${generation}:${status}`)', () => {
  it('roundtrips a did:key DID', () => {
    const key = formatMembershipEventKey({ did: ALICE, sinceGeneration: 3, status: 'active' })
    expect(key).toBe(`${ALICE}:3:active`)
    expect(parseMembershipEventKey(key)).toEqual({ did: ALICE, sinceGeneration: 3, status: 'active' })
  })

  it('roundtrips a removed-event key', () => {
    const key = formatMembershipEventKey({ did: BOB, sinceGeneration: 7, status: 'removed' })
    expect(parseMembershipEventKey(key)).toEqual({ did: BOB, sinceGeneration: 7, status: 'removed' })
  })

  it('roundtrips a DID with extra ":" segments (suffix parsing)', () => {
    const key = formatMembershipEventKey({ did: COLON_HEAVY, sinceGeneration: 12, status: 'removed' })
    expect(key).toBe(`${COLON_HEAVY}:12:removed`)
    expect(parseMembershipEventKey(key)).toEqual({ did: COLON_HEAVY, sinceGeneration: 12, status: 'removed' })
  })

  it('roundtrips generation 0', () => {
    const key = formatMembershipEventKey({ did: ALICE, sinceGeneration: 0, status: 'active' })
    expect(parseMembershipEventKey(key)).toEqual({ did: ALICE, sinceGeneration: 0, status: 'active' })
  })

  it('format rejects invalid input', () => {
    expect(() => formatMembershipEventKey({ did: 'not-a-did', sinceGeneration: 0, status: 'active' })).toThrow()
    expect(() => formatMembershipEventKey({ did: ALICE, sinceGeneration: -1, status: 'active' })).toThrow()
    expect(() => formatMembershipEventKey({ did: ALICE, sinceGeneration: 1.5, status: 'active' })).toThrow()
    expect(() => formatMembershipEventKey({ did: ALICE, sinceGeneration: 0, status: 'banned' as 'active' })).toThrow()
  })

  it('format rejects unsafe integers, MAX_SAFE_INTEGER itself stays valid (safe-integer bound wie der uebrige Sync-Code)', () => {
    expect(() => formatMembershipEventKey({ did: ALICE, sinceGeneration: Number.MAX_SAFE_INTEGER + 1, status: 'active' })).toThrow()
    // Positiv-Kontrolle: die Grenze selbst ist erlaubt.
    expect(formatMembershipEventKey({ did: ALICE, sinceGeneration: Number.MAX_SAFE_INTEGER, status: 'active' }))
      .toBe(`${ALICE}:${Number.MAX_SAFE_INTEGER}:active`)
  })

  it('parse rejects malformed keys', () => {
    expect(() => parseMembershipEventKey('')).toThrow()
    expect(() => parseMembershipEventKey(`${ALICE}:3`)).toThrow() // Status-Segment fehlt
    expect(() => parseMembershipEventKey(`${ALICE}:3:banned`)).toThrow() // unbekannter Status
    expect(() => parseMembershipEventKey(`${ALICE}:x:active`)).toThrow() // Generation keine Zahl
    expect(() => parseMembershipEventKey(`${ALICE}:-1:active`)).toThrow() // negative Generation
    expect(() => parseMembershipEventKey(`${ALICE}:07:active`)).toThrow() // nicht-kanonische Dezimalform
    expect(() => parseMembershipEventKey('not-a-did:3:active')).toThrow() // kein DID-Praefix
    expect(() => parseMembershipEventKey('did:key:3:active')).toThrow() // DID-Rest leer nach Suffix-Abzug
  })

  it('parse rejects unsafe generations, MAX_SAFE_INTEGER itself stays valid (Praezisionsverlust-Schutz)', () => {
    // MAX_SAFE_INTEGER + 1 — exakt repraesentierbar, aber nicht mehr safe.
    expect(() => parseMembershipEventKey(`${ALICE}:9007199254740992:active`)).toThrow()
    // MAX_SAFE_INTEGER + 2 — Number() rundet auf ...992 (Praezisionsverlust).
    expect(() => parseMembershipEventKey(`${ALICE}:9007199254740993:active`)).toThrow()
    // Positiv-Kontrolle: die Grenze selbst roundtripped.
    expect(parseMembershipEventKey(`${ALICE}:${Number.MAX_SAFE_INTEGER}:active`))
      .toEqual({ did: ALICE, sinceGeneration: Number.MAX_SAFE_INTEGER, status: 'active' })
  })
})

describe('resolveActiveMembers (Sync 005 Z.305: hoehere Key-Generation gewinnt)', () => {
  it('single active event → member is active', () => {
    expect(resolveActiveMembers([event({ did: ALICE, status: 'active', sinceGeneration: 0 })])).toEqual([ALICE])
  })

  it('add then remove with ascending generation → removed', () => {
    const events = [
      event({ did: ALICE, status: 'active', sinceGeneration: 0 }),
      event({ did: ALICE, status: 'removed', sinceGeneration: 1 }),
    ]
    expect(resolveActiveMembers(events)).toEqual([])
  })

  it('remove then re-add with higher generation → active again', () => {
    const events = [
      event({ did: ALICE, status: 'active', sinceGeneration: 0 }),
      event({ did: ALICE, status: 'removed', sinceGeneration: 1 }),
      event({ did: ALICE, status: 'active', sinceGeneration: 2 }),
    ]
    expect(resolveActiveMembers(events)).toEqual([ALICE])
  })

  it('Z.305 conflict: active@2 vs removed@3 → removed wins (higher generation)', () => {
    const events = [
      event({ did: ALICE, status: 'active', sinceGeneration: 2 }),
      event({ did: ALICE, status: 'removed', sinceGeneration: 3 }),
    ]
    expect(resolveActiveMembers(events)).toEqual([])
    // Reihenfolgen-Unabhaengigkeit (CRDT-Merge liefert keine Ordnung)
    expect(resolveActiveMembers([...events].reverse())).toEqual([])
  })

  it('Z.305 inverse: removed@2 vs active@3 → active wins (higher generation)', () => {
    const events = [
      event({ did: ALICE, status: 'removed', sinceGeneration: 2 }),
      event({ did: ALICE, status: 'active', sinceGeneration: 3 }),
    ]
    expect(resolveActiveMembers(events)).toEqual([ALICE])
    expect(resolveActiveMembers([...events].reverse())).toEqual([ALICE])
  })

  it('tie-break: active@N vs removed@N → removed wins, order-independent', () => {
    const events = [
      event({ did: ALICE, status: 'active', sinceGeneration: 4 }),
      event({ did: ALICE, status: 'removed', sinceGeneration: 4 }),
    ]
    expect(resolveActiveMembers(events)).toEqual([])
    expect(resolveActiveMembers([...events].reverse())).toEqual([])
  })

  it('multiple DIDs resolve independently', () => {
    const events = [
      event({ did: ALICE, status: 'active', sinceGeneration: 0 }),
      event({ did: BOB, status: 'active', sinceGeneration: 1 }),
      event({ did: BOB, status: 'removed', sinceGeneration: 2 }),
      event({ did: CAROL, status: 'removed', sinceGeneration: 1 }),
      event({ did: CAROL, status: 'active', sinceGeneration: 2 }),
    ]
    const active = resolveActiveMembers(events)
    expect(active).toContain(ALICE)
    expect(active).not.toContain(BOB)
    expect(active).toContain(CAROL)
    expect(active).toHaveLength(2)
  })

  it('returns a deterministic (sorted) projection', () => {
    const events = [
      event({ did: CAROL, status: 'active', sinceGeneration: 0 }),
      event({ did: ALICE, status: 'active', sinceGeneration: 0 }),
    ]
    expect(resolveActiveMembers(events)).toEqual([...resolveActiveMembers([...events].reverse())])
    expect(resolveActiveMembers(events)).toEqual([ALICE, CAROL].sort())
  })

  it('empty event set → empty member list', () => {
    expect(resolveActiveMembers([])).toEqual([])
  })

  it('duplicate identical events are idempotent', () => {
    const events = [
      event({ did: ALICE, status: 'active', sinceGeneration: 1 }),
      event({ did: ALICE, status: 'active', sinceGeneration: 1 }),
    ]
    expect(resolveActiveMembers(events)).toEqual([ALICE])
  })
})

describe('assertMembershipEvent', () => {
  it('accepts a valid event without addedBy', () => {
    expect(() => assertMembershipEvent({ did: ALICE, status: 'active', sinceGeneration: 0 })).not.toThrow()
  })

  it('accepts a valid event with addedBy', () => {
    expect(() => assertMembershipEvent({ did: BOB, status: 'active', sinceGeneration: 2, addedBy: ALICE })).not.toThrow()
  })

  it('rejects non-records', () => {
    expect(() => assertMembershipEvent(null)).toThrow()
    expect(() => assertMembershipEvent('x')).toThrow()
    expect(() => assertMembershipEvent([event()])).toThrow()
  })

  it('rejects invalid did', () => {
    expect(() => assertMembershipEvent({ did: 'not-a-did', status: 'active', sinceGeneration: 0 })).toThrow()
  })

  it('rejects invalid status', () => {
    expect(() => assertMembershipEvent({ did: ALICE, status: 'banned', sinceGeneration: 0 })).toThrow()
  })

  it('rejects invalid sinceGeneration', () => {
    expect(() => assertMembershipEvent({ did: ALICE, status: 'active', sinceGeneration: -1 })).toThrow()
    expect(() => assertMembershipEvent({ did: ALICE, status: 'active', sinceGeneration: 1.5 })).toThrow()
    expect(() => assertMembershipEvent({ did: ALICE, status: 'active', sinceGeneration: '1' })).toThrow()
  })

  it('rejects unsafe sinceGeneration, MAX_SAFE_INTEGER itself stays valid (remote _members-Werte)', () => {
    expect(() => assertMembershipEvent({ did: ALICE, status: 'active', sinceGeneration: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    // Positiv-Kontrolle: die Grenze selbst ist erlaubt.
    expect(() => assertMembershipEvent({ did: ALICE, status: 'active', sinceGeneration: Number.MAX_SAFE_INTEGER })).not.toThrow()
  })

  it('rejects invalid addedBy', () => {
    expect(() => assertMembershipEvent({ did: ALICE, status: 'active', sinceGeneration: 0, addedBy: 'not-a-did' })).toThrow()
  })

  it('rejects extra keys', () => {
    expect(() => assertMembershipEvent({ did: ALICE, status: 'active', sinceGeneration: 0, role: 'admin' })).toThrow()
  })
})
