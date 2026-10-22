// @vitest-environment node
// One model build per commit burst (architecture §3.1 collector): commits that arrive while a sync
// waits or runs join one follow-up; the published projection after rest is never older than the
// last commit (Anton 22.10., review 432).
import { describe, expect, it, vi } from 'vitest'
import type { ContactId, Conversation, ConversationItem, Loadable, MessageItem, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice } from '../../harness/loopback'

const probe = vi.hoisted(() => ({
  contacts: new Map<number, number>(),
  receives: new Map<number, number>(),
  holders: new Map<number, Record<string, unknown>>(),
  created: 0,
  /** the next contacts() read of this holder waits here: a build held while the burst commits */
  hold: null as null | { who: number; until: Promise<void>; reached: boolean },
}))
vi.mock('@real-life/trust-protocol', async (importOriginal) => {
  const real = await importOriginal<{ createHolder: (...a: unknown[]) => Promise<Record<string, unknown>> }>()
  return {
    ...real,
    createHolder: async (...args: unknown[]) => {
      const h = await real.createHolder(...args)
      const who = probe.created++
      const contacts = h.contacts as () => Promise<unknown>
      const receive = h.receive as (...a: unknown[]) => Promise<unknown>
      // the holder is frozen: a copy of its properties with a counting contacts()
      const ds = Object.getOwnPropertyDescriptors(h)
      for (const d of Object.values(ds)) d.configurable = true
      const w = Object.defineProperties({}, ds) as Record<string, unknown>
      Object.defineProperty(w, 'contacts', {
        value: async () => {
          probe.contacts.set(who, (probe.contacts.get(who) ?? 0) + 1)
          const hold = probe.hold
          if (hold?.who === who && !hold.reached) {
            hold.reached = true
            await hold.until
          }
          return contacts()
        },
      })
      Object.defineProperty(w, 'receive', {
        value: async (...a: unknown[]) => {
          const r = await receive(...a)
          probe.receives.set(who, (probe.receives.get(who) ?? 0) + 1)
          return r
        },
      })
      probe.holders.set(who, w)
      return w
    },
  }
})

const T0 = Date.parse('2026-10-15T13:30:00-07:00')

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}
const messages = (d: LoopbackDevice, id: ContactId): MessageItem[] =>
  value(d.port.stores.conversation(`c:${id}`) as ReadStore<Loadable<Conversation>>).items.filter((i: ConversationItem): i is MessageItem => i.kind === 'message')

async function world() {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'America/Los_Angeles')
  const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 13 })
  const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 19 })
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw new Error('show')
  if (!(await A.port.trust.confirmCard(shown.value.qr).done).ok) throw new Error('scan')
  await settle()
  const bId = value(B.port.stores.contacts)[0]!.id
  await B.port.trust.counterVerify(bId).done
  await settle()
  return { carrier, clock, A, B, settle, aId: value(A.port.stores.contacts)[0]!.id, bId }
}

describe('sync coalescing', () => {
  it('a burst of commits during a build joins one follow-up: exactly one build plus one follow-up', async () => {
    const w = await world()
    const N = 6
    w.carrier.setOnline('B', false)
    for (let i = 0; i < N; i++) await w.A.port.trust.send(`c:${w.aId}`, `message ${i}`, `draft-${i}`).done
    await w.settle()
    // B's holder is the second one created. Its first build after going online is held at its first
    // read until every message of the burst is committed and the carrier is at rest: the burst lands
    // while that build runs, whatever the machine's speed (no turn count or wall time decides it)
    let release!: () => void
    probe.hold = { who: 1, until: new Promise<void>((r) => (release = r)), reached: false }
    const before = probe.contacts.get(1) ?? 0
    const received = probe.receives.get(1) ?? 0
    w.carrier.setOnline('B', true)
    await vi.waitFor(() => expect(probe.hold?.reached).toBe(true))
    await vi.waitFor(() => expect((probe.receives.get(1) ?? 0) - received).toBe(N))
    await w.carrier.settled()
    release()
    probe.hold = null
    await w.settle()
    const reads = (probe.contacts.get(1) ?? 0) - before
    // the projection after rest shows every message of the burst
    expect(messages(w.B, w.bId).map((m) => m.text).sort()).toEqual(Array.from({ length: N }, (_, i) => `message ${i}`).sort())
    // the held build: its first attempt fails the fence (the burst committed meanwhile), its second
    // reads everything and takes the messages over; the N commits of the burst and the take-over's
    // commit joined one follow-up, which builds once. Without the joining it is one build per commit
    expect(reads).toBe(3)
    // after rest the projection shows the holder's last commit: a commit that came during a build got
    // its follow-up (round 9 R1)
    const shown = Number(w.B.port.session()!.models()!.revision.split(':')[1])
    const seq = Number(((await (probe.holders.get(1)!.profile as () => Promise<{ commitSeq: unknown }>)()).commitSeq))
    expect(shown).toBe(seq)
  })
})
