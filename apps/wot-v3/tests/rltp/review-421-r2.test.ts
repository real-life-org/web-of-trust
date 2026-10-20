// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the probes of the review, kept as written */
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

it('R2 probe: same gesture cannot bypass the 89 day manual replay limit', async () => {
 const w = await world(); const {aId, bId} = await meet(w)
 w.A.faults.killAt = 'after-journal'
 const first = w.A.port.trust.send(`c:${aId}`, 'expired intent', 'expired-key'); await first.done
 w.clock.advance(90 * DAY); await w.settle()
 const second = w.A.port.trust.send(`c:${aId}`, 'expired intent', 'expired-key'); await second.done
 await w.settle()
 expect(messages(w.B,bId)).toHaveLength(0)
})

it('R2 probe: after the journal succeeds and the running write fails, the outcome is open; other text under the same key is refused', async()=>{
 const w = await world(); const {aId,bId} = await meet(w)
 const orig=IDBDatabase.prototype.transaction; let n=0
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){
   if(this.name===`wot-v3-app-${w.A.port.session()?.ns}` && args[1]==='readwrite' && Array.isArray(args[0]) && args[0].includes('intents') && ++n === 2) throw Error('storage unavailable')
   return orig.apply(this,args as any)
 })
 try {
 const first=await w.A.port.trust.send(`c:${aId}`,'old wording','restore-key').done
 expect(first).toMatchObject({ok:false,error:{kind:'infra',code:'unknown-outcome'}})
 } finally {tx.mockRestore()}
 const second=await w.A.port.trust.send(`c:${aId}`,'corrected wording','restore-key').done
 await w.settle()
 expect(second).toMatchObject({ok:false,error:{kind:'refused',code:'superseded'}})
 // the journaled inputs go out once, never the edited text under the old key
 const again=await w.A.port.trust.send(`c:${aId}`,'old wording','restore-key').done
 await w.settle()
 expect(again.ok).toBe(true)
 expect(messages(w.B,bId).map(m=>m.text)).toEqual(['old wording'])
})

it('R2 probe: an expired uncertain send remains visible with its text after unlock',async()=>{
 const w=await world();const {aId}=await meet(w)
 w.A.faults.killAt='after-journal'
 await w.A.port.trust.send(`c:${aId}`,'keep uncertain message','expired-visibility').done
 await w.settle()
 expect(messages(w.A,aId).map(m=>m.text)).toContain('keep uncertain message')
 await w.A.port.runtime.lock('user')
 w.clock.advance(90*DAY);await w.settle()
 await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'))
 await w.A.port.runtime.unlock.open();await w.settle()
 expect(messages(w.A,aId).map(m=>m.text)).toContain('keep uncertain message')
})

it('R2 probe: held auto-send respects the automatic recovery horizon on unlock',async()=>{
 const w=await world();w.carrier.setOnline('B',false)
 const shown=await w.B.port.trust.showCard().done;if(!shown.ok)throw Error('show')
 const scan=await w.A.port.trust.confirmCard(shown.value.qr).done;if(!scan.ok)throw Error('scan')
 const aId=scan.value.contactId as ContactId
 await w.A.port.trust.send(`c:${aId}`,'held beyond recovery horizon','held-expired').done
 let crash: Promise<void> | undefined
 let armed = true
 Object.defineProperty(w.A.faults,'killAt',{configurable:true,get(){
   if(armed){armed=false;crash=w.A.port.runtime.lock('user');return 'after-journal'}
   return null
 },set(){}})
 w.carrier.setOnline('B',true)
 await w.settle();await crash
 const bIdBefore=value(w.B.port.stores.contacts)[0]!.id
 expect(messages(w.B,bIdBefore)).toHaveLength(0)
 w.clock.advance(8*DAY);await w.settle()
 await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'))
 await w.A.port.runtime.unlock.open();await w.settle()
 const bId=value(w.B.port.stores.contacts)[0]!.id
 expect(messages(w.B,bId)).toHaveLength(0)
})
