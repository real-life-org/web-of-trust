// @vitest-environment node
// The connection ceremony (shared-connect 0.1) between two phones over the VTI mediator (double):
// the real adapter on the real library through the port. The shown code is the trigger link, the
// scanner's proposal is a decision at the shower, accepting completes both sides with a contact that
// is carried by the mediator (lib 0.17.0: the carrier offer in the ceremony), a message each way
// arrives; declining ends both sides without a contact.
import { describe, expect, it } from 'vitest'
import type { ContactId, Conversation, ConversationItem, Loadable, MessageItem, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { CARRIER_TICK_MS } from '../../src/adapters/rltp'
import { LOOPBACK_PHRASES, loopbackDevice, type LoopbackDevice } from '../../harness/loopback'
import { mediatorDouble, phoneNet } from '../../harness/mediator-double'

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}
const messages = (d: LoopbackDevice, id: ContactId): MessageItem[] =>
  value(d.port.stores.conversation(`c:${id}`) as ReadStore<Loadable<Conversation>>).items.filter((i: ConversationItem): i is MessageItem => i.kind === 'message')

async function world() {
  const med = mediatorDouble()
  const clock = virtualClock(Date.now(), 'UTC')
  // each phone on a network of its own below the wire, switched by `online`
  const netA = phoneNet(med.net), netB = phoneNet(med.net)
  const A = await loopbackDevice({ carrier: { mediator: { did: med.did, net: netA.net } }, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 31, ceremony: 'shared-connect' })
  const B = await loopbackDevice({ carrier: { mediator: { did: med.did, net: netB.net } }, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 37, ceremony: 'shared-connect' })
  const online = (d: LoopbackDevice, on: boolean) => {
    ;(d === A ? netA : netB).setOnline(on)
    d.platform.network.set(on ? 'online' : 'offline')
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
  const tick = async () => {
    clock.advance(CARRIER_TICK_MS)
    await settle()
  }
  return { med, clock, A, B, settle, tick, online }
}

/** B shows its code, A reads it with its camera and proposes; B's decision is open */
async function propose(w: Awaited<ReturnType<typeof world>>) {
  const shown = await w.B.port.trust.showCard().done
  if (!shown.ok) throw new Error('show')
  await w.settle()
  const preview = await w.A.port.trust.previewCard(shown.value.qr)
  const proposed = await w.A.port.trust.confirmCard(shown.value.qr, 'camera').done
  await w.settle()
  return { shown: shown.value, preview, proposed }
}

describe('the connection ceremony over the VTI mediator (double)', () => {
  it('the code is a trigger link with the name; the proposal opens a decision that answers the shown code; accepting connects both, carried, and messages arrive', async () => {
    const w = await world()
    const { shown, preview, proposed } = await propose(w)
    expect(shown.qr.startsWith('https://web-of-trust.de/t#')).toBe(true)
    expect(decodeURIComponent(shown.qr)).toContain('_type=https://link.trustoverip.org/vti/flow/shared-connect/0.1')
    expect(shown.expiresAt).toBeGreaterThan(w.clock.now())
    expect(preview).toEqual({ ok: true, value: { role: 'displayed', name: 'Bea', knownContact: null, self: false } })
    // the own code is recognised as such
    expect(await w.B.port.trust.previewCard(shown.qr)).toMatchObject({ ok: true, value: { self: true } })
    expect(proposed).toMatchObject({ ok: true, value: { kind: 'proposed', contactId: null } })
    expect(value(w.A.port.stores.connections)).toMatchObject([{ role: 'responder', status: 'open', name: 'Bea', contactId: null }])
    // the same code read again is spent
    expect(await w.A.port.trust.previewCard(shown.qr)).toEqual({ ok: false, error: { kind: 'refused', code: 'code-used' } })
    const [d] = value(w.B.port.stores.decisions)
    expect(d).toMatchObject({ kind: 'connect-confirm', name: 'Al', state: 'open', answers: { card: shown.card } })
    expect((await w.B.port.trust.decide(d!.id, 'accept').done).ok).toBe(true)
    await w.settle()
    await w.tick()
    expect(value(w.B.port.stores.decisions)).toEqual([])
    const [cA] = value(w.A.port.stores.contacts)
    const [cB] = value(w.B.port.stores.contacts)
    expect([cA?.verification, cB?.verification]).toEqual(['mutual', 'mutual'])
    expect(value(w.A.port.stores.connections)).toMatchObject([{ status: 'complete', contactId: cA!.id, met: true }])
    expect(value(w.B.port.stores.connections)).toMatchObject([{ status: 'complete', contactId: cB!.id, met: true }])
    // the relationship is carried by the mediator on both sides
    expect(w.A.port.stores.connectivity.get().carriage[cA!.id]).toBe('routed')
    expect(w.B.port.stores.connectivity.get().carriage[cB!.id]).toBe('routed')
    expect((await w.A.port.trust.send(`c:${cA!.id}`, 'Hello after the ceremony', 'd-1').done).ok).toBe(true)
    await w.settle()
    await w.tick()
    expect(messages(w.B, cB!.id).map((m) => m.text)).toEqual(['Hello after the ceremony'])
    expect((await w.B.port.trust.send(`c:${cB!.id}`, 'And back', 'd-2').done).ok).toBe(true)
    await w.settle()
    await w.tick()
    expect(messages(w.A, cA!.id).map((m) => m.text)).toEqual(['Hello after the ceremony', 'And back'])
    // trust toward a contact that met is given
    expect((await w.A.port.trust.giveTrust(cA!.id).done).ok).toBe(true)
  })

  it('declining tells the other side: both ceremonies end declined, no contact', async () => {
    const w = await world()
    await propose(w)
    const [d] = value(w.B.port.stores.decisions)
    expect((await w.B.port.trust.decide(d!.id, 'decline').done).ok).toBe(true)
    await w.settle()
    expect(value(w.A.port.stores.connections)).toMatchObject([{ status: 'declined' }])
    expect(value(w.B.port.stores.connections)).toMatchObject([{ status: 'declined' }])
    expect(value(w.A.port.stores.contacts)).toEqual([])
    expect(value(w.B.port.stores.contacts)).toEqual([])
  })

  it('without a carrier: two codes (the link, the back-code) and the confirmation leave both with one contact to trust and invite; once online the ceremony completes and the relationship is carried', async () => {
    const w = await world()
    for (const d of [w.A, w.B]) w.online(d, false)
    await w.settle()
    // B shows its code: the link carries B's card
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    expect(decodeURIComponent(shown.value.qr)).toContain('&csig=')
    // A reads it with its camera and proposes; nothing travels, no contact yet
    const proposed = await w.A.port.trust.confirmCard(shown.value.qr, 'camera').done
    if (!proposed.ok || proposed.value.kind !== 'proposed') throw new Error('propose')
    await w.settle()
    expect(value(w.A.port.stores.contacts)).toEqual([])
    // A shows its back-code: A's contact opens from B's card in the link
    const back = await w.A.port.trust.showBackCode(proposed.value.connection).done
    if (!back.ok) throw new Error('back ' + JSON.stringify(back))
    await w.settle()
    expect(back.value.qr.startsWith('https://web-of-trust.de/t#')).toBe(true)
    expect(decodeURIComponent(back.value.qr)).toContain('/vti/flow/shared-connect/0.1/back')
    const [cA] = value(w.A.port.stores.contacts)
    expect(cA).toBeDefined()
    expect(value(w.A.port.stores.connections)).toMatchObject([{ role: 'responder', status: 'open', contactId: cA!.id }])
    // the same code again, no second contact
    expect(await w.A.port.trust.showBackCode(proposed.value.connection).done).toEqual(back)
    // B's camera reads it: the confirmation that answers B's code, with A's name
    expect(await w.B.port.trust.previewCard(back.value.qr)).toEqual({ ok: true, value: { role: 'back', name: 'Al', knownContact: null, self: false } })
    expect(await w.B.port.trust.readBackCode(back.value.qr)).toEqual({ ok: true, value: { connection: shown.value.card } })
    await w.settle()
    expect(value(w.B.port.stores.contacts)).toEqual([])
    const [d] = value(w.B.port.stores.decisions)
    expect(d).toMatchObject({ kind: 'connect-confirm', name: 'Al', state: 'open', answers: { card: shown.value.card } })
    expect((await w.B.port.trust.decide(d!.id, 'accept').done).ok).toBe(true)
    await w.settle()
    const [cB] = value(w.B.port.stores.contacts)
    expect(value(w.B.port.stores.connections)).toMatchObject([{ role: 'inviter', status: 'open', contactId: cB!.id }])
    // both trust and invite into a group at once; a message waits for the other side's first document
    for (const [dev, c] of [[w.A, cA!], [w.B, cB!]] as const) {
      expect((await dev.port.trust.giveTrust(c.id).done).ok).toBe(true)
      const g = await dev.port.trust.foundGroup({ name: `group of ${dev.id}` }).done
      if (!g.ok) throw new Error('found')
      expect((await dev.port.trust.invite(g.value.groupId, c.id).done).ok).toBe(true)
    }
    await w.settle()
    expect(w.A.port.stores.connectivity.get().carriage[cA!.id]).toBe('no-hint')
    // a carrier comes: the acceptance, the credentials and the receipts complete the same ceremony
    for (const dev of [w.A, w.B]) w.online(dev, true)
    for (let i = 0; i < 6; i++) await w.tick()
    expect(value(w.A.port.stores.connections)).toMatchObject([{ status: 'complete', contactId: cA!.id, met: true }])
    expect(value(w.B.port.stores.connections)).toMatchObject([{ status: 'complete', contactId: cB!.id, met: true }])
    expect(value(w.A.port.stores.contacts).map((c) => c.id)).toEqual([cA!.id])
    expect(value(w.B.port.stores.contacts).map((c) => c.id)).toEqual([cB!.id])
    // the issue steps brought the hints: carried now, and messages arrive both ways
    expect(w.A.port.stores.connectivity.get().carriage[cA!.id]).toBe('routed')
    expect(w.B.port.stores.connectivity.get().carriage[cB!.id]).toBe('routed')
    expect((await w.A.port.trust.send(`c:${cA!.id}`, 'Hello, carried now', 'd-1').done).ok).toBe(true)
    await w.settle()
    await w.tick()
    expect(messages(w.B, cB!.id).map((m) => m.text)).toEqual(['Hello, carried now'])
    expect((await w.B.port.trust.send(`c:${cB!.id}`, 'And back', 'd-2').done).ok).toBe(true)
    await w.settle()
    await w.tick()
    expect(messages(w.A, cA!.id).map((m) => m.text)).toEqual(['Hello, carried now', 'And back'])
  })

  it('a code opened as a link does not count as met: the contact exists, trust is refused', async () => {
    const w = await world()
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    await w.settle()
    expect((await w.A.port.trust.confirmCard(shown.value.qr, 'url').done).ok).toBe(true)
    await w.settle()
    const [d] = value(w.B.port.stores.decisions)
    expect((await w.B.port.trust.decide(d!.id, 'accept').done).ok).toBe(true)
    await w.settle()
    await w.tick()
    const [cA] = value(w.A.port.stores.contacts)
    expect(cA).toMatchObject({ verification: 'link', channel: true })
    expect(value(w.A.port.stores.connections)).toMatchObject([{ status: 'complete', met: false }])
    // no trust toward it: the detail says so before the act, the core refuses the act
    expect(value(w.A.port.stores.contact(cA!.id))?.actions.giveTrust).toEqual({ ok: false, reason: 'not-verified' })
    expect(await w.A.port.trust.giveTrust(cA!.id).done).toEqual({ ok: false, error: { kind: 'refused', code: 'not-met' } })
  })
})
