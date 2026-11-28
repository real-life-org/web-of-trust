// @vitest-environment node
// The commands on a person met again (Trust 6a.4, 2140): once the library chained the second meeting's
// fresh contact into the known one, the fresh id is an alias of the known entry. Every command that takes a
// contact id acts on the entry, whatever id it was given: commands on one person run in one order and two
// equal gestures are one act; a read mark set over the alias's route counts; a message held under the
// alias goes out once the entry can be written to; trust is not given to a blocked person; the first
// meeting stays the first.
import { describe, expect, it } from 'vitest'
import type { ContactId, IntentHandle, MessageItem } from '../../src/port'
import { CARRIER_TICK_MS } from '../../src/adapters/rltp'
import type { LoopbackDevice } from '../../harness/loopback'
import { contactsOf, conversationOf, detailOf, metTwice, secondCeremony, value, world, meetAgain, onlyContact } from './re-meet.world'

type Gesture = 'block' | 'unblock'
const act = (d: LoopbackDevice, g: Gesture, id: ContactId): IntentHandle<void> => d.port.trust[g]({ kind: 'contact', contactId: id })
const blocked = (d: LoopbackDevice, id: ContactId) => detailOf(d, id)?.blocked

/** holds the first ordered gesture of `d` at its dedupe read (before anything of it is journaled) */
function holdFirst(d: LoopbackDevice) {
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  let first: string | null = null
  d.faults.probe = async (p, actId) => {
    if (p !== 'dedupe:before') return
    first ??= actId
    if (actId === first) await gate
  }
  return {
    held: () => first !== null,
    release: () => {
      release()
      d.faults.probe = null
    },
  }
}
const turns = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 0))
  if (!ok()) throw new Error('never held')
}

/** a world where the two met twice and the second meeting is chained: A's known contact and its alias */
async function chained() {
  const { w, known } = await metTwice({ first: 'shared-connect', second: 'carrier', scanner: 'A' })
  const alias = contactsOf(w.A)[0]?.aliases[0] as ContactId | undefined
  if (!alias) throw new Error('no alias at A')
  return { w, known: known.bAtA, alias }
}

describe('commands on one person under its alias and its known id run in one order (contact order)', () => {
  const pairs: Array<[Gesture, Gesture]> = [
    ['unblock', 'block'],
    ['block', 'unblock'],
  ]
  for (const [g1, g2] of pairs) {
    for (const f1 of ['alias', 'known'] as const) {
      for (const f2 of ['alias', 'known'] as const) {
        it(`chained before: ${g1}(${f1}) held before its journal, ${g2}(${f2}) taken after it: the last gesture taken holds`, async () => {
          const { w, known, alias } = await chained()
          const id = (f: 'alias' | 'known') => (f === 'alias' ? alias : known)
          if (g1 === 'unblock') {
            expect((await act(w.A, 'block', known).done).ok).toBe(true)
            await w.settle()
          }
          const hold = holdFirst(w.A)
          const h1 = act(w.A, g1, id(f1))
          await turns(hold.held)
          const h2 = act(w.A, g2, id(f2))
          hold.release()
          await Promise.all([h1.done, h2.done])
          await w.settle()
          await w.pass(4 * CARRIER_TICK_MS)
          expect(blocked(w.A, known), `${g1}(${f1}) then ${g2}(${f2})`).toBe(g2 === 'block')
        }, 120_000)
      }
    }
  }

  it('two blocks of the same person at once, under the alias and the known id, are one act', async () => {
    const { w, known, alias } = await chained()
    const h1 = act(w.A, 'block', alias)
    const h2 = act(w.A, 'block', known)
    expect(h2.actId).toBe(h1.actId)
    await Promise.all([h1.done, h2.done])
    await w.settle()
    expect(blocked(w.A, known)).toBe(true)
  }, 120_000)
})

describe('a gesture after the chaining is the person’s own, never joined to an older one taken for the fresh contact (review: CodeRabbit)', () => {
  it('block(known), block(fresh), unblock(known) pending; the chaining; block(known): a new gesture, not the older block under the fresh id; the person ends blocked', async () => {
    const { w } = await metTwice({ first: 'shared-connect', second: 'carrier', scanner: 'A' }, 0)
    const fresh = secondCeremony(w.A)?.contactId as ContactId
    const known = contactsOf(w.A).map((c) => c.id).find((id) => id !== fresh) as ContactId
    // every ordered gesture of A held at its dedupe read until released
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    let reached = 0
    w.A.faults.probe = async (p) => {
      if (p !== 'dedupe:before') return
      reached++
      await gate
    }
    const h1 = act(w.A, 'block', known)
    const h2 = act(w.A, 'block', fresh)
    const h3 = act(w.A, 'unblock', known)
    await turns(() => reached >= 2)
    await w.passHeld(3 * 60_000)
    expect(contactsOf(w.A).map((c) => c.id)).toEqual([known])
    const h4 = act(w.A, 'block', known)
    expect(h4.actId).not.toBe(h2.actId)
    release()
    w.A.faults.probe = null
    await Promise.all([h1.done, h2.done, h3.done, h4.done])
    await w.settle()
    await w.pass(4 * CARRIER_TICK_MS)
    expect(blocked(w.A, known)).toBe(true)
  }, 120_000)
})

describe('a message sent again under the known id while its send under the fresh id runs (review: CodeRabbit)', () => {
  it('the same draft and text join the running send, not refused; it arrives once', async () => {
    const { w } = await metTwice({ first: 'shared-connect', second: 'carrier', scanner: 'A' }, 0)
    const fresh = secondCeremony(w.A)?.contactId as ContactId
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    let held = false
    w.A.faults.hold = async (p) => {
      if (p !== 'act:before' || held) return
      held = true
      await gate
    }
    const h1 = w.A.port.trust.send(`c:${fresh}`, 'Once', 'd-once')
    await turns(() => held)
    await w.passHeld(3 * 60_000)
    const known = onlyContact(w.A)
    expect(known).not.toBe(fresh)
    const h2 = w.A.port.trust.send(`c:${known}`, 'Once', 'd-once')
    expect(h2.actId).toBe(h1.actId)
    release()
    w.A.faults.hold = null
    expect((await h1.done).ok).toBe(true)
    expect((await h2.done).ok).toBe(true)
    await w.settle()
    await w.pass(2 * CARRIER_TICK_MS)
    const atB = conversationOf(w.B, onlyContact(w.B))?.items.filter((i): i is MessageItem => i.kind === 'message').map((i) => i.text)
    expect(atB?.filter((t) => t === 'Once')).toEqual(['Once'])
  }, 120_000)
})

describe('trust is not given to a blocked person, under any id', () => {
  it('blocked, then met again: giving trust under the known id and under the alias is refused, nothing given', async () => {
    const { w, known, alias } = await chained()
    expect((await act(w.A, 'block', known).done).ok).toBe(true)
    await w.settle()
    expect(detailOf(w.A, known)?.actions.giveTrust).toEqual({ ok: false, reason: 'blocked' })
    for (const id of [known, alias]) {
      const r = await w.A.port.trust.giveTrust(id).done
      expect(r, id === known ? 'known id' : 'alias').toMatchObject({ ok: false })
    }
    await w.settle()
    expect(detailOf(w.A, known)?.trust.given).toBe(false)
  }, 120_000)
})

describe('reads and held messages over the alias', () => {
  it('a read mark written over the alias’s route lowers the unread count', async () => {
    const { w, known, alias } = await chained()
    const atB = onlyContact(w.B)
    expect((await w.B.port.trust.send(`c:${atB}`, 'Unread?', 'd-1').done).ok).toBe(true)
    await w.pass(2 * CARRIER_TICK_MS)
    const item = conversationOf(w.A, known)?.items.filter((i): i is MessageItem => i.kind === 'message').at(-1)
    expect(item?.text).toBe('Unread?')
    expect(contactsOf(w.A)[0]?.conversation.unread).toBe(1)
    w.A.port.session()?.markRead(`c:${alias}`, item!.id)
    await w.settle()
    expect(contactsOf(w.A)[0]?.conversation.unread).toBe(0)
  }, 120_000)

  it('a message held under the fresh id (no channel yet) goes out once the entry it joined can be written to', async () => {
    // the second meeting over the back-code, both offline: the scanner's fresh contact opens from the code
    const w = await world()
    await meetAgain(w.A, w.B, w.settle)
    await w.pass(60_000)
    const known = onlyContact(w.A)
    w.online(false)
    await w.settle()
    await meetAgain(w.A, w.B, w.settle)
    const fresh = secondCeremony(w.A)?.contactId as ContactId
    expect(fresh).not.toBe(known)
    const sent = await w.A.port.trust.send(`c:${fresh}`, 'Held for now', 'd-held').done
    const line = conversationOf(w.A, fresh)?.items.filter((i): i is MessageItem => i.kind === 'message').find((i) => i.text === 'Held for now')
    // reached only where the fresh contact cannot be written to yet: the line is held
    expect({ sent: sent.ok, delivery: line?.delivery }).toMatchObject({ delivery: { phase: 'held', reason: 'not-ready' } })
    w.online(true)
    await w.settle()
    await w.pass(3 * 60_000)
    expect(contactsOf(w.A).map((c) => c.id)).toEqual([known])
    const atB = conversationOf(w.B, onlyContact(w.B))?.items.filter((i): i is MessageItem => i.kind === 'message').map((i) => i.text)
    expect(atB).toContain('Held for now')
  }, 120_000)
})

describe('the first meeting stays the first', () => {
  it('two meetings in the connection ceremony: met at the first, last met at the second', async () => {
    const w = await world()
    await meetAgain(w.A, w.B, w.settle)
    const first = value(w.A.port.stores.connections)[0]?.closedAt
    await w.pass(10 * 60_000)
    await meetAgain(w.A, w.B, w.settle)
    await w.pass(3 * 60_000)
    const second = value(w.A.port.stores.connections).at(-1)?.closedAt
    const d = detailOf(w.A, onlyContact(w.A))
    expect(first).toBeTypeOf('number')
    expect(second).toBeGreaterThan(first!)
    expect({ metAt: d?.metAt, lastMetAt: d?.lastMetAt }).toEqual({ metAt: first, lastMetAt: second })
  }, 120_000)
})
