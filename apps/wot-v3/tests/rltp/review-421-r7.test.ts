// @vitest-environment node
// Regressions of Astra's seventh review of #421 (rltp/design/store-launch-v3/app-review-421-7-2026-10-20.md), run against the custody of lib 0.6.0.
// faults=1: the failed expiry check at opening (the holder refuses pendingTransport until a resume completed).
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

it.each([0, 1])('R7: failed expiry check on open never hands an expired copy on (faults=%i)', async (limit) => {
 const w=await world(); const {aId,bId}=await meet(w)
 let restoreSpy = () => {}
 try {
  w.carrier.setOnline('A',false)
  await w.A.port.trust.send(`c:${aId}`,'expired during lock','r7-open-failure').done
  await w.settle()
  const ns=w.A.port.session()!.ns
  await w.A.port.runtime.lock('user')
  w.clock.advance(8*DAY); await w.settle()
  w.carrier.setOnline('A',true)
  const original=IDBDatabase.prototype.transaction
  let failures=0
  const spy=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:Parameters<IDBDatabase['transaction']>){
   if(this.name===`wot-v3-holder-${ns}` && args[1]==='readwrite' && failures<limit){
    failures++; throw new DOMException('temporary write failure','QuotaExceededError')
   }
   return original.apply(this,args)
  })
  restoreSpy = () => spy.mockRestore()
  await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'))
  expect((await w.A.port.runtime.unlock.open()).ok).toBe(true)
  await w.settle()
  expect(failures).toBe(limit)
  expect(messages(w.B,bId).map(m=>m.text)).toEqual([])
 } finally {restoreSpy();await w.A.port.runtime.lock('user');await w.B.port.runtime.lock('user')}
})
