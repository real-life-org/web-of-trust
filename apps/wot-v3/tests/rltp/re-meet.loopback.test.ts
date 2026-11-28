// @vitest-environment node
// Two phones that already know each other meet again in the connection ceremony (shared-connect), the
// app's one ceremony. The library opens a fresh contact for the second meeting (Encounter §4.4,
// fresh-always) and, once its continuity probe and mapping went back and forth, chains it into the known
// one (Trust §6a.4), the fresh id becoming an alias of the known entry (Trust 2140). Wanted: each side ends
// in the one contact it knew, named, with a channel, and everything that names the second meeting or an
// alias of it leads there: the ceremony's contact, its conversation, its details, the acts on it, and the
// verify flow's success and where it leaves to.
//
// Variants of the meeting: the first over the card of encounter-scan (the phone that shows it runs
// `ceremony: 'card'`) or over shared-connect; the second over the mediator (double) or over the back-code
// (both phones offline while they meet, online after); either phone scanning in the second meeting.
// Orders of the flow: the chaining before the success, after it before "close", after "close", and a
// restart between the meeting and the chaining.
import { describe, expect, it } from 'vitest'
import type { AppPort, Connection, ContactDetail, ContactId, Conversation, Loadable, ReadStore } from '../../src/port'
import { secret } from '../../src/port'
import type { FakeScanner } from '../../src/platform/fake'
import { virtualClock } from '../../src/platform/fake'
import { CARRIER_TICK_MS } from '../../src/adapters/rltp'
import { verify, verifyStart, type VerifyEvent, type VerifyState } from '../../src/flows/verify'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import { bundleEvent, verifyExecutor, verifyLifetime } from '../../src/hooks/verify'
import { LOOPBACK_PASSPHRASE, LOOPBACK_PHRASES, loopbackDevice, type LoopbackDevice } from '../../harness/loopback'
import { mediatorDouble, phoneNet } from '../../harness/mediator-double'

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

/** two phones over the mediator double; `card` names the phone that shows the card of encounter-scan */
async function world(card: 'A' | 'B' | null = null) {
  const med = mediatorDouble()
  const clock = virtualClock(Date.now(), 'UTC')
  const netA = phoneNet(med.net), netB = phoneNet(med.net)
  const ceremony = (id: 'A' | 'B') => (card === id ? ('card' as const) : ('shared-connect' as const))
  const A = await loopbackDevice({ carrier: { mediator: { did: med.did, net: netA.net } }, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 31, ceremony: ceremony('A') })
  const B = await loopbackDevice({ carrier: { mediator: { did: med.did, net: netB.net } }, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 37, ceremony: ceremony('B') })
  const online = (on: boolean) => {
    netA.setOnline(on)
    netB.setOnline(on)
    A.platform.network.set(on ? 'online' : 'offline')
    B.platform.network.set(on ? 'online' : 'offline')
  }
  const settle = async () => {
    let last = ''
    let calm = 0
    for (let i = 0; i < 400 && calm < 2; i++) {
      await med.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
      const busy = (A.port.session()?.transportBusy() ?? 0) + (B.port.session()?.transportBusy() ?? 0)
      const now = JSON.stringify([A.port.session()?.models()?.revision, B.port.session()?.models()?.revision, A.port.stores.connectivity.get(), B.port.stores.connectivity.get()])
      calm = busy === 0 && now === last ? calm + 1 : 0
      last = now
    }
    if (calm < 2) throw new Error('settle: the phones never came to rest')
  }
  /** device time for the carrier and the library's duties (continuity probe and mapping) */
  const pass = async (ms: number) => {
    for (let t = 0; t < ms; t += CARRIER_TICK_MS) {
      clock.advance(CARRIER_TICK_MS)
      await settle()
    }
  }
  return { A, B, online, settle, pass }
}
type World = Awaited<ReturnType<typeof world>>
type Known = { bAtA: ContactId; aAtB: ContactId }

const contactsOf = (d: LoopbackDevice) => value(d.port.stores.contacts)
/** the contact this phone holds of the other, once */
const onlyContact = (d: LoopbackDevice): ContactId => {
  const list = contactsOf(d)
  if (list.length !== 1) throw new Error(`expected one contact at ${d.id}, saw ${list.length}`)
  return list[0]!.id
}

/** the connection ceremony: S shows its code, R reads it with its camera and proposes, S accepts; over a
 *  carrier the proposal reaches S through it, without one R shows its back-code and S's camera reads it */
async function meetAgain(R: LoopbackDevice, S: LoopbackDevice, settle: () => Promise<void>): Promise<void> {
  const shown = await S.port.trust.showCard().done
  if (!shown.ok) throw new Error('show')
  await settle()
  const proposed = await R.port.trust.confirmCard(shown.value.qr, 'camera').done
  if (!proposed.ok || proposed.value.kind !== 'proposed') throw new Error('propose ' + JSON.stringify(proposed))
  await settle()
  const proposal = () => value(S.port.stores.decisions).find((d) => d.kind === 'connect-confirm' && d.state === 'open')
  if (!proposal()) {
    const back = await R.port.trust.showBackCode(proposed.value.connection).done
    if (!back.ok || back.value.kind !== 'shown') throw new Error('back-code ' + JSON.stringify(back))
    const read = await S.port.trust.readBackCode(back.value.qr)
    if (!read.ok || read.value.kind !== 'taken') throw new Error('read back-code ' + JSON.stringify(read))
    await settle()
  }
  const open = proposal()
  if (!open) throw new Error('no proposal at the shower')
  if (!(await S.port.trust.decide(open.id, 'accept').done).ok) throw new Error('accept')
  await settle()
}

/** the first meeting over the card of encounter-scan: the card phone shows, the other scans, the card
 *  phone confirms (the counter-step) */
async function meetOverCard(w: World, shower: LoopbackDevice): Promise<Known> {
  const scanner = shower === w.A ? w.B : w.A
  const shown = await shower.port.trust.showCard().done
  if (!shown.ok) throw new Error('card show')
  await w.settle()
  const r = await scanner.port.trust.confirmCard(shown.value.qr).done
  if (!r.ok) throw new Error('card scan ' + JSON.stringify(r))
  await w.settle()
  const open = value(shower.port.stores.decisions).find((d) => d.kind === 'encounter-confirm')
  if (!open || open.kind !== 'encounter-confirm') throw new Error('no confirmation at the card phone')
  if (!(await shower.port.trust.counterVerify(open.contactId).done).ok) throw new Error('counter-verify')
  await w.settle()
  return { bAtA: onlyContact(w.A), aAtB: onlyContact(w.B) }
}

/** the second meeting's ceremony on a phone: its newest */
const secondCeremony = (d: LoopbackDevice): Connection | undefined => value(d.port.stores.connections).at(-1)
const conversationOf = (d: LoopbackDevice, id: ContactId | null | undefined): Conversation | null =>
  id ? value(d.port.stores.conversation(`c:${id}`) as ReadStore<Loadable<Conversation>>) : null
const detailOf = (d: LoopbackDevice, id: ContactId): ContactDetail | null => value(d.port.stores.contact(id))

function report(d: LoopbackDevice) {
  const sc = secondCeremony(d)
  const conv = conversationOf(d, sc?.contactId)
  return {
    list: contactsOf(d).map((c) => ({ id: c.id, name: c.name, channel: c.channel, verification: c.verification, aliases: c.aliases })),
    connections: value(d.port.stores.connections).map((c) => ({ id: c.id, role: c.role, status: c.status, name: c.name, contactId: c.contactId })),
    secondCeremonyConversation: conv ? { key: conv.key, title: conv.title, composer: conv.composer } : null,
  }
}

/** the wanted end on one phone: one entry, the known one, named, carried; the second ceremony names it, and
 *  its conversation and details, read by the ceremony's contact and by every alias, are the known contact's */
function expectKnown(d: LoopbackDevice, other: string, known: ContactId, msg: string) {
  const list = contactsOf(d)
  expect(list.map((x) => x.id), `${d.id}: the list ${msg}`).toEqual([known])
  expect(list[0], `${d.id}: the entry ${msg}`).toMatchObject({ name: other, channel: true })
  expect(d.port.stores.connectivity.get().carriage[known], `${d.id}: carriage ${msg}`).toBe('routed')
  expect(secondCeremony(d)?.contactId, `${d.id}: the contact the second ceremony names ${msg}`).toBe(known)
  for (const id of [known, ...list[0]!.aliases]) {
    const conv = conversationOf(d, id)
    expect({ key: conv?.key, title: conv?.title, composer: conv?.composer }, `${d.id}: the conversation of ${id} ${msg}`).toEqual({ key: `c:${known}`, title: other, composer: { ok: true } })
    expect(detailOf(d, id), `${d.id}: the details of ${id} ${msg}`).toMatchObject({ id: known, name: other, channel: true })
  }
}

type First = 'card' | 'shared-connect'
const cases: Array<{ first: First; second: 'carrier' | 'back-code'; scanner: 'A' | 'B' }> = []
for (const first of ['card', 'shared-connect'] as const)
  for (const second of ['carrier', 'back-code'] as const)
    for (const scanner of ['A', 'B'] as const) cases.push({ first, second, scanner })

/** a world where the two met once and then again; the scanner of the second meeting is `scanner` */
async function metTwice(c: { first: First; second: 'carrier' | 'back-code'; scanner: 'A' | 'B' }, after = 3 * 60_000) {
  // the card phone is the one that does not show in the second meeting (it shows the connection code)
  const w = await world(c.first === 'card' ? c.scanner : null)
  const [R, S] = c.scanner === 'A' ? [w.A, w.B] : [w.B, w.A]
  if (c.first === 'card') await meetOverCard(w, R)
  else await meetAgain(w.A, w.B, w.settle)
  await w.pass(60_000)
  const known: Known = { bAtA: onlyContact(w.A), aAtB: onlyContact(w.B) }
  if (c.second === 'back-code') w.online(false)
  await w.settle()
  await meetAgain(R, S, w.settle)
  if (c.second === 'back-code') w.online(true)
  await w.settle()
  await w.pass(after)
  return { w, known }
}

describe('two phones that know each other meet again in the connection ceremony (port)', () => {
  for (const c of cases) {
    it(`first over the ${c.first}, again over the ${c.second}, ${c.scanner} scans: each side ends in the contact it knew`, async () => {
      const { w, known } = await metTwice(c)
      const msg = JSON.stringify({ A: report(w.A), B: report(w.B) }, null, 1)
      expectKnown(w.A, 'Bea', known.bAtA, msg)
      expectKnown(w.B, 'Al', known.aAtB, msg)
    }, 120_000)
  }

  it('the acts on an alias reach the known contact: a message, trust, an invitation to a group, a block', async () => {
    const { w, known } = await metTwice({ first: 'shared-connect', second: 'carrier', scanner: 'A' })
    const alias = contactsOf(w.A)[0]!.aliases[0]
    expect(alias, 'A holds the second meeting as an alias').toBeDefined()
    if (!alias) return
    // a message written into the alias's conversation (a screen that still holds the old id)
    expect((await w.A.port.trust.send(`c:${alias}`, 'Hello again', 'd-1').done).ok).toBe(true)
    await w.pass(CARRIER_TICK_MS)
    const atA = conversationOf(w.A, known.bAtA)?.items.filter((i) => i.kind === 'message').map((i) => (i.kind === 'message' ? i.text : ''))
    expect(atA).toContain('Hello again')
    const atB = conversationOf(w.B, known.aAtB)?.items.filter((i) => i.kind === 'message').map((i) => (i.kind === 'message' ? i.text : ''))
    expect(atB).toContain('Hello again')
    // trust given on the success screen, which may still hold the ceremony's first id
    expect((await w.A.port.trust.giveTrust(alias).done).ok).toBe(true)
    await w.settle()
    expect(detailOf(w.A, known.bAtA)?.trust.given).toBe(true)
    expect(detailOf(w.A, alias)?.actions.giveTrust).toEqual({ ok: false, reason: 'already-done' })
    // an invitation to a group
    const founded = await w.A.port.trust.foundGroup({ name: 'Garten' }).done
    if (!founded.ok) throw new Error('found')
    await w.settle()
    expect((await w.A.port.trust.invite(founded.value.groupId, alias).done).ok).toBe(true)
    await w.pass(CARRIER_TICK_MS)
    expect(value(w.B.port.stores.decisions).filter((d) => d.kind === 'group-invite')).toMatchObject([{ inviterId: known.aAtB, groupName: 'Garten' }])
    // a block
    expect((await w.A.port.trust.block({ kind: 'contact', contactId: alias }).done).ok).toBe(true)
    await w.settle()
    expect(detailOf(w.A, known.bAtA)?.blocked).toBe(true)
    expect(conversationOf(w.A, alias)?.composer).toEqual({ ok: false, reason: 'blocked' })
    expect((await w.A.port.trust.send(`c:${alias}`, 'not sent', 'd-2').done).ok).toBe(false)
  }, 120_000)

  it('a restart between the meeting and the chaining: after it, the ceremony and its first id lead to the known contact', async () => {
    const w = await world()
    await meetAgain(w.A, w.B, w.settle)
    await w.pass(60_000)
    const known: Known = { bAtA: onlyContact(w.A), aAtB: onlyContact(w.B) }
    await meetAgain(w.A, w.B, w.settle)
    const fresh = secondCeremony(w.A)?.contactId
    expect(fresh).not.toBe(known.bAtA)
    await w.A.port.runtime.lock('user')
    expect((await w.A.port.runtime.unlock.passphrase(secret(LOOPBACK_PASSPHRASE))).ok).toBe(true)
    expect((await w.A.port.runtime.unlock.open()).ok).toBe(true)
    await w.settle()
    await w.pass(3 * 60_000)
    const msg = JSON.stringify({ A: report(w.A), B: report(w.B) }, null, 1)
    expectKnown(w.A, 'Bea', known.bAtA, msg)
    expectKnown(w.B, 'Al', known.aAtB, msg)
    expect(conversationOf(w.A, fresh)?.key).toBe(`c:${known.bAtA}`)
  }, 120_000)
})

// ── the verify flow on both phones, as the screens run it (hooks/verify.ts) ──

/** the verify flow on a phone; `hold()` keeps the bundles from it until `release()` (a screen that comes
 *  back after the chaining) */
function flow(d: LoopbackDevice, port: AppPort = d.port) {
  const scans = { current: null as AbortController | null }
  const r = createFlowRunner(verify, verifyStart(), verifyExecutor(port, d.platform, scans, null), d.platform, { lifetime: verifyLifetime })
  let held = false
  const push = () => {
    if (held) return
    const e = bundleEvent(port)
    if (e) r.send(e)
  }
  port.stores.contacts.subscribe(push)
  port.stores.decisions.subscribe(push)
  port.stores.connections.subscribe(push)
  port.stores.connectivity.subscribe(push)
  r.subscribe(() => {
    if (r.get().name !== 'scanning') scans.current?.abort()
  })
  push()
  return {
    scanner: d.platform.scanner as FakeScanner,
    state: (): VerifyState => r.get(),
    send: (e: VerifyEvent) => r.send(e),
    rows: () => r.rows,
    hold: () => void (held = true),
    release: () => {
      held = false
      push()
    },
  }
}
type Flow = ReturnType<typeof flow>

/** the second meeting through both flows over the carrier: S shows, R scans and proposes, S accepts. With
 *  `hold`, both flows see no bundle after the acceptance until the caller releases them */
async function meetInFlows(w: World, R: LoopbackDevice, S: LoopbackDevice, hold = false) {
  const fr = flow(R)
  const fs = flow(S)
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 40 && !ok(); i++) {
      await w.settle()
      await new Promise((r) => setTimeout(r, 25))
    }
    for (let i = 0; i < 12 && !ok(); i++) await w.pass(CARRIER_TICK_MS)
    if (!ok()) throw new Error(`never ${what}: scanner ${fr.state().name}, shower ${fs.state().name}`)
  }
  await until(() => fs.state().name === 'ready' && !!fs.state().card && fr.state().name === 'ready', 'ready on both')
  const qr = fs.state().card?.qr ?? null
  fr.scanner.source = () => qr
  fr.send({ type: 'scan' })
  await until(() => fr.state().name === 'confirm', 'confirm at the scanner')
  fr.send({ type: 'yes' })
  await until(() => fs.state().name === 'connectIncoming', 'the proposal at the shower')
  if (hold) {
    fr.hold()
    fs.hold()
  }
  fs.send({ type: 'accept' })
  if (!hold) await until(() => fr.state().name === 'success' && fs.state().name === 'success', 'success on both')
  return { fr, fs, until }
}

const describeFlows = (f: Flow) => JSON.stringify({ state: f.state(), rows: f.rows() }, (k, v) => (k === 'qr' ? undefined : v))

describe('two phones that know each other meet again: the verify flow (port)', () => {
  for (const scanner of ['A', 'B'] as const) {
    it(`the chaining after the success, before "close" (${scanner} scans): the success turns to the known contact, re-met, and leaves to its conversation`, async () => {
      const w = await world()
      await meetAgain(w.A, w.B, w.settle)
      await w.pass(60_000)
      const known: Known = { bAtA: onlyContact(w.A), aAtB: onlyContact(w.B) }
      const [R, S] = scanner === 'A' ? [w.A, w.B] : [w.B, w.A]
      const knownAt = (d: LoopbackDevice) => (d === w.A ? known.bAtA : known.aAtB)
      const { fr, fs } = await meetInFlows(w, R, S)
      // the success comes before the chaining: a new contact for now
      expect(fr.state(), describeFlows(fr)).toMatchObject({ name: 'success', isNew: true })
      await w.pass(3 * 60_000)
      expect(fr.state(), `scanner ${describeFlows(fr)}`).toMatchObject({ name: 'success', contactId: knownAt(R), name2: S === w.A ? 'Al' : 'Bea', isNew: false })
      expect(fs.state(), `shower ${describeFlows(fs)}`).toMatchObject({ name: 'success', contactId: knownAt(S), name2: R === w.A ? 'Al' : 'Bea', isNew: false })
      fr.send({ type: 'done' })
      fs.send({ type: 'done' })
      expect(fr.state(), `scanner ${describeFlows(fr)}`).toMatchObject({ name: 'exit', to: 'chat', contactId: knownAt(R) })
      expect(fs.state(), `shower ${describeFlows(fs)}`).toMatchObject({ name: 'exit', to: 'chat', contactId: knownAt(S) })
    }, 120_000)
  }

  it('the chaining before the success reaches the flows: the success is the known contact, not new', async () => {
    const w = await world()
    await meetAgain(w.A, w.B, w.settle)
    await w.pass(60_000)
    const known: Known = { bAtA: onlyContact(w.A), aAtB: onlyContact(w.B) }
    const { fr, fs, until } = await meetInFlows(w, w.A, w.B, true)
    await w.pass(3 * 60_000)
    expect(contactsOf(w.A).map((c) => c.id)).toEqual([known.bAtA])
    fr.release()
    fs.release()
    await until(() => fr.state().name === 'success' && fs.state().name === 'success', 'success on both')
    expect(fr.state(), `scanner ${describeFlows(fr)}`).toMatchObject({ name: 'success', contactId: known.bAtA, isNew: false })
    expect(fs.state(), `shower ${describeFlows(fs)}`).toMatchObject({ name: 'success', contactId: known.aAtB, isNew: false })
    fr.send({ type: 'done' })
    expect(fr.state()).toMatchObject({ name: 'exit', to: 'chat', contactId: known.bAtA })
  }, 120_000)

  it('the chaining after "close": the conversation the flow left to becomes the known contact\'s', async () => {
    const w = await world()
    await meetAgain(w.A, w.B, w.settle)
    await w.pass(60_000)
    const known: Known = { bAtA: onlyContact(w.A), aAtB: onlyContact(w.B) }
    const { fr, fs } = await meetInFlows(w, w.A, w.B)
    fr.send({ type: 'done' })
    fs.send({ type: 'done' })
    const left = fr.state()
    const leftB = fs.state()
    if (left.name !== 'exit' || leftB.name !== 'exit') throw new Error('not left')
    await w.pass(3 * 60_000)
    expect(conversationOf(w.A, left.contactId), 'A').toMatchObject({ key: `c:${known.bAtA}`, title: 'Bea', composer: { ok: true } })
    expect(conversationOf(w.B, leftB.contactId), 'B').toMatchObject({ key: `c:${known.aAtB}`, title: 'Al', composer: { ok: true } })
  }, 120_000)
})
