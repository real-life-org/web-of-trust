// The world of the re-meeting tests (re-meet*.loopback.test.ts): two phones over the mediator double that
// meet, once over the card of encounter-scan or the connection ceremony, and again in the ceremony. The
// library chains the second meeting's fresh contact into the known one after it (Trust 6a.4).
import type { Connection, ContactDetail, ContactId, Conversation, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { CARRIER_TICK_MS } from '../../src/adapters/rltp'
import { LOOPBACK_PHRASES, loopbackDevice, type LoopbackDevice } from '../../harness/loopback'
import { mediatorDouble, phoneNet } from '../../harness/mediator-double'

export const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

/** two phones over the mediator double; `card` names the phone that shows the card of encounter-scan */
export async function world(card: 'A' | 'B' | null = null) {
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
  /** device time while a gesture of A is held in its contact's section (A's `idle` waits for the sections):
   *  the doubles' turns, B's rest and macrotask turns, A's holder work runs meanwhile */
  const passHeld = async (ms: number) => {
    for (let t = 0; t < ms; t += CARRIER_TICK_MS) {
      clock.advance(CARRIER_TICK_MS)
      for (let i = 0; i < 40; i++) {
        await med.settled()
        await B.port.session()?.idle()
        await new Promise((r) => setTimeout(r, 0))
      }
    }
  }
  return { A, B, online, settle, pass, passHeld }
}
export type World = Awaited<ReturnType<typeof world>>
export type Known = { bAtA: ContactId; aAtB: ContactId }

export const contactsOf = (d: LoopbackDevice) => value(d.port.stores.contacts)
/** the contact this phone holds of the other, once */
export const onlyContact = (d: LoopbackDevice): ContactId => {
  const list = contactsOf(d)
  if (list.length !== 1) throw new Error(`expected one contact at ${d.id}, saw ${list.length}`)
  return list[0]!.id
}

/** the connection ceremony: S shows its code, R reads it with its camera and proposes, S accepts; over a
 *  carrier the proposal reaches S through it, without one R shows its back-code and S's camera reads it */
export async function meetAgain(R: LoopbackDevice, S: LoopbackDevice, settle: () => Promise<void>): Promise<void> {
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
export async function meetOverCard(w: World, shower: LoopbackDevice): Promise<Known> {
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
export const secondCeremony = (d: LoopbackDevice): Connection | undefined => value(d.port.stores.connections).at(-1)
export const conversationOf = (d: LoopbackDevice, id: ContactId | null | undefined): Conversation | null =>
  id ? value(d.port.stores.conversation(`c:${id}`) as ReadStore<Loadable<Conversation>>) : null
export const detailOf = (d: LoopbackDevice, id: ContactId): ContactDetail | null => value(d.port.stores.contact(id))

export type First = 'card' | 'shared-connect'
export const cases: Array<{ first: First; second: 'carrier' | 'back-code'; scanner: 'A' | 'B' }> = []
for (const first of ['card', 'shared-connect'] as const)
  for (const second of ['carrier', 'back-code'] as const)
    for (const scanner of ['A', 'B'] as const) cases.push({ first, second, scanner })

/** a world where the two met once and then again; the scanner of the second meeting is `scanner` */
export async function metTwice(c: { first: First; second: 'carrier' | 'back-code'; scanner: 'A' | 'B' }, after = 3 * 60_000) {
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

