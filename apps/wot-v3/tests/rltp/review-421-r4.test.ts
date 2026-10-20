// @vitest-environment node
// Regressions of Astra's fourth review of #421 (rltp/design/store-launch-v3/app-review-421-4-2026-10-20.md).
/* eslint-disable @typescript-eslint/no-explicit-any -- the probes of the review, kept as written */
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
import { secret } from '../../src/port'
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



import { IDBDatabase } from 'fake-indexeddb'



it('R4: a fresh showCard gesture works after recovery discards the old one', async () => {
 const w=await world()
 w.A.faults.killAt='after-journal'
 expect(await w.A.port.trust.showCard().done).toMatchObject({ok:false})
 await w.A.port.runtime.lock('user')
 await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'))
 await w.A.port.runtime.unlock.open();await w.settle()
 expect(await w.A.port.trust.showCard().done).toEqual({ok:true, value:expect.anything()})
})

it('R4: refusal finalization failure recovers without another unlock', async()=>{
 const w=await world();w.carrier.setOnline('B',false)
 const shown=await w.B.port.trust.showCard().done;if(!shown.ok)throw Error('show')
 const scan=await w.A.port.trust.confirmCard(shown.value.qr).done;if(!scan.ok)throw Error('scan')
 const aId=scan.value.contactId as ContactId
 const orig=IDBDatabase.prototype.transaction;let n=0
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){
 if(this.name.startsWith('wot-v3-app-') && args[1]==='readwrite' && Array.isArray(args[0]) && args[0].includes('intents') && ++n===3) throw Error('refusal finish failed')
 return orig.apply(this,args as any)
 })
 try {await w.A.port.trust.send(`c:${aId}`,'held finish error','held-finish').done} finally {tx.mockRestore()}
 w.carrier.setOnline('B',true);await w.settle()
 w.carrier.setOnline('A',false);await w.settle();w.carrier.setOnline('A',true)
 for(let i=0;i<4;i++){w.clock.advance(60000);await w.settle()}
 const bId=value(w.B.port.stores.contacts)[0]!.id
 expect.soft({sender:messages(w.A,aId).map(m=>m.delivery),receiver:messages(w.B,bId).map(m=>m.text),intents:w.A.port.stores.intents.get()}).toMatchObject({sender:[{phase:'delivered'}],receiver:['held finish error'],intents:[]})
 await w.A.port.runtime.lock('user')
 await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'));await w.A.port.runtime.unlock.open();await w.settle()
 expect(messages(w.B,bId).map(m=>m.text)).toEqual(['held finish error'])
})

import { ACTS } from '../../src/adapters/rltp/acts'

it('R4 control: failed running and unknown writes leave journaled, recover once with original actId', async()=>{
 const w=await world();const {aId,bId}=await meet(w)
 const orig=IDBDatabase.prototype.transaction;let n=0
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){
 if(this.name.startsWith('wot-v3-app-') && args[1]==='readwrite' && Array.isArray(args[0]) && args[0].includes('intents') && [2,3].includes(++n)) throw Error('storage unavailable')
 return orig.apply(this,args as any)
 })
 let h:any
 try {h=w.A.port.trust.send(`c:${aId}`,'journaled remains','double-write-fail');expect(await h.done).toMatchObject({ok:false,error:{code:'unknown-outcome'}})} finally {tx.mockRestore()}
 await w.settle()
 expect(w.A.port.stores.intents.get()).toEqual(expect.arrayContaining([expect.objectContaining({actId:h.actId,state:'journaled'})]))
 const originalRun=ACTS.send!.run
 let release!:()=>void
 const gate=new Promise<void>(r=>release=r)
 const calls:string[]=[]
 const spy=vi.spyOn(ACTS.send!,'run').mockImplementation(async(holder,input,o)=>{
   calls.push(o.actId);await gate;return originalRun(holder,input,o)
 })
 try {
  w.carrier.setOnline('A',false);await w.settle();w.carrier.setOnline('A',true);await w.settle()
  expect(calls).toEqual([h.actId])
  w.carrier.setOnline('A',false);await w.settle();w.carrier.setOnline('A',true);w.clock.advance(10000);await w.settle()
  expect(calls).toEqual([h.actId])
  release();await w.settle()
  expect(messages(w.B,bId).map(m=>m.text)).toEqual(['journaled remains'])
 }finally{release();spy.mockRestore()}
})

it('R4 control: expired key remains spent after the expired intent is cleaned up',async()=>{
 const w=await world();const {aId,bId}=await meet(w)
 w.A.faults.killAt='after-journal'
 await w.A.port.trust.send(`c:${aId}`,'spent after cleanup','spent-key').done
 await w.A.port.runtime.lock('user');w.clock.advance(90*DAY)
 await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'));await w.A.port.runtime.unlock.open();await w.settle()
 await w.A.port.runtime.lock('user');w.clock.advance(8*DAY)
 await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'));await w.A.port.runtime.unlock.open();await w.settle()
 expect(await w.A.port.trust.send(`c:${aId}`,'spent after cleanup','spent-key').done).toMatchObject({ok:false,error:{code:'superseded'}})
 await w.settle();expect(messages(w.B,bId)).toHaveLength(0)
 expect(messages(w.A,aId)[0]?.delivery?.phase).toBe('unknown')
})

it('R4 control: a failed app history write keeps the inbox until the durable retry',async()=>{
 const w=await world();const {aId,bId}=await meet(w)
 const bdb=`wot-v3-app-${w.B.port.session()!.ns}`
 const original=IDBDatabase.prototype.transaction;let failures=0;let fail=true
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){
 if(this.name===bdb && args[1]==='readwrite' && Array.isArray(args[0]) && args[0].includes('log') && fail){failures++;throw Error('app history unavailable')}
 return original.apply(this,args as any)
 })
 try {
  await w.A.port.trust.send(`c:${aId}`,'history durable before take','history-fail').done;await w.settle()
  expect(failures).toBeGreaterThan(0)
  expect(await w.B.port.session()!.inboxSize()).toBe(1)
  expect(messages(w.B,bId)).toHaveLength(0)
  expect(messages(w.A,aId)[0]?.delivery?.phase).toBe('delivered')
  fail=false;w.clock.advance(1000);await w.settle()
  expect(messages(w.B,bId).map(m=>m.text)).toEqual(['history durable before take'])
  expect(await w.B.port.session()!.inboxSize()).toBe(0)
 }finally{tx.mockRestore()}
})
