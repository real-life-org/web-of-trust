// @vitest-environment node
// The opening's `answered` (session.ts, CarrierOpening): the holder is the truth for answers. A restored
// carrier instance asks it which of its open routed deposits are answered, and answers them before its
// first advance (RLTP-VTI-3130, 5080). Answered are documents delivered, refused by the receiver, and
// held by the counterpart's next step (accepted with `held`, RLTP-DEL-6140, RLTP-VTI-5050); a document
// only accepted is not. Over the mediator double, the real adapter and the real holder.
import { describe, expect, it } from 'vitest'
import type { ContactId, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { CARRIER_TICK_MS, type MediatorCarrier } from '../../src/adapters/rltp'
import type { CarrierOpening, CustodyLease, TransportHandlers } from '../../src/adapters/rltp/transport'
import { LOOPBACK_PHRASES, loopbackDevice } from '../../harness/loopback'
import { mediatorDouble } from '../../harness/mediator-double'

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

describe("the opening's answered (holder truth for a restored carrier instance)", () => {
  it('counts a document held by the counterpart’s next step as answered, a document only accepted not', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    /** what A's session hands its custody lease: the opening, the handlers, the digests of its views */
    const seen: { o: CarrierOpening | null; h: TransportHandlers | null; digests: Set<string> } = { o: null, h: null, digests: new Set() }
    const wrap = (t: unknown) => {
      const real = t as MediatorCarrier
      return {
        ...real,
        lease(): CustodyLease {
          const l = real.lease()
          return {
            ...l,
            start(h, o) {
              seen.o = o
              seen.h = h
              l.start(h, o)
            },
            reconcile(view) {
              for (const e of view.entries) if (e.kind === 'document') seen.digests.add(e.digest)
              l.reconcile(view)
            },
          }
        },
      } as MediatorCarrier
    }
    const A = await loopbackDevice({ carrier: { mediator: med }, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 51, wrap: wrap as never })
    const B = await loopbackDevice({ carrier: { mediator: med }, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 53 })
    const settle = async () => {
      for (let i = 0, calm = 0; i < 400 && calm < 2; i++) {
        await med.settled()
        await A.port.session()?.idle()
        await B.port.session()?.idle()
        await new Promise((r) => setTimeout(r, 0))
        calm = (A.port.session()?.transportBusy() ?? 0) + (B.port.session()?.transportBusy() ?? 0) === 0 ? calm + 1 : 0
      }
    }
    const tick = async () => {
      clock.advance(CARRIER_TICK_MS)
      await settle()
    }
    // B shows, A scans, A's sent card reaches B optically; B confirms
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    if (!(await A.port.trust.confirmCard(shown.value.qr).done).ok) throw new Error('scan')
    await settle()
    const aId = value(A.port.stores.contacts)[0]!.id as ContactId
    const sent = await A.port.trust.sentCardFor(aId)
    if (!sent.ok) throw new Error('sent card')
    if (!(await B.port.trust.confirmCard(sent.value.qr).done).ok) throw new Error('capture')
    await settle()
    await tick()

    // A's message goes out routed and the mediator loses it: accepted, never acknowledged
    med.faults.dropRouted = true
    const before = new Set(seen.digests)
    expect((await A.port.trust.send(`c:${aId}`, 'held at the recipient', 'h-1').done).ok).toBe(true)
    await settle()
    await tick()
    const d = [...seen.digests].find((x) => !before.has(x))
    expect(d).toBeDefined()
    const o = seen.o!
    expect(await o.answered([d!])).toEqual([])

    // the counterpart's next step, as the adapter reports it once bound (RLTP-VTI-5050): held
    seen.h!.report({ digest: d!, status: 'accepted', held: true })
    await settle()
    expect(await o.answered([d!])).toEqual([d])
  }, 60_000)
})
