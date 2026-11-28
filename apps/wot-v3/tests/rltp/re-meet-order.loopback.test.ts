// @vitest-environment node
// Commands on one person while its ids are joined (review 2 of #563; CONTACT-ORDER.md "A contact joined
// meanwhile"): the library chains a second meeting's fresh contact into the known one (Trust 6a.4), so a
// person can have commands taken under two ids, some before the chaining, some after. A command taken once
// the ids are one person is the person's, in the one queue. A command taken for the fresh contact and run
// only after the chaining was for the contact as it stood: it runs where it restricts, behind everything
// taken for the person until then, and ends without an act where it lifts or grants. Trust is refused for a
// blocked person when the command runs. An equal unordered gesture under the two ids is one act. Two
// persons never wait for each other. The runs of the review as their own tests, the rest generated.
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

describe('the runs of the review (Astra round 2)', () => {
  it('two sections started before the chaining: unblock(fresh) journaled and held before its act, block(known) taken and done before the chaining: the person ends blocked', async () => {
    const { w, fresh, known, chain } = await beforeChaining()
    const g = gate()
    let first: string | null = null
    w.A.faults.hold = async (p, actId) => {
      if (p !== 'act:before') return
      first ??= actId
      if (actId === first) await g.p
    }
    const h1 = issue(w.A, 'unblock', fresh)
    await turns(() => first !== null)
    // two persons still: the block goes through while the unblock waits
    const h2 = issue(w.A, 'block', known)
    expect((await h2.done).ok).toBe(true)
    await chain()
    g.open()
    w.A.faults.hold = null
    await h1.done
    await rest(w)
    expect(state(w.A, known).blocked).toBe(true)
  }, 120_000)

  it('unblock(fresh) journaled and held before its act, block(known) taken after the chaining: the person ends blocked', async () => {
    const { w, fresh, known, chain } = await beforeChaining()
    const g = gate()
    let first: string | null = null
    w.A.faults.hold = async (p, actId) => {
      if (p !== 'act:before') return
      first ??= actId
      if (actId === first) await g.p
    }
    const h1 = issue(w.A, 'unblock', fresh)
    await turns(() => first !== null)
    await chain()
    const h2 = issue(w.A, 'block', known)
    // the later block may wait for the earlier unblock; it is let go now
    g.open()
    w.A.faults.hold = null
    await Promise.all([h1.done, h2.done])
    await rest(w)
    expect(state(w.A, known).blocked).toBe(true)
  }, 120_000)

  for (const [g1, g2] of [['unblock', 'block'], ['block', 'unblock']] as const) {
    for (const recovery of ['automatic', 'at reopening'] as const) {
      it(`recovery with the same seq and time: ${g1}(fresh), ${g2}(known), both journaled and cut before their act; chained; recovered ${recovery}: the person ends blocked`, async () => {
        const { w, fresh, known, chain } = await beforeChaining()
        if (g1 === 'unblock') {
          expect((await issue(w.A, 'block', fresh).done).ok).toBe(true)
          await w.settle()
        }
        // both cut after their journal: the same seq (1, in two ids' queues), the same device time
        w.A.faults.killAt = 'after-journal'
        await issue(w.A, g1, fresh).done
        w.A.faults.killAt = 'after-journal'
        await issue(w.A, g2, known).done
        // their recovery held until the chaining is done
        const g = gate()
        w.A.faults.hold = async (p) => {
          if (p === 'act:before') await g.p
        }
        await chain()
        if (recovery === 'at reopening') {
          g.open()
          w.A.faults.hold = null
          await reopen(w.A)
        } else {
          g.open()
          w.A.faults.hold = null
        }
        await rest(w)
        await w.pass(70_000)
        // unblock(fresh) lifts nothing after the join; block(fresh) restricts and runs behind the unblock
        expect(state(w.A, known).blocked).toBe(true)
      }, 120_000)
    }
  }

  it('unblock(fresh) cut after its journal, block(known) done; its recovery and the chaining come on the same clock, nothing held: the person ends blocked', async () => {
    // the recovery reads what the contact stands for and acts in one turn with the holder's joining work
    // (contact-turn.ts): before the chaining it is the fresh contact's own unblock, after it nothing
    const { w, fresh, known, chain } = await beforeChaining()
    w.A.faults.killAt = 'after-journal'
    await issue(w.A, 'unblock', fresh).done
    expect((await issue(w.A, 'block', known).done).ok).toBe(true)
    await chain()
    await reopen(w.A)
    await rest(w)
    await w.pass(70_000)
    expect(state(w.A, known).blocked).toBe(true)
    expect(w.A.port.stores.intents.get().filter((i) => i.command === 'unblock')).toEqual([])
  }, 120_000)

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

// ── the class: generated runs over the ordered commands ──

/** A run: commands on one person, each under the fresh or the known id; the chaining falls before command
 *  `at`. The first command, where it comes under the fresh id before the chaining, may be left over: taken
 *  for the fresh contact, run only after the chaining (held before its journal or before its act, or cut
 *  after its journal and recovered at the next opening). Every other command before the chaining is done
 *  before the next is taken. */
interface Case { seq: Gesture[]; forms: ('fresh' | 'known')[]; at: number; left: 'none' | 'journal' | 'act' | 'crash' }

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
const RESTRICTS: readonly Gesture[] = ['block', 'withdrawTrust']
/** The end state by the contract (CONTACT-ORDER.md "A contact joined meanwhile"). Before the chaining the two
 *  ids are two contacts, each command acts on its own, and the chaining joins them blocked where one was
 *  (Message Tasks 6030). From then on the commands act on the one person in the order taken; trust is not
 *  given to a blocked person. A command left over from before the chaining runs behind everything taken
 *  until it runs where it restricts, and not at all where it lifts or grants. */
function model(c: Case): { blocked: boolean; given: boolean } {
  const leftOver = c.left !== 'none' && c.at >= 1 && c.forms[0] === 'fresh'
  const before = { fresh: false, known: false }
  for (let i = leftOver ? 1 : 0; i < c.at; i++) before[c.forms[i]!] = c.seq[i] === 'block'
  let blocked = before.fresh || before.known
  let given = false
  const run = (g: Gesture) => {
    if (g === 'block') blocked = true
    else if (g === 'unblock') blocked = false
    else if (g === 'withdrawTrust') given = false
    else if (!blocked) given = true
  }
  for (let i = c.at; i < c.seq.length; i++) run(c.seq[i]!)
  if (leftOver && RESTRICTS.includes(c.seq[0]!)) run(c.seq[0]!)
  return { blocked, given }
}
const CASES: Case[] = (() => {
  const r = rng(563)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const out: Case[] = []
  const ALL = ['block', 'unblock', 'giveTrust', 'withdrawTrust'] as const
  for (const left of ['none', 'journal', 'act', 'crash'] as const) {
    for (let k = 0; k < 8; k++) {
      const n = 2 + Math.floor(r() * 2)
      // the chaining before all (0, only without a left-over), after the first, or after the second command
      const at = left === 'none' ? [0, 1, 2][k % 3]! : [1, 2][k % 2]!
      // before the chaining block and unblock only (trust given to a contact before it is joined is the
      // library's merge of the settings, Trust 2160, not the order of commands); a left-over is any of the four
      const seq: Gesture[] = Array.from({ length: n }, (_, i) => (i === 0 && left !== 'none' ? ALL[k % 4]! : i < at ? pick(['block', 'unblock'] as const) : pick(ALL)))
      // a left-over comes under the fresh id; behind it, before the chaining, the known id (the fresh
      // contact's section is held by the left-over)
      const forms = seq.map((_, i) => (left !== 'none' ? (i === 0 ? 'fresh' : i < at ? 'known' : pick(['fresh', 'known'] as const)) : pick(['fresh', 'known'] as const)))
      out.push({ seq, forms, at: Math.min(at, n), left })
    }
  }
  return out
})()

describe('the commands on one person across its ids, the chaining anywhere between them (generated)', () => {
  for (const c of CASES) {
    const name = `chained before #${c.at + 1}, first ${c.left === 'none' ? 'done' : c.left === 'crash' ? 'cut after its journal' : `held before its ${c.left}`}: ${c.seq.map((g, i) => `${g}(${c.forms[i]})`).join(' → ')}`
    it(`${name}: the end state by the contract, none left open`, async () => {
      const { w, fresh, known, chain } = await beforeChaining()
      const idOf = (i: number) => (c.forms[i] === 'fresh' ? fresh : known)
      const handles: IntentHandle<void>[] = []
      const g = gate()
      let first: string | null = null
      if (c.left === 'journal') {
        w.A.faults.probe = async (p, actId) => {
          if (p !== 'dedupe:before') return
          first ??= actId
          if (actId === first) await g.p
        }
      }
      if (c.left === 'act') {
        w.A.faults.hold = async (p, actId) => {
          if (p !== 'act:before') return
          first ??= actId
          if (actId === first) await g.p
        }
      }
      for (let i = 0; i < c.seq.length; i++) {
        if (i === c.at) await chain()
        if (i === 0 && c.left === 'crash') w.A.faults.killAt = 'after-journal'
        handles.push(issue(w.A, c.seq[i]!, idOf(i)))
        if (i === 0 && c.left === 'crash') {
          await handles[0]!.done
          // its recovery is held until the chaining is done (a recovery before it is the command done in time)
          const cut = handles[0]!.actId
          w.A.faults.hold = async (p, actId) => {
            if (p === 'act:before' && actId === cut) await g.p
          }
        }
        else if (i === 0 && c.left !== 'none') await turns(() => first !== null)
        // each command before the chaining is done before the next is taken
        else if (i < c.at) await handles[i]!.done
      }
      if (c.at >= c.seq.length) await chain()
      // the commands behind a left-over are done before it is let go (it runs behind what was taken until then)
      if (c.left !== 'none') await Promise.all(handles.slice(1).map((h) => h.done))
      g.open()
      w.A.faults.probe = null
      w.A.faults.hold = null
      await Promise.all(handles.map((h) => h.done))
      if (c.left === 'crash') await reopen(w.A)
      await rest(w)
      await w.pass(70_000)
      expect(state(w.A, known), name).toEqual(model(c))
      // every command taken is finished (done, refused or superseded), nothing open
      expect(w.A.port.stores.intents.get().filter((i) => ['block', 'unblock', 'giveTrust', 'withdrawTrust'].includes(i.command)), name).toEqual([])
    }, 180_000)
  }
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
