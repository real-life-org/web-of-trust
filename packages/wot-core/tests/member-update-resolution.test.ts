import { describe, expect, it } from 'vitest'
import { resolveMemberUpdatesAgainstCanonical, canonicalEventSetAnswersPending } from '../src/application/spaces/member-update-resolution'
import type { SeenMemberUpdateSignal } from '../src/protocol/sync/member-update-disposition'
import type { MembershipEvent } from '../src/protocol/sync/membership-events'

const SPACE = '11111111-1111-4111-8111-111111111111'
const ADMIN = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const MEMBER = 'did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG'
const LOCAL = 'did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSdxf'

function pending(overrides: Partial<SeenMemberUpdateSignal> = {}): SeenMemberUpdateSignal {
  return {
    spaceId: SPACE,
    action: 'added',
    memberDid: MEMBER,
    effectiveKeyGeneration: 1,
    signerDid: ADMIN,
    storedDisposition: 'store-pending-and-sync',
    ...overrides,
  }
}

describe('resolveMemberUpdatesAgainstCanonical (Sync 005 Z.194-198 + Z.253 Weg a)', () => {
  it('confirms a pending addition when the canonical list contains the DID (Z.196)', () => {
    const signal = pending({ action: 'added', memberDid: MEMBER })
    const result = resolveMemberUpdatesAgainstCanonical({
      pending: [signal],
      canonicalActiveMembers: [ADMIN, LOCAL, MEMBER],
      localDid: LOCAL,
    })
    expect(result.confirmed).toEqual([signal])
    expect(result.discarded).toEqual([])
    expect(result.localRemovalConfirmed).toBe(false)
  })

  it('confirms a pending removal when the canonical list lacks the DID (Z.197)', () => {
    const signal = pending({ action: 'removed', memberDid: MEMBER })
    const result = resolveMemberUpdatesAgainstCanonical({
      pending: [signal],
      canonicalActiveMembers: [ADMIN, LOCAL],
      localDid: LOCAL,
    })
    expect(result.confirmed).toEqual([signal])
    expect(result.discarded).toEqual([])
    expect(result.localRemovalConfirmed).toBe(false) // Fremd-DID, nicht localDid
  })

  it('discards a contradicted addition: canonical list lacks the DID (Z.198)', () => {
    const signal = pending({ action: 'added', memberDid: MEMBER })
    const result = resolveMemberUpdatesAgainstCanonical({
      pending: [signal],
      canonicalActiveMembers: [ADMIN, LOCAL],
      localDid: LOCAL,
    })
    expect(result.confirmed).toEqual([])
    expect(result.discarded).toEqual([signal])
    expect(result.localRemovalConfirmed).toBe(false)
  })

  it('discards a contradicted removal: canonical list still contains the DID (Z.198)', () => {
    const signal = pending({ action: 'removed', memberDid: MEMBER })
    const result = resolveMemberUpdatesAgainstCanonical({
      pending: [signal],
      canonicalActiveMembers: [ADMIN, LOCAL, MEMBER],
      localDid: LOCAL,
    })
    expect(result.confirmed).toEqual([])
    expect(result.discarded).toEqual([signal])
    expect(result.localRemovalConfirmed).toBe(false)
  })

  it('sets localRemovalConfirmed when the own pending removal is canonically confirmed (Z.253 Weg a)', () => {
    const signal = pending({ action: 'removed', memberDid: LOCAL })
    const result = resolveMemberUpdatesAgainstCanonical({
      pending: [signal],
      canonicalActiveMembers: [ADMIN, MEMBER],
      localDid: LOCAL,
    })
    expect(result.confirmed).toEqual([signal])
    expect(result.localRemovalConfirmed).toBe(true)
  })

  it('does NOT set localRemovalConfirmed when the own removal is contradicted (Z.198 schuetzt vor Cleanup)', () => {
    const signal = pending({ action: 'removed', memberDid: LOCAL })
    const result = resolveMemberUpdatesAgainstCanonical({
      pending: [signal],
      canonicalActiveMembers: [ADMIN, LOCAL, MEMBER],
      localDid: LOCAL,
    })
    expect(result.confirmed).toEqual([])
    expect(result.discarded).toEqual([signal])
    expect(result.localRemovalConfirmed).toBe(false)
  })

  it('does NOT set localRemovalConfirmed from canonical absence alone (kein Pending-Removal-Signal)', () => {
    // Z.253 Weg (a) bestaetigt das member-update(removed)-Pending — ohne Pending kein Cleanup-Trigger.
    const result = resolveMemberUpdatesAgainstCanonical({
      pending: [pending({ action: 'added', memberDid: MEMBER })],
      canonicalActiveMembers: [ADMIN, MEMBER], // LOCAL fehlt, aber kein removed-Pending fuer LOCAL
      localDid: LOCAL,
    })
    expect(result.localRemovalConfirmed).toBe(false)
  })

  it('partitions mixed pending signals into confirmed and discarded', () => {
    const confirmedAdd = pending({ action: 'added', memberDid: MEMBER })
    const discardedAdd = pending({ action: 'added', memberDid: 'did:key:z6MkAbsent' })
    const confirmedRemove = pending({ action: 'removed', memberDid: 'did:key:z6MkGone' })
    const discardedRemove = pending({ action: 'removed', memberDid: ADMIN })
    const result = resolveMemberUpdatesAgainstCanonical({
      pending: [confirmedAdd, discardedAdd, confirmedRemove, discardedRemove],
      canonicalActiveMembers: [ADMIN, LOCAL, MEMBER],
      localDid: LOCAL,
    })
    expect(result.confirmed).toEqual([confirmedAdd, confirmedRemove])
    expect(result.discarded).toEqual([discardedAdd, discardedRemove])
    expect(result.localRemovalConfirmed).toBe(false)
  })

  it('retains an unverified own-removal pending until an authority upgrade', () => {
    const signal = pending({ action: 'removed', memberDid: LOCAL, storedDisposition: 'store-unverified-pending-and-sync' })
    const result = resolveMemberUpdatesAgainstCanonical({
      pending: [signal],
      canonicalActiveMembers: [ADMIN],
      localDid: LOCAL,
    })
    expect(result.confirmed).toEqual([])
    expect(result.discarded).toEqual([])
    expect(result.localRemovalConfirmed).toBe(false)
  })

  it('returns empty results for an empty pending list', () => {
    const result = resolveMemberUpdatesAgainstCanonical({
      pending: [],
      canonicalActiveMembers: [ADMIN, LOCAL],
      localDid: LOCAL,
    })
    expect(result.confirmed).toEqual([])
    expect(result.discarded).toEqual([])
    expect(result.localRemovalConfirmed).toBe(false)
  })
})

function event(did: string, status: 'active' | 'removed', sinceGeneration: number): MembershipEvent {
  return { did, status, sinceGeneration }
}

describe('canonicalEventSetAnswersPending (Review-M1: Antwort liegt im Event-Set bereits vor?)', () => {
  // Kriterium: das zum Pending gehoerende kanonische Event (active@N bzw.
  // removed@N) koennte den aktuellen Gewinner fuer die DID nach der
  // Z.305-Lese-Regel (hoehere Generation gewinnt, Tie-Break removed) nicht
  // mehr kippen → die Antwort steht fest, sofortige Aufloesung ist erlaubt.

  it('kein Event fuer die DID → keine Antwort (Pending bleibt offen)', () => {
    expect(canonicalEventSetAnswersPending(
      [event(ADMIN, 'active', 0)],
      pending({ action: 'removed', memberDid: MEMBER, effectiveKeyGeneration: 1 }),
    )).toBe(false)
  })

  it('removed@N mit Gewinner removed@N → Antwort (Bestaetigung steht fest)', () => {
    expect(canonicalEventSetAnswersPending(
      [event(MEMBER, 'active', 0), event(MEMBER, 'removed', 1)],
      pending({ action: 'removed', memberDid: MEMBER, effectiveKeyGeneration: 1 }),
    )).toBe(true)
  })

  it('removed@N mit Gewinner active@N → KEINE Antwort (removed@N wuerde den Tie-Break noch gewinnen)', () => {
    expect(canonicalEventSetAnswersPending(
      [event(MEMBER, 'active', 1)],
      pending({ action: 'removed', memberDid: MEMBER, effectiveKeyGeneration: 1 }),
    )).toBe(false)
  })

  it('removed@N mit Gewinner active@N+1 → Antwort (Widerspruch steht fest, Z.198)', () => {
    expect(canonicalEventSetAnswersPending(
      [event(MEMBER, 'active', 2)],
      pending({ action: 'removed', memberDid: MEMBER, effectiveKeyGeneration: 1 }),
    )).toBe(true)
  })

  it('removed@N mit Gewinner removed@N-1 → KEINE Antwort (konservativ: removed@N wuerde den Gewinner noch ersetzen)', () => {
    expect(canonicalEventSetAnswersPending(
      [event(MEMBER, 'removed', 0)],
      pending({ action: 'removed', memberDid: MEMBER, effectiveKeyGeneration: 1 }),
    )).toBe(false)
  })

  it('added@N mit Gewinner active@N → Antwort (Bestaetigung steht fest, Z.196)', () => {
    expect(canonicalEventSetAnswersPending(
      [event(MEMBER, 'active', 1)],
      pending({ action: 'added', memberDid: MEMBER, effectiveKeyGeneration: 1 }),
    )).toBe(true)
  })

  it('added@N mit Gewinner active@N-1 → KEINE Antwort (active@N wuerde den Gewinner noch ersetzen)', () => {
    expect(canonicalEventSetAnswersPending(
      [event(MEMBER, 'active', 0)],
      pending({ action: 'added', memberDid: MEMBER, effectiveKeyGeneration: 1 }),
    )).toBe(false)
  })

  it('added@N mit Gewinner removed@N → Antwort (Widerspruch steht fest: Tie-Break removed)', () => {
    expect(canonicalEventSetAnswersPending(
      [event(MEMBER, 'removed', 1)],
      pending({ action: 'added', memberDid: MEMBER, effectiveKeyGeneration: 1 }),
    )).toBe(true)
  })

  it('added@N mit Gewinner removed@N-1 → KEINE Antwort (active@N wuerde noch gewinnen)', () => {
    expect(canonicalEventSetAnswersPending(
      [event(MEMBER, 'removed', 0)],
      pending({ action: 'added', memberDid: MEMBER, effectiveKeyGeneration: 1 }),
    )).toBe(false)
  })
})
