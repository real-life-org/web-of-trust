// @vitest-environment node
// Regressions of Astra's fifth review of #421 (rltp/design/store-launch-v3/app-review-421-5-2026-10-20.md).
// Round 5 adversarial probes; assertions describe the required behavior.
/* eslint-disable @typescript-eslint/no-explicit-any -- fault injection at IndexedDB boundary */
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





it('R5: an offline message is kept by the holder across a lock and reaches the contact (custody, lib 0.6.0)', async () => {
 const w=await world(); const {aId,bId}=await meet(w)
 w.carrier.setOnline('A',false)
 expect(await w.A.port.trust.send(`c:${aId}`,'offline durable message','r5-save-fail').done).toMatchObject({ok:true});await w.settle()
 // the app keeps no outbound copy: the holder does (Delivery RLTP-DEL-6120; custody.test.ts)
 await w.A.port.runtime.lock('user')
 w.carrier.setOnline('A',true)
 await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'));await w.A.port.runtime.unlock.open();await w.settle()
 for(let i=0;i<3;i++){w.clock.advance(60000);await w.settle()}
 try {expect.soft(messages(w.A,aId)[0]?.delivery?.phase).toBe('delivered');expect(messages(w.B,bId).map(m=>m.text)).toEqual(['offline durable message'])} finally {await w.A.port.runtime.lock('user');await w.B.port.runtime.lock('user')}
})

it('R5: terminal failed message must not be resubmitted from durable outbox', async () => {
 const w=await world(); const {aId,bId}=await meet(w)
 w.carrier.setOnline('A',false)
 await w.A.port.trust.send(`c:${aId}`,'expired document','r5-expire').done;await w.settle()
 w.clock.advance(8*DAY);await w.settle()
 expect(messages(w.A,aId)[0]?.delivery).toMatchObject({phase:'failed',reason:'expired'})
 // The offered UI action creates a new act after the original failed.
 await w.A.port.trust.send(`c:${aId}`,'expired document','r5-expire-as-new').done;await w.settle()
 await w.A.port.runtime.lock('user');w.carrier.setOnline('A',true)
 await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'));await w.A.port.runtime.unlock.open();await w.settle()
 try {expect(messages(w.B,bId).map(m=>m.text)).toEqual(['expired document'])} finally {await w.A.port.runtime.lock('user');await w.B.port.runtime.lock('user')}
})
it('R5: failed refusal completion and unknown write recover without another unlock', async()=>{
 const w=await world();w.carrier.setOnline('B',false)
 const shown=await w.B.port.trust.showCard().done;if(!shown.ok)throw Error('show')
 const scan=await w.A.port.trust.confirmCard(shown.value.qr).done;if(!scan.ok)throw Error('scan')
 const aId=scan.value.contactId as ContactId
 const orig=IDBDatabase.prototype.transaction;let n=0
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){
 if(this.name===`wot-v3-app-${w.A.port.session()?.ns}` && args[1]==='readwrite' && Array.isArray(args[0]) && args[0].includes('intents') && [3,4].includes(++n)) throw Error('refusal finish failed')
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
 await w.A.port.runtime.lock('user');await w.B.port.runtime.lock('user')
})

