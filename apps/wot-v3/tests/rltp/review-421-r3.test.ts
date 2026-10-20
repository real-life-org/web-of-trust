// @vitest-environment node
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


it('R3: expired draft key remains retired after unlock', async () => {
 const w=await world(); const {aId,bId}=await meet(w)
 const orig=IDBDatabase.prototype.transaction;let n=0
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){
 if(this.name.startsWith('wot-v3-app-') && args[1]==='readwrite' && Array.isArray(args[0]) && args[0].includes('intents') && ++n===3) throw Error('finish write unavailable')
 return orig.apply(this,args as any)
 })
 try {expect(await w.A.port.trust.send(`c:${aId}`,'uncertain old send','expired-key').done).toMatchObject({ok:false,error:{code:'unknown-outcome'}})} finally {tx.mockRestore()}
 await w.settle();expect(messages(w.B,bId).map(m=>m.text)).toEqual(['uncertain old send'])
 await w.settle(); await w.A.port.runtime.lock('user')
 w.clock.advance(90*DAY); await w.settle()
 await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'))
 await w.A.port.runtime.unlock.open(); await w.settle()
 expect(messages(w.A,aId)[0]?.delivery?.phase).toBe('unknown')
 const again=await w.A.port.trust.send(`c:${aId}`,'uncertain old send','expired-key').done
 await w.settle()
 expect({again,received:messages(w.B,bId).map(m=>m.text)}).toMatchObject({again:{ok:false},received:['uncertain old send']})
})

it('R3: withdrawn offline document eventually reemits once after unlock', async () => {
 const w=await world(); const {aId,bId}=await meet(w)
 w.carrier.setOnline('A',false)
 await w.A.port.trust.send(`c:${aId}`,'withdraw then resume','withdraw-key').done
 await w.settle(); await w.A.port.runtime.lock('user')
 w.carrier.setOnline('A',true); await w.settle()
 expect(messages(w.B,bId)).toHaveLength(0)
 await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'))
 await w.A.port.runtime.unlock.open(); await w.settle()
 w.clock.advance(8*DAY); await w.settle()
 expect({receiver:messages(w.B,bId).map(m=>m.text),sender:messages(w.A,aId)[0]?.delivery}).toMatchObject({receiver:['withdraw then resume'],sender:{phase:'delivered'}})
 expect(messages(w.A,aId)[0]?.delivery?.phase).toBe('delivered')
})

it('R3: running-write failure recovers on network return without unlocking', async () => {
 const w=await world();const {aId,bId}=await meet(w)
 const orig=IDBDatabase.prototype.transaction;let n=0
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){
 if(this.name.startsWith('wot-v3-app-') && args[1]==='readwrite' && Array.isArray(args[0]) && args[0].includes('intents') && ++n===2) throw Error('storage unavailable')
 return orig.apply(this,args as any)
 })
 try {expect(await w.A.port.trust.send(`c:${aId}`,'temporary journal problem','running-write').done).toMatchObject({ok:false,error:{code:'unknown-outcome'}})} finally {tx.mockRestore()}
 await w.settle()
 w.carrier.setOnline('A',false);w.carrier.setOnline('A',true)
 w.clock.advance(60000);await w.settle()
 expect({receiver:messages(w.B,bId).map(m=>m.text),sender:messages(w.A,aId)[0]?.delivery,intents:w.A.port.stores.intents.get()}).toMatchObject({receiver:['temporary journal problem'],sender:{phase:'delivered'}})
})

it('R3: a transient receiver commit failure must retain the carrier document', async()=>{
 const w=await world();const {aId,bId}=await meet(w)
 const bdb=`wot-v3-holder-${w.B.port.session()!.ns}`
 const orig=IDBDatabase.prototype.transaction; let failures=0
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){
 if(this.name===bdb && args[1]==='readwrite' && failures===0){failures++;throw Error('receiver store unavailable')}
 return orig.apply(this,args as any)
 })
 try {await w.A.port.trust.send(`c:${aId}`,'receiver temporary storage error','receive-fail').done;await w.settle()} finally {tx.mockRestore()}
 expect(failures).toBe(1)
 expect(messages(w.A,aId)[0]?.delivery?.phase).toBe('accepted')
 w.carrier.setOnline('B',false);w.carrier.setOnline('B',true);await w.settle()
 expect(messages(w.B,bId).map(m=>m.text)).toEqual(['receiver temporary storage error'])
})
