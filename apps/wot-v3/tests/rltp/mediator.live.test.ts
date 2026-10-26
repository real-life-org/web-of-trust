// @vitest-environment node
// Two phones against a TSP 1.0 mediator (live, real network): the real adapter, the real wire, the
// library's mediator adapter. Runs only with RLTP_LIVE_MEDIATOR=1 and MEDIATOR_DID (a 1.0 instance;
// MEDIATOR_ALLOW_INSECURE=1 admits a local one on plaintext loopback endpoints); otherwise skipped. Prints no identifiers, tokens or keys. Waits are for the network: each condition is
// awaited until it holds, at most LIVE_WAIT_MS of real time.
import { describe, expect, it } from 'vitest'
import type { ContactId, Conversation, ConversationItem, Loadable, MessageItem, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, type LoopbackDevice } from '../../harness/loopback'

const LIVE = process.env.RLTP_LIVE_MEDIATOR === '1'
/** a TSP 1.0 mediator (0.45 or later); there is no default (the storm.ws dev instance runs 0.44, Rev 3) */
const DID = process.env.MEDIATOR_DID ?? ''
/** a local instance on plaintext loopback endpoints */
const NET = process.env.MEDIATOR_ALLOW_INSECURE ? { net: { policy: { allowInsecure: true, allowPrivate: true } } } : {}
const LIVE_WAIT_MS = 20_000

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}
const messages = (d: LoopbackDevice, id: ContactId): MessageItem[] =>
  value(d.port.stores.conversation(`c:${id}`) as ReadStore<Loadable<Conversation>>).items.filter((i: ConversationItem): i is MessageItem => i.kind === 'message')

describe.skipIf(!LIVE)('two phones against the live VTI mediator', () => {
  it('encounter with hints, the optical leg, a message each way, delivered', async () => {
    if (!DID) throw new Error('live: MEDIATOR_DID names the TSP 1.0 mediator (0.45 or later)')
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await loopbackDevice({ carrier: { mediator: { did: DID, ...NET } }, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 41 })
    const B = await loopbackDevice({ carrier: { mediator: { did: DID, ...NET } }, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 43 })
    /** a condition awaited over the network; the mediator's tokens are on the real clock */
    const until = async (what: string, ok: () => boolean) => {
      const t0 = Date.now()
      while (!ok()) {
        if (Date.now() - t0 > LIVE_WAIT_MS) throw new Error(`live: no ${what} within ${LIVE_WAIT_MS} ms`)
        await new Promise((r) => setTimeout(r, 250))
        // the device clock follows the real one: its timers (the carrier tick) run as on a device
        clock.set(Date.now())
        await A.port.session()?.idle()
        await B.port.session()?.idle()
      }
      return Date.now() - t0
    }
    const timings: Record<string, number> = {}
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show ' + JSON.stringify(shown))
    const scanned = await A.port.trust.confirmCard(shown.value.qr).done
    if (!scanned.ok) throw new Error('scan')
    const aId = value(A.port.stores.contacts)[0]!.id
    timings.carried = await until('carried relationship at A', () => A.port.stores.connectivity.get().carriage[aId] === 'routed')
    const sent = await A.port.trust.sentCardFor(aId)
    if (!sent.ok) throw new Error('sent card')
    expect((await B.port.trust.confirmCard(sent.value.qr).done).ok).toBe(true)
    const bId = value(B.port.stores.contacts)[0]!.id
    timings.bundle = await until('bundle at B', () => value(A.port.stores.contacts)[0]?.verification === 'outgoing' && B.port.stores.connectivity.get().carriage[bId] === 'routed')
    expect((await B.port.trust.counterVerify(bId).done).ok).toBe(true)
    timings.mutual = await until('mutual at A', () => value(A.port.stores.contacts)[0]?.verification === 'mutual')
    expect((await A.port.trust.send(`c:${aId}`, 'live: A to B', 'live-1').done).ok).toBe(true)
    timings.deliveredAB = await until('delivered A→B', () => messages(A, aId)[0]?.delivery?.phase === 'delivered')
    expect(messages(B, bId).map((m) => m.text)).toContain('live: A to B')
    expect((await B.port.trust.send(`c:${bId}`, 'live: B to A', 'live-2').done).ok).toBe(true)
    timings.deliveredBA = await until('delivered B→A', () => messages(B, bId).find((m) => m.text === 'live: B to A')?.delivery?.phase === 'delivered')
    expect(A.port.stores.connectivity.get()).toMatchObject({ carrier: 'connected', queued: 0 })
    console.log(`live mediator: ${JSON.stringify(timings)} ms`)
    await A.port.identity.lock('user')
    await B.port.identity.lock('user')
  }, 120_000)
})
