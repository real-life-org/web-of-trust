// @vitest-environment node
// Two phones over the VTI mediator (TRANSPORT.md "The VTI mediator"): the real adapter on the real
// library, the real wire and the library's MediatorCarrierAdapter per relationship, the mediator double
// below (real TSP and DIDComm crypto, faked network). The encounter with delivery hints, a message
// each way, a block; documents to a relationship without hints stay in custody.
import { describe, expect, it } from 'vitest'
import type { ContactId, Conversation, ConversationItem, Loadable, MessageItem, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { CARRIER_TICK_MS } from '../../src/adapters/rltp'
import { decodeCardLink } from '../../src/adapters/rltp/card-link'
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
  // the device clock runs at the mediator's time: the double issues tokens on its own (real) clock
  const clock = virtualClock(Date.now(), 'UTC')
  const A = await loopbackDevice({ carrier: { mediator: med }, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 31 })
  const B = await loopbackDevice({ carrier: { mediator: med }, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 37 })
  /** until both phones rest: the double's turns done, the sessions idle, no carrier work in flight, and
   *  the published revisions unchanged over two rounds; a pair that never rests fails loudly */
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
  /** one carrier tick of device time on both phones */
  const tick = async () => {
    clock.advance(CARRIER_TICK_MS)
    await settle()
  }
  return { med, clock, A, B, settle, tick }
}

/** B shows, A scans (A's card carries its hint), A shows its sent card, B captures it optically */
async function meet(w: Awaited<ReturnType<typeof world>>) {
  const shown = await w.B.port.trust.showCard().done
  if (!shown.ok) throw new Error('show')
  const scanned = await w.A.port.trust.confirmCard(shown.value.qr).done
  if (!scanned.ok) throw new Error('scan')
  await w.settle()
  const aId = value(w.A.port.stores.contacts)[0]!.id
  const sent = await w.A.port.trust.sentCardFor(aId)
  if (!sent.ok) throw new Error('sent card')
  const captured = await w.B.port.trust.confirmCard(sent.value.qr).done
  if (!captured.ok) throw new Error('capture')
  await w.settle()
  await w.tick()
  const bId = value(w.B.port.stores.contacts)[0]!.id
  return { aId, bId, shownQr: shown.value.qr, sentQr: sent.value.qr }
}

describe('two phones over the VTI mediator (double)', () => {
  it('the cards carry each side’s delivery hint for C; both relationships are carried routed; a message each way is delivered; a block holds', async () => {
    const w = await world()
    const { aId, bId, shownQr, sentQr } = await meet(w)
    // the displayed card and the sent card each carry one hint of the profile for C
    for (const qr of [shownQr, sentQr]) {
      const hints = decodeCardLink(qr)?.deliveryHints as string[]
      expect(hints).toHaveLength(1)
      expect(JSON.parse(hints[0]!)).toMatchObject({ type: 'TSPTransport', serviceEndpoint: w.med.did })
    }
    expect(w.A.port.stores.connectivity.get().carriage[aId]).toBe('routed')
    expect(w.B.port.stores.connectivity.get().carriage[bId]).toBe('routed')
    // the bundle waited at the mediator until B knew A's identities (optical leg), then arrived
    expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ name: 'Al' })
    const counter = await w.B.port.trust.counterVerify(bId).done
    expect(counter.ok).toBe(true)
    await w.settle()
    await w.tick()
    expect(value(w.A.port.stores.contacts)[0]?.verification).toBe('mutual')
    expect(value(w.B.port.stores.contacts)[0]?.verification).toBe('mutual')

    expect((await w.A.port.trust.send(`c:${aId}`, 'Hello over the mediator', 'd-1').done).ok).toBe(true)
    await w.settle()
    await w.tick()
    expect(messages(w.B, bId).map((m) => m.text)).toEqual(['Hello over the mediator'])
    expect(messages(w.A, aId)[0]?.delivery).toEqual({ phase: 'delivered', late: false })
    expect((await w.B.port.trust.send(`c:${bId}`, 'And back', 'd-2').done).ok).toBe(true)
    await w.settle()
    await w.tick()
    expect(messages(w.A, aId).map((m) => m.text)).toEqual(['Hello over the mediator', 'And back'])
    expect(messages(w.B, bId).find((m) => m.text === 'And back')?.delivery).toEqual({ phase: 'delivered', late: false })
    // every frame went routed: outer connection DID → C, nothing on an egress session
    expect(w.med.forwarded.length).toBeGreaterThan(0)
    expect(w.med.direct).toEqual([])
    expect(w.A.port.stores.connectivity.get()).toMatchObject({ carrier: 'connected', queued: 0, open: 0 })

    // B blocks A: A's next message is processed by B and not shown
    expect((await w.B.port.trust.block({ kind: 'contact', contactId: bId }).done).ok).toBe(true)
    await w.settle()
    await w.A.port.trust.send(`c:${aId}`, 'after the block', 'd-3').done
    await w.settle()
    await w.tick()
    expect(messages(w.B, bId).map((m) => m.text)).not.toContain('after the block')
  }, 30_000)
})
