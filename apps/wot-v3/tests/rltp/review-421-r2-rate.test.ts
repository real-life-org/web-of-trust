// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/consistent-type-imports -- the probes of the review, kept as written */
// Regressions of Astra's second review of #421 (rltp/design/store-launch-v3/app-review-421-2-2026-10-20.md),
// the probes of the review; where the fix chose the reviewer's alternative, the expectation says so.
// Regressions of Astra's first review of #421 (rltp/design/store-launch-v3/app-review-421-1-2026-10-20.md),
// the reproductions of the review kept as written.
// 1:1 messages over the real adapter and the real library (Message Tasks 0.1, architecture §2.9 N4):
// send with the sender status, inbox take-over into the app history before takeMessages, offline
// catch-up, a process loss between history and take-over, held drafts on not-ready, a failed message
// at the retry horizon, read marks, order by display time.
import { expect, it, vi } from 'vitest'
import type { ContactId, Conversation, ConversationItem, Loadable, MessageItem, ReadStore } from '../../src/port'

import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice } from '../../harness/loopback'

const T0 = Date.parse('2026-10-15T13:30:00-07:00')
const DAY = 86_400_000

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

async function world() {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'America/Los_Angeles')
  const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 13 })
  const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 19 })
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return { carrier, clock, A, B, settle }
}

/** the whole ceremony through the port; both mutual */
async function meet(w: Awaited<ReturnType<typeof world>>) {
  const shown = await w.B.port.trust.showCard().done
  if (!shown.ok) throw new Error('show')
  const scanned = await w.A.port.trust.confirmCard(shown.value.qr).done
  if (!scanned.ok) throw new Error('scan')
  await w.settle()
  const bId = value(w.B.port.stores.contacts)[0]!.id
  await w.B.port.trust.counterVerify(bId).done
  await w.settle()
  return { aId: value(w.A.port.stores.contacts)[0]!.id, bId }
}

const messages = (d: LoopbackDevice, id: ContactId): MessageItem[] =>
  value(d.port.stores.conversation(`c:${id}`) as ReadStore<Loadable<Conversation>>).items.filter((i: ConversationItem): i is MessageItem => i.kind === 'message')




const rate = vi.hoisted(() => ({ next: false, refusals: 0 }))
vi.mock('@real-life/trust-protocol', async (original) => {
 const lib = await original<typeof import('@real-life/trust-protocol')>()
 return {...lib, createHolder: async (...args: Parameters<typeof lib.createHolder>) => {
  const h = await lib.createHolder(...args)
  return {...h, receive: async (...r: Parameters<typeof h.receive>) => {
   if(rate.next){rate.next=false;rate.refusals++;return {disposition:'failed' as const,reason:'rate-limited' as const,stage:8 as const}}
   return h.receive(...r)
  }}
 }}
})
it('R2 probe: a rate-limited message remains at the carrier and arrives on a later pickup',async()=>{
 const w=await world();const {aId,bId}=await meet(w)
 rate.next=true
 await w.A.port.trust.send(`c:${aId}`,'retry after the rate window','rate-key').done
 await w.settle()
 expect(rate.refusals).toBe(1)
 expect(messages(w.B,bId)).toHaveLength(0)
 expect(messages(w.A,aId)[0]?.delivery?.phase).toBe('accepted')
 w.clock.advance(DAY+1000);await w.settle()
 w.carrier.setOnline('B',false);w.carrier.setOnline('B',true);await w.settle()
 expect(messages(w.B,bId).map(m=>m.text)).toEqual(['retry after the rate window'])
})
