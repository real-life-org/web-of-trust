// Pure projection of the real adapter, groups: the members the group's log names, each with the
// contact this device knows it as and with the members that invited it (lib 0.19.0 groupProvenance),
// the own standing, and what the person can do in the group.
import { describe, expect, it } from 'vitest'
import { memberHandle, project, type ProjectionInput } from '../../src/adapters/rltp/projection'
import { EMPTY_ENCOUNTERS } from '../../src/adapters/rltp/app-data'
import type { Revision } from '../../src/port'

const T = Date.parse('2026-11-22T10:00:00Z')
const [AL, BEA, CY, GONE] = ['did:key:z6Mk-al-000001', 'did:key:z6Mk-bea-00002', 'did:key:z6Mk-cy-000003', 'did:key:z6Mk-gone-0004']

const contact = (id: string, name: string) =>
  ({
    commitSeq: '9', id, aliases: [], relationships: [], displayName: name, provenance: 'ceremony', verification: 'mutual',
    trust: { given: false, received: false, paused: false, pending: false }, classes: {}, blocked: false, canMessage: true,
  }) as never

const group = (over: Record<string, unknown> = {}) =>
  ({
    commitSeq: '9', id: 'g1', name: 'Garten', phase: 'member', listed: true, vouchThreshold: '1',
    members: [{ anchor: AL, name: 'Al', self: true }, { anchor: BEA, name: 'B. on her card', contactId: 'bea', self: false }, { anchor: CY, name: 'Cy', self: false }],
    pending: [], ...over,
  }) as never

const input = (over: Partial<ProjectionInput> = {}): ProjectionInput => ({
  revision: '1:9:1' as Revision, now: T, timeZone: 'UTC', anchorShort: 'id…', contacts: [contact('bea', 'Bea')], prompts: [],
  profile: { commitSeq: '9', revision: '1', name: 'Al' } as never, encounters: EMPTY_ENCOUNTERS, displayed: {}, lines: [], intents: [], reads: {}, shown: {},
  groups: [group()], ...over,
})

describe('rltp projection: groups', () => {
  it('lists the group with the own standing and its members; a member that is a contact shows under the contact\'s name', () => {
    const m = project(input())
    expect(m.groups).toMatchObject([{ id: 'g1', name: 'Garten', membership: 'member', knownMembers: 3, myHandle: memberHandle(AL), conversation: { key: 'g:g1' } }])
    expect(m.standing.groups).toBe(1)
    const d = m.groupDetails.get('g1')!
    expect(d.visibleMembers.map((x) => [x.name, x.contactId, x.self])).toEqual([['Al', null, true], ['Bea', 'bea', false], ['Cy', null, false]])
    expect(d.actions).toEqual({ invite: { ok: true }, leave: { ok: true }, report: { ok: false, reason: 'not-supported' } })
  })

  it('without the library\'s provenance nothing is said about who invited whom, and nobody is called the founder', () => {
    const d = project(input()).groupDetails.get('g1')!
    expect(d.visibleMembers.map((x) => x.invitedBy)).toEqual([null, null, null])
    expect(d.role).toBe('member')
  })

  it('who invited whom: the inviters by name, both where two members admitted the same person, none for the founder; one who left has no name', () => {
    const provenance = { g1: { [BEA]: [AL], [CY]: [BEA, GONE].sort() } }
    const d = project(input({ provenance })).groupDetails.get('g1')!
    const by = new Map(d.visibleMembers.map((x) => [x.member as string, x.invitedBy]))
    expect(by.get(AL)).toEqual([])
    expect(d.role).toBe('founder')
    expect(by.get(BEA)).toMatchObject([{ member: AL, self: true, name: 'Al' }])
    expect(by.get(CY)!.map((i) => [i.member, i.name, i.contactId, i.handle])).toEqual(
      [BEA, GONE].sort().map((a) => (a === BEA ? [BEA, 'Bea', 'bea', memberHandle(BEA)] : [GONE, null, null, memberHandle(GONE)])),
    )
    // a member somebody invited is no founder
    const asBea = project(input({ groups: [group({ members: [{ anchor: AL, name: 'Al', self: false }, { anchor: BEA, name: 'Bea', self: true }] })], provenance: { g1: { [BEA]: [AL] } } }))
    expect(asBea.groups[0]?.role).toBe('member')
  })

  it('a group left or still joining: listed with its standing, nothing to do in it, not counted', () => {
    for (const phase of ['joining', 'left', 'void'] as const) {
      const m = project(input({ groups: [group({ phase })] }))
      expect(m.groups[0]?.membership).toBe(phase)
      expect(m.groupDetails.get('g1')!.actions).toMatchObject({ invite: { ok: false }, leave: { ok: false } })
      expect(m.standing.groups).toBe(0)
    }
  })

  it('an invitation into a group is a decision of the contact it came over; one attributed to no contact is not shown', () => {
    const prompts = [
      { commitSeq: '9', id: 'p1', kind: 'group-invite', contactId: 'bea', groupId: 'g2', openedAt: T, expiresAt: T + 1000 },
      { commitSeq: '9', id: 'p2', kind: 'group-invite', groupId: 'g3', openedAt: T },
    ] as never
    expect(project(input({ prompts })).decisions).toEqual([{ id: 'p1', openedAt: T, expiresAt: T + 1000, state: 'open', kind: 'group-invite', inviterId: 'bea', groupName: null, candidacyChoice: { ok: false, reason: 'not-supported' } }])
  })

  it('the invitation names its group where the library states it', () => {
    const named = (groupName: unknown) => [{ commitSeq: '9', id: 'p1', kind: 'group-invite', contactId: 'bea', groupId: 'g2', groupName, openedAt: T }] as never
    expect(project(input({ prompts: named('Garten') })).decisions).toMatchObject([{ kind: 'group-invite', groupName: 'Garten' }])
    // nothing stated, or nothing usable: unknown, never an empty title
    for (const none of ['', undefined, 7]) expect(project(input({ prompts: named(none) })).decisions).toMatchObject([{ groupName: null }])
  })

  it('an open admission: its vouches against the threshold, vouching offered to a member', () => {
    const m = project(input({ groups: [group({ vouchThreshold: '2', pending: [{ member: CY, name: 'Cy', vouches: 1 }] })] }))
    expect(m.groups[0]?.openAdmissions).toBe(1)
    expect(m.groupDetails.get('g1')!.admissions).toEqual([{ member: CY, name: 'Cy', have: 1, need: 2, iVouched: false, vouch: { ok: true } }])
  })
})
