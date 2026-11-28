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
import type { AppPort, ContactId, MessageItem } from '../../src/port'
import { secret } from '../../src/port'
import type { FakeScanner } from '../../src/platform/fake'
import { CARRIER_TICK_MS } from '../../src/adapters/rltp'
import { verify, verifyStart, type VerifyEvent, type VerifyState } from '../../src/flows/verify'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import { bundleEvent, verifyExecutor, verifyLifetime } from '../../src/hooks/verify'
import { LOOPBACK_PASSPHRASE, type LoopbackDevice } from '../../harness/loopback'
import { cases, contactsOf, conversationOf, detailOf, meetAgain, metTwice, onlyContact, secondCeremony, value, world, type Known, type World } from './re-meet.world'


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
      expect(fr.state(), `scanner ${describeFlows(fr)}`).toMatchObject({ name: 'success', contactId: knownAt(R), name2: S === w.A ? 'Al' : 'Bea', isNew: false, recognized: true })
      expect(fs.state(), `shower ${describeFlows(fs)}`).toMatchObject({ name: 'success', contactId: knownAt(S), name2: R === w.A ? 'Al' : 'Bea', isNew: false, recognized: true })
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
    expect(fr.state(), `scanner ${describeFlows(fr)}`).toMatchObject({ name: 'success', contactId: known.bAtA, isNew: false, recognized: true })
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

describe('the read mark of a person met again', () => {
  it('written over the alias’s route it is the entry’s: the unread count of the one conversation falls', async () => {
    const { w } = await metTwice({ first: 'shared-connect', second: 'carrier', scanner: 'A' }, 0)
    await w.pass(3 * 60_000)
    const known = onlyContact(w.A)
    const alias = contactsOf(w.A)[0]!.aliases[0] as ContactId
    expect((await w.B.port.trust.send(`c:${onlyContact(w.B)}`, 'Unread?', 'd-1').done).ok).toBe(true)
    await w.pass(2 * CARRIER_TICK_MS)
    // one conversation under both ids, the message in it
    const item = conversationOf(w.A, alias)?.items.filter((i): i is MessageItem => i.kind === 'message').at(-1)
    expect(item?.text).toBe('Unread?')
    expect(conversationOf(w.A, alias)?.key).toBe(`c:${known}`)
    expect(contactsOf(w.A)[0]?.conversation.unread).toBe(1)
    w.A.port.session()?.markRead(`c:${alias}`, item!.id)
    await w.settle()
    expect(contactsOf(w.A)[0]?.conversation.unread).toBe(0)
  }, 120_000)
})
