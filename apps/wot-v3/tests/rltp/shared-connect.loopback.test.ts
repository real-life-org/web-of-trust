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
import { mediatorDouble } from '../../harness/mediator-double'

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
  const A = await loopbackDevice({ carrier: { mediator: med }, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 31 })
  const B = await loopbackDevice({ carrier: { mediator: med }, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 37 })
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
  return { med, clock, A, B, settle, tick }
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
    expect(shown.qr.startsWith('https://link.trustoverip.org/t#')).toBe(true)
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
    expect(cA?.verification).not.toBe('mutual')
    expect(value(w.A.port.stores.connections)).toMatchObject([{ status: 'complete', met: false }])
    expect(await w.A.port.trust.giveTrust(cA!.id).done).toEqual({ ok: false, error: { kind: 'refused', code: 'not-met' } })
  })
})
