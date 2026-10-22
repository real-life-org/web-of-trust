// @vitest-environment node
/* eslint-disable @typescript-eslint/consistent-type-imports -- the probe of the review, kept as written */
// Regressions of Astra's fourth review of #421 (rltp/design/store-launch-v3/app-review-421-4-2026-10-20.md).
 
// Regressions of Astra's third review of #421 (rltp/design/store-launch-v3/app-review-421-3-2026-10-20.md),
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
import { REDELIVER_MS } from '../../src/adapters/rltp/transport'

const T0 = Date.parse('2026-10-15T13:30:00-07:00')

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

async function world() {
  const clock = virtualClock(T0, 'America/Los_Angeles')
  // the carrier is a service of its own: it offers refused documents again on its own clock (#430),
  // so the test moves the redelivery without moving the devices' due times
  const carrierClock = virtualClock(T0, 'UTC')
  const carrier = memoryCarrier(carrierClock)
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
  return { carrier, carrierClock, clock, A, B, settle }
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







const receiveFault=vi.hoisted(()=>({mode:'' as ''|'after'|'always',calls:0}))
vi.mock('@real-life/trust-protocol',async(original)=>{
 const lib=await original<typeof import('@real-life/trust-protocol')>()
 return {...lib,createHolder:async(...args:Parameters<typeof lib.createHolder>)=>{
  const h=await lib.createHolder(...args)
  return {...h,receive:async(...args:Parameters<typeof h.receive>)=>{
   if(receiveFault.mode==='always'){receiveFault.calls++;throw Error('temporary receive failure')}
   const r=await h.receive(...args)
   if(receiveFault.mode==='after' && r.disposition==='unique'){
    receiveFault.mode='';receiveFault.calls++;throw Error('lost answer after durable commit')
   }
   return r
  }}
 }}
})

it('R4 control: redelivery after a committed receive does not take over twice',async()=>{
 const w=await world();const {aId,bId}=await meet(w)
 receiveFault.mode='after';receiveFault.calls=0
 await w.A.port.trust.send(`c:${aId}`,'committed before exception','after-receive').done;await w.settle()
 expect(receiveFault.calls).toBe(1)
 expect(messages(w.B,bId).map(m=>m.text)).toEqual(['committed before exception'])
 // the receipt committed: its acknowledgement goes out from the holder's custody whatever the
 // receive call answered (lib 0.6.0), so the sender sees it delivered at once
 expect(messages(w.A,aId)[0]?.delivery?.phase).toBe('delivered')
 w.carrierClock.advance(REDELIVER_MS);await w.settle()
 expect(messages(w.B,bId).map(m=>m.text)).toEqual(['committed before exception'])
 expect(messages(w.A,aId)[0]?.delivery?.phase).toBe('delivered')
})

it('R4 control: persistent later is delayed, retains the document, then delivers once',async()=>{
 const w=await world();const {aId,bId}=await meet(w)
 receiveFault.mode='always';receiveFault.calls=0
 try{
  await w.A.port.trust.send(`c:${aId}`,'temporary receiver unavailable','persistent-later').done;await w.settle()
  expect(receiveFault.calls).toBe(1)
  w.carrierClock.advance(REDELIVER_MS);await w.settle()
  expect(receiveFault.calls).toBe(2)
  expect(messages(w.B,bId)).toHaveLength(0)
 }finally{receiveFault.mode=''}
 w.carrierClock.advance(REDELIVER_MS);await w.settle()
 expect(messages(w.B,bId).map(m=>m.text)).toEqual(['temporary receiver unavailable'])
 expect(messages(w.A,aId)[0]?.delivery?.phase).toBe('delivered')
})
