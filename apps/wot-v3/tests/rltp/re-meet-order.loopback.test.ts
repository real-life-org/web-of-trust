// @vitest-environment node
// Commands on a person met again, once its ids are one person (review of #563; CONTACT-ORDER.md "A contact
// joined meanwhile"): trust is refused for a blocked person when the command runs, behind the gestures
// taken before it; an equal unordered gesture under the fresh and the known id is one act; a draft key that
// equals an alias stays a draft key; the encounter caches of a joined contact are its entry's; two persons
// never wait for each other.
import { describe, expect, it, vi } from 'vitest'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import type { AppDb } from '../../src/adapters/rltp/app-db'
import type { IntentRecord } from '../../src/adapters/rltp/journal'
import type { ContactId, GroupId, IntentHandle, MessageItem } from '../../src/port'
import { secret } from '../../src/port'
import { CARRIER_TICK_MS, memoryCarrier } from '../../src/adapters/rltp'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PASSPHRASE, LOOPBACK_PHRASES, loopbackDevice, type LoopbackDevice } from '../../harness/loopback'
import { contactsOf, conversationOf, detailOf, meetAgain, metTwice, onlyContact, secondCeremony, value, world, type World } from './re-meet.world'

// every app-db the devices open, to read and write the intent journal
const dbs: AppDb[] = []
vi.mock('../../src/adapters/rltp/app-db', async (original) => {
  const lib = await original<typeof AppDbModule>()
  return {
    ...lib,
    idbAppDb: (opts: Parameters<typeof lib.idbAppDb>[0]) => {
      const db = lib.idbAppDb(opts)
      dbs.push(db)
      return db
    },
  }
})
/** the journal of the device whose db holds `actId` */
async function journalOf(actId: string): Promise<{ db: AppDb; records: IntentRecord[] }> {
  for (const db of [...dbs].reverse()) {
    try {
      const snap = await db.readAll()
      if (snap.intents.has(actId)) return { db, records: [...snap.intents.values()] as IntentRecord[] }
    } catch {
      // a closed db (an ended opening)
    }
  }
  throw new Error(`no journal holds ${actId}`)
}

type Gesture = 'block' | 'unblock' | 'giveTrust' | 'withdrawTrust'
const issue = (d: LoopbackDevice, g: Gesture, id: ContactId): IntentHandle<void> =>
  g === 'block' || g === 'unblock' ? d.port.trust[g]({ kind: 'contact', contactId: id }) : d.port.trust[g](id)
const turns = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 0))
  if (!ok()) throw new Error('never reached')
}
/** a gate for the first time a point is reached: the caller releases it */
function gate() {
  let open: () => void = () => undefined
  const p = new Promise<void>((r) => (open = r))
  return { p, open }
}
async function reopen(d: LoopbackDevice) {
  await d.port.runtime.lock('user')
  expect((await d.port.runtime.unlock.passphrase(secret(LOOPBACK_PASSPHRASE))).ok).toBe(true)
  expect((await d.port.runtime.unlock.open()).ok).toBe(true)
}
const state = (d: LoopbackDevice, id: ContactId) => {
  const c = detailOf(d, id)
  return { blocked: c?.blocked, given: c?.trust.given }
}
/** a world with A and B met twice, the second meeting not chained yet: A's known contact and fresh contact */
async function beforeChaining() {
  const { w } = await metTwice({ first: 'shared-connect', second: 'carrier', scanner: 'A' }, 0)
  const fresh = secondCeremony(w.A)?.contactId as ContactId
  const known = contactsOf(w.A).map((c) => c.id).find((id) => id !== fresh) as ContactId
  expect(contactsOf(w.A).map((c) => c.id).sort()).toEqual([fresh, known].sort())
  /** device time until the second meeting is chained (the session's sections may be held: no idle of A) */
  const chain = async () => {
    await w.passHeld(3 * 60_000)
    expect(contactsOf(w.A).map((c) => c.id)).toEqual([known])
    expect(contactsOf(w.A)[0]?.aliases).toContain(fresh)
  }
  return { w, fresh, known, chain }
}
const rest = async (w: World) => {
  await w.settle()
  await w.pass(4 * CARRIER_TICK_MS)
}

describe('the runs of the review (round 2) on commands taken once the ids are one person', () => {
  it('block(known) and giveTrust(alias) right after each other: trust is not given to the blocked person', async () => {
    const { w, known, chain } = await beforeChaining()
    await chain()
    const alias = contactsOf(w.A)[0]!.aliases[0] as ContactId
    const h1 = issue(w.A, 'block', known)
    const h2 = issue(w.A, 'giveTrust', alias)
    expect((await h1.done).ok).toBe(true)
    expect(await h2.done).toMatchObject({ ok: false, error: { kind: 'refused', code: 'contact-blocked' } })
    await rest(w)
    expect(state(w.A, known)).toEqual({ blocked: true, given: false })
  }, 120_000)

  it('an invitation under the fresh id held before its journal, the same under the known id after the chaining: one act, one invitation', async () => {
    const { w, fresh, known, chain } = await beforeChaining()
    const founded = await w.A.port.trust.foundGroup({ name: 'Garten' }).done
    if (!founded.ok) throw new Error('found')
    await w.settle()
    const g = gate()
    let first: string | null = null
    w.A.faults.hold = async (p, actId) => {
      if (p !== 'journal:before') return
      first ??= actId
      if (actId === first) await g.p
    }
    const h1 = w.A.port.trust.invite(founded.value.groupId, fresh)
    await turns(() => first !== null)
    await chain()
    const h2 = w.A.port.trust.invite(founded.value.groupId, known)
    expect(h2.actId).toBe(h1.actId)
    g.open()
    w.A.faults.hold = null
    await Promise.all([h1.done, h2.done])
    await rest(w)
    const { records } = await journalOf(h1.actId)
    expect(records.filter((r) => r.command === 'invite')).toHaveLength(1)
    expect(value(w.B.port.stores.decisions).filter((d) => d.kind === 'group-invite')).toHaveLength(1)
  }, 120_000)
})

describe('a draft key that equals an alias stays a draft key (review round 3)', () => {
  it('a draft whose key equals the alias, sent under the alias and held, sent again under the known id: one message at B', async () => {
    const { w, fresh, known, chain } = await beforeChaining()
    await chain()
    const g = gate()
    let first: string | null = null
    w.A.faults.hold = async (p, actId) => {
      if (p !== 'act:before') return
      first ??= actId
      if (actId === first) await g.p
    }
    const h1 = w.A.port.trust.send(`c:${fresh}`, 'One draft', fresh)
    await turns(() => first !== null)
    const h2 = w.A.port.trust.send(`c:${known}`, 'One draft', fresh)
    expect(h2.actId).toBe(h1.actId)
    g.open()
    w.A.faults.hold = null
    await Promise.all([h1.done, h2.done])
    await rest(w)
    await w.pass(70_000)
    expect(conversationOf(w.B, onlyContact(w.B))?.items.filter((i): i is MessageItem => i.kind === 'message' && i.text === 'One draft')).toHaveLength(1)
  }, 120_000)
})

describe('the encounter caches of a joined contact are its entry’s', () => {
  for (const shower of ['Bea', 'Al'] as const) {
  it(`two cards of ${shower} a minute apart, both confirmations declined, chained: the second window stays offered until it ends`, async () => {
    const carrier = memoryCarrier()
    const clock = virtualClock(Date.now(), 'UTC')
    const P = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 81 })
    const Q = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 83 })
    // B shows its cards, A scans them; the confirmations and the counter-step are B's
    const [A, B] = shower === 'Bea' ? [P, Q] : [Q, P]
    const settle = async () => {
      for (let i = 0; i < 8; i++) {
        clock.advance(2000)
        await carrier.settled()
        await A.port.session()?.idle()
        await B.port.session()?.idle()
      }
    }
    /** the carrier's turns without device time: what is sent arrives, no duty comes due (no chaining yet) */
    const deliver = async () => {
      for (let i = 0; i < 8; i++) {
        await carrier.settled()
        await A.port.session()?.idle()
        await B.port.session()?.idle()
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    /** a card of B scanned by A, the confirmation at B declined before any device time passes */
    const scanDeclined = async (): Promise<number> => {
      const shown = await B.port.trust.showCard().done
      if (!shown.ok) throw new Error('show')
      expect((await A.port.trust.confirmCard(shown.value.qr).done).ok).toBe(true)
      await deliver()
      const open = value(B.port.stores.decisions).find((d) => d.kind === 'encounter-confirm' && d.state === 'open')
      if (!open || open.expiresAt === null) throw new Error('no confirmation at B')
      expect((await B.port.trust.decide(open.id, 'decline').done).ok).toBe(true)
      await deliver()
      return open.expiresAt
    }
    const end1 = await scanDeclined()
    for (let i = 0; i < 4; i++) await settle()
    clock.advance(60_000)
    const end2 = await scanDeclined()
    // the chaining, once device time passes
    for (let i = 0; i < 10; i++) await settle()
    const atB = value(B.port.stores.contacts)
    expect(atB).toHaveLength(1)
    expect(atB[0]!.aliases.length).toBeGreaterThan(0)
    expect(end2).toBeGreaterThan(end1)
    // past the first window, inside the second
    // (both confirmations are declined, so no duty of the library comes due at a window's end: the
    // availability is read from a fresh opening each time)
    clock.advance(end1 + 1000 - clock.now())
    await reopen(B)
    await settle()
    expect(clock.now()).toBeLessThan(end2)
    const offered = value(B.port.stores.contact(atB[0]!.id))?.actions.counterVerify
    // and past the second window it is known closed (not unknown, which would offer it on the edge alone)
    clock.advance(end2 + 1000 - clock.now())
    await reopen(B)
    await settle()
    const after = value(B.port.stores.contact(atB[0]!.id))?.actions.counterVerify
    expect({ offered, after }).toEqual({ offered: { ok: true }, after: { ok: false, reason: 'window-closed' } })
  }, 120_000)
  }

  it('met in the ceremony, then again over a card and confirmed: no sent card is offered any more, under the alias or the known id', async () => {
    const w = await world('B')
    // first: A shows the ceremony's code, B reads it
    await meetAgain(w.B, w.A, w.settle)
    await w.pass(60_000)
    const known = onlyContact(w.A)
    // again: B shows its card, A scans it (A keeps its sent card for the way back), B confirms
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    expect((await w.A.port.trust.confirmCard(shown.value.qr).done).ok).toBe(true)
    await w.settle()
    // chained before B confirms: A's fresh contact is an alias when the encounter becomes mutual
    await w.pass(3 * 60_000)
    expect(contactsOf(w.A).map((c) => c.id)).toEqual([known])
    const open = value(w.B.port.stores.decisions).find((d) => d.kind === 'encounter-confirm')
    if (open?.kind === 'encounter-confirm') expect((await w.B.port.trust.counterVerify(open.contactId).done).ok).toBe(true)
    await w.pass(60_000)
    const alias = contactsOf(w.A)[0]!.aliases[0] as ContactId
    expect(contactsOf(w.A)[0]?.verification).toBe('mutual')
    for (const id of [known, alias]) expect((await w.A.port.trust.sentCardFor(id)).ok, id === known ? 'known' : 'alias').toBe(false)
  }, 120_000)
})

// ── the unordered commands whose dedupe key names a contact: one act per gesture ──

describe('an equal gesture under the fresh and the known id is one act (invite, send)', () => {
  for (const cmd of ['invite', 'send'] as const) {
    for (const timing of ['before-accept', 'accept-journal', 'journal-act'] as const) {
      for (const crash of [false, true]) {
        it(`${cmd}, ${timing}${crash ? ' + crash: never two effects at B' : ': one effect at B'}`, async () => {
          const { w, fresh, known, chain } = await beforeChaining()
          let groupId: GroupId | null = null
          if (cmd === 'invite') {
            const founded = await w.A.port.trust.foundGroup({ name: 'Garten' }).done
            if (!founded.ok) throw new Error('found')
            groupId = founded.value.groupId
            await w.settle()
          }
          const gesture = (id: ContactId) => (cmd === 'invite' ? w.A.port.trust.invite(groupId!, id) : w.A.port.trust.send(`c:${id}`, 'Once more', 'd-1'))
          if (timing === 'before-accept') await chain()
          const g = gate()
          let first: string | null = null
          if (crash) w.A.faults.killAt = 'after-journal'
          if (timing !== 'before-accept' && !crash) {
            const point = timing === 'accept-journal' ? 'journal:before' : 'act:before'
            w.A.faults.hold = async (p, actId) => {
              if (p !== point) return
              first ??= actId
              if (actId === first) await g.p
            }
          }
          const h1 = gesture(fresh)
          if (timing !== 'before-accept') {
            if (crash) await h1.done
            else await turns(() => first !== null)
            await chain()
          }
          const h2 = gesture(known)
          g.open()
          w.A.faults.hold = null
          await Promise.all([h1.done, h2.done])
          if (crash) await reopen(w.A)
          await rest(w)
          await w.pass(70_000)
          const effects = cmd === 'invite' ? value(w.B.port.stores.decisions).filter((d) => d.kind === 'group-invite').length : (conversationOf(w.B, onlyContact(w.B))?.items.filter((i): i is MessageItem => i.kind === 'message' && i.text === 'Once more').length ?? 0)
          // a gesture cut between its journal and its act is never run blind (review 421 R10-1): then none,
          // never two; without a cut exactly one
          if (crash) expect(effects).toBeLessThanOrEqual(1)
          else expect(effects).toBe(1)
        }, 180_000)
      }
    }
  }
})

describe('two persons do not wait for each other', () => {
  it('a block on one person held before its act; a block on another goes through meanwhile', async () => {
    const w = await world(null, true)
    await meetAgain(w.A, w.B, w.settle)
    await meetAgain(w.A, w.C!, w.settle)
    await w.pass(60_000)
    const [bea, cem] = ['Bea', 'Cem'].map((n) => contactsOf(w.A).find((c) => c.name === n)!.id)
    const g = gate()
    let first: string | null = null
    w.A.faults.hold = async (p, actId) => {
      if (p !== 'act:before') return
      first ??= actId
      if (actId === first) await g.p
    }
    const h1 = issue(w.A, 'block', bea!)
    await turns(() => first !== null)
    const h2 = issue(w.A, 'block', cem!)
    let done2 = false
    void h2.done.then(() => (done2 = true))
    await turns(() => done2)
    expect((await h2.done).ok).toBe(true)
    g.open()
    w.A.faults.hold = null
    expect((await h1.done).ok).toBe(true)
  }, 120_000)
})
