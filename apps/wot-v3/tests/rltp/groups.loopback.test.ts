// @vitest-environment node
// Groups on the real adapter and the real library (Membership Tasks on Access stage 1): founding, an
// invitation over a relationship, the invitee's decision, the members on both devices, and leaving.
import { describe, expect, it } from 'vitest'
import type { Conversation, DecisionCardItem, GroupDetail, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'
import { graphInputOf } from '../../src/hooks/graph'
import { graphModel } from '../../src/hooks/graph-model'

const T0 = Date.parse('2026-11-22T10:00:00Z')
const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

async function met() {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'UTC')
  const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 61 })
  const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 63 })
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
    }
  }
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw new Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done
  await settle()
  const bId = value(B.port.stores.contacts)[0]!.id
  await B.port.trust.counterVerify(bId).done
  await settle()
  const aId = value(A.port.stores.contacts)[0]!.id
  return { carrier, clock, A, B, aId, bId, settle }
}

describe('groups over the real adapter (loopback)', () => {
  it('A founds a group and invites B; B answers in the conversation with A; both list the same two members; B leaves', async () => {
    const w = await met()
    expect(value(w.A.port.stores.groups)).toEqual([])
    expect(w.A.port.stores.capabilities.get().leaveGroup).toBe(true)

    // founding: the group is there at once, with its founder as the only member
    const founded = await w.A.port.trust.foundGroup({ name: 'Garten' }).done
    expect(founded.ok).toBe(true)
    if (!founded.ok) return
    const groupId = founded.value.groupId
    await w.settle()
    expect(value(w.A.port.stores.groups)).toMatchObject([{ id: groupId, name: 'Garten', membership: 'member', knownMembers: 1, openAdmissions: 0 }])
    expect(value(w.A.port.stores.standing).groups).toBe(1)
    const alone = value(w.A.port.stores.group(groupId)) as GroupDetail
    // the founder: nobody invited it
    expect(alone.role).toBe('founder')
    expect(alone.visibleMembers).toMatchObject([{ self: true, contactId: null, invitedBy: [] }])
    expect(alone.actions).toMatchObject({ invite: { ok: true }, leave: { ok: true } })

    // the invitation reaches B as a decision, with its card in the conversation with A
    expect((await w.A.port.trust.invite(groupId, w.aId).done).ok).toBe(true)
    await w.settle()
    const open = value(w.B.port.stores.decisions).filter((d) => d.kind === 'group-invite')
    expect(open).toMatchObject([{ kind: 'group-invite', inviterId: w.bId, groupName: 'Garten', state: 'open' }])
    const cards = value(w.B.port.stores.conversation(`c:${w.bId}`) as ReadStore<Loadable<Conversation>>).items.filter((i): i is DecisionCardItem => i.kind === 'decision')
    expect(cards.some((c) => c.decision === open[0]!.id && c.resolution === null)).toBe(true)
    expect(value(w.B.port.stores.groups)).toEqual([])

    // B accepts: A admits it, B fetches the group's log from A and is a member once it confirms
    expect((await w.B.port.trust.decide(open[0]!.id, 'accept').done).ok).toBe(true)
    await w.settle()
    expect(value(w.B.port.stores.decisions).filter((d) => d.kind === 'group-invite')).toEqual([])
    // the card stays in the conversation as answered, by this device
    const after = value(w.B.port.stores.conversation(`c:${w.bId}`) as ReadStore<Loadable<Conversation>>).items.filter((i): i is DecisionCardItem => i.kind === 'decision')
    expect(after.find((c) => c.decision === open[0]!.id)?.resolution).toMatchObject({ choice: 'accept', by: 'this-device', basis: 'own-act' })
    expect(value(w.B.port.stores.groups)).toMatchObject([{ id: groupId, name: 'Garten', membership: 'member', knownMembers: 2 }])
    const atA = value(w.A.port.stores.group(groupId)) as GroupDetail
    const atB = value(w.B.port.stores.group(groupId)) as GroupDetail
    expect(atA.visibleMembers.map((m) => m.member).sort()).toEqual(atB.visibleMembers.map((m) => m.member).sort())
    // each knows the other member as its contact, under the contact's name
    expect(atA.visibleMembers.find((m) => !m.self)).toMatchObject({ contactId: w.aId, name: 'Bea' })
    expect(atB.visibleMembers.find((m) => !m.self)).toMatchObject({ contactId: w.bId, name: 'Al' })
    // who invited whom, read from the group's log on both devices: A invited B, nobody invited A
    expect(atA.visibleMembers.find((m) => !m.self)?.invitedBy).toMatchObject([{ self: true, name: 'Al' }])
    expect(atB.visibleMembers.find((m) => m.self)?.invitedBy).toMatchObject([{ self: false, contactId: w.bId, name: 'Al' }])
    expect(atB.visibleMembers.find((m) => !m.self)?.invitedBy).toEqual([])
    expect([atA.role, atB.role]).toEqual(['founder', 'member'])

    // B leaves: it holds the group as left, A lists itself alone again
    expect((await w.B.port.trust.leaveGroup(groupId).done).ok).toBe(true)
    await w.settle()
    expect(value(w.B.port.stores.groups)).toMatchObject([{ id: groupId, membership: 'left' }])
    expect((value(w.B.port.stores.group(groupId)) as GroupDetail).actions).toMatchObject({ invite: { ok: false }, leave: { ok: false } })
    expect(value(w.A.port.stores.groups)).toMatchObject([{ id: groupId, membership: 'member', knownMembers: 1 }])
  })
})

describe('members who know each other apart from the invitation (Anton 22.11.)', () => {
  it('B and C, both invited by A, meet: each learns from the other\'s group star that they share the group', async () => {
    const carrier = memoryCarrier()
    const clock = virtualClock(T0, 'UTC')
    const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 61 })
    const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 63 })
    const C = await loopbackDevice({ carrier, id: 'C', name: 'Cem', words: LOOPBACK_PHRASES[2], clock, seed: 65 })
    const all = [A, B, C]
    const settle = async () => {
      for (let i = 0; i < 12; i++) {
        await carrier.settled()
        for (const d of all) await d.port.session()?.idle()
      }
    }
    const meet = async (x: typeof A, y: typeof A) => {
      const shown = await y.port.trust.showCard().done
      if (!shown.ok) throw new Error('show')
      const scanned = await x.port.trust.confirmCard(shown.value.qr).done
      if (!scanned.ok) throw new Error('scan')
      await settle()
      const open = value(y.port.stores.decisions).find((d) => d.kind === 'encounter-confirm')
      if (!open || open.kind !== 'encounter-confirm') throw new Error('no confirmation')
      await y.port.trust.counterVerify(open.contactId).done
      await settle()
    }
    await meet(A, B)
    await meet(A, C)
    const founded = await A.port.trust.foundGroup({ name: 'Garten' }).done
    if (!founded.ok) throw new Error('found')
    const groupId = founded.value.groupId
    for (const c of value(A.port.stores.contacts)) {
      expect((await A.port.trust.invite(groupId, c.id).done).ok).toBe(true)
      await settle()
    }
    for (const d of [B, C]) {
      const inv = value(d.port.stores.decisions).find((x) => x.kind === 'group-invite')
      if (!inv) throw new Error('no invitation')
      expect((await d.port.trust.decide(inv.id, 'accept').done).ok).toBe(true)
      await settle()
    }
    expect(value(B.port.stores.groups)).toMatchObject([{ id: groupId, membership: 'member', knownMembers: 3 }])
    expect(value(C.port.stores.groups)).toMatchObject([{ id: groupId, membership: 'member', knownMembers: 3 }])

    await meet(B, C)
    clock.advance(60_000)
    await settle()
    const cAtB = value(B.port.stores.contacts).find((c) => c.name === 'Cem')!
    const bAtC = value(C.port.stores.contacts).find((c) => c.name === 'Bea')!
    const detailAtB = value(B.port.stores.contact(cAtB.id))
    const detailAtC = value(C.port.stores.contact(bAtC.id))
    expect(detailAtB?.sharedGroups).toEqual([groupId])
    expect(detailAtC?.sharedGroups).toEqual([groupId])
    // the group's own log still names C only by its handle at B: the star says who, not which member
    const atB = value(B.port.stores.group(groupId)) as GroupDetail
    expect(atB.visibleMembers.filter((m) => !m.self && m.contactId !== null)).toHaveLength(1)
    // the graph at B: the group joined to B and to A (who invited B) by the log, to C by C's word; C's
    // member of the log stays a dot, because nothing says that it is C (#542)
    const g = graphModel(graphInputOf(B.port)!)
    const aAtB = value(B.port.stores.contacts).find((c) => c.name === 'Al')!
    expect(g.memberships.map((m) => [m.node, m.by]).sort()).toEqual([[aAtB.id, 'log'], [cAtB.id, 'said'], ['me', 'log']].sort())
    expect(g.hubs).toMatchObject([{ group: groupId, members: 3, unknown: 1 }])
  })
})
