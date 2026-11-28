// @vitest-environment node
// Who sees whom in a group, on the real adapter and the real library, as the app's graph and member
// list show it. The rule is the library's (its test/group-visibility-matrix.test.mjs runs all forty
// orders): a device learns who a member is only from the invitation between the two, or from that
// member itself: the group star says that a contact shares the group, the sealed group star, sent to a
// trusted contact, proves which member it is. Here a sample of orders checks that the app draws the
// same picture whatever the order: F founds and invites X and Y, who meet and trust each other.
import { describe, expect, it } from 'vitest'
import type { GroupDetail, GroupId, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, meet as meetDevices, memoryCarrier, type LoopbackDevice } from '../../harness/loopback'
import { graphInputOf } from '../../src/hooks/graph'
import { graphModel } from '../../src/hooks/graph-model'

const T0 = Date.parse('2026-11-23T10:00:00Z')
const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

type Step = 'joinX' | 'joinY' | 'meet' | 'trustXY' | 'trustYX'

async function world(order: readonly Step[], seed: number) {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'UTC')
  const F = await loopbackDevice({ carrier, id: 'F', name: 'Fay', words: LOOPBACK_PHRASES[0], clock, seed })
  const X = await loopbackDevice({ carrier, id: 'X', name: 'Xan', words: LOOPBACK_PHRASES[1], clock, seed: seed + 2 })
  const Y = await loopbackDevice({ carrier, id: 'Y', name: 'Yul', words: LOOPBACK_PHRASES[2], clock, seed: seed + 4 })
  const all = [F, X, Y]
  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      await carrier.settled()
      for (const d of all) await d.port.session()?.idle()
    }
  }
  const meet = async (a: LoopbackDevice, b: LoopbackDevice) => {
    await meetDevices(a, b, settle)
  }
  const contact = (at: LoopbackDevice, name: string) => {
    const c = value(at.port.stores.contacts).find((x) => x.name === name)
    if (!c) throw new Error(`${name} is no contact`)
    return c
  }
  await meet(F, X)
  await meet(F, Y)
  const founded = await F.port.trust.foundGroup({ name: 'Garten' }).done
  if (!founded.ok) throw new Error('found')
  const groupId = founded.value.groupId
  const join = async (P: LoopbackDevice, name: string) => {
    if (!(await F.port.trust.invite(groupId, contact(F, name).id).done).ok) throw new Error('invite')
    await settle()
    const inv = value(P.port.stores.decisions).find((d) => d.kind === 'group-invite')
    if (!inv) throw new Error('no invitation')
    if (!(await P.port.trust.decide(inv.id, 'accept').done).ok) throw new Error('accept')
    await settle()
  }
  const run: Record<Step, () => Promise<void>> = {
    joinX: () => join(X, 'Xan'),
    joinY: () => join(Y, 'Yul'),
    meet: () => meet(X, Y),
    trustXY: async () => { await X.port.trust.giveTrust(contact(X, 'Yul').id).done; await settle() },
    trustYX: async () => { await Y.port.trust.giveTrust(contact(Y, 'Xan').id).done; await settle() },
  }
  for (const s of order) {
    await run[s]()
    clock.advance(60_000)
    await settle()
  }
  clock.advance(60_000)
  await settle()
  return { F, X, Y, groupId, contact }
}

/** what P's app shows of the group: who is named in the member list, and the graph's lines and dots */
function picture(P: LoopbackDevice, groupId: GroupId) {
  const detail = value(P.port.stores.group(groupId)) as GroupDetail
  const g = graphModel(graphInputOf(P.port)!)
  return {
    membership: detail.membership,
    named: detail.visibleMembers.filter((m) => !m.self).map((m) => m.contactId).filter((c) => c !== null).sort(),
    lines: g.memberships.map((m) => `${m.node}:${m.by}`).sort(),
    dots: g.hubs.find((h) => h.group === groupId)?.unknown,
  }
}

const ORDERS: readonly (readonly Step[])[] = [
  ['joinX', 'joinY', 'meet', 'trustXY', 'trustYX'],
  ['meet', 'trustXY', 'trustYX', 'joinX', 'joinY'],
  ['joinX', 'meet', 'trustXY', 'joinY', 'trustYX'],
  ['joinY', 'meet', 'trustYX', 'trustXY', 'joinX'],
]

describe('who sees whom in a group: the same picture whatever the order', () => {
  for (const [i, order] of ORDERS.entries()) {
    it(order.join(' → '), { timeout: 120_000 }, async () => {
      const { F, X, Y, groupId, contact } = await world(order, 211 + i * 10)
      // the two who know each other apart from the group: named in the list, a line by the log, no dot
      const all = (at: LoopbackDevice, a: string, b: string) => [contact(at, a).id, contact(at, b).id].sort()
      expect(picture(X, groupId)).toEqual({ membership: 'member', named: all(X, 'Fay', 'Yul'), lines: [...all(X, 'Fay', 'Yul').map((c) => `${c}:log`), 'me:log'].sort(), dots: 0 })
      expect(picture(Y, groupId)).toEqual({ membership: 'member', named: all(Y, 'Fay', 'Xan'), lines: [...all(Y, 'Fay', 'Xan').map((c) => `${c}:log`), 'me:log'].sort(), dots: 0 })
      expect(picture(F, groupId)).toEqual({ membership: 'member', named: all(F, 'Xan', 'Yul'), lines: [...all(F, 'Xan', 'Yul').map((c) => `${c}:log`), 'me:log'].sort(), dots: 0 })
    })
  }

  it('met and no trust: a line by the contact\'s word, the dot stays, nobody new is named', { timeout: 120_000 }, async () => {
    const { X, groupId, contact } = await world(['joinX', 'joinY', 'meet'], 301)
    expect(picture(X, groupId)).toEqual({ membership: 'member', named: [contact(X, 'Fay').id], lines: [`${contact(X, 'Fay').id}:log`, `${contact(X, 'Yul').id}:said`, 'me:log'].sort(), dots: 1 })
  })

  it('trust one way: the one who trusts is named at the other, not the other way round', { timeout: 120_000 }, async () => {
    const { X, Y, groupId, contact } = await world(['joinX', 'joinY', 'meet', 'trustXY'], 321)
    // X trusts Y: X proved to Y which member X is
    expect(picture(Y, groupId).named).toEqual([contact(Y, 'Fay').id, contact(Y, 'Xan').id].sort())
    expect(picture(Y, groupId).dots).toBe(0)
    expect(picture(X, groupId).named).toEqual([contact(X, 'Fay').id])
    expect(picture(X, groupId).dots).toBe(1)
  })
})
