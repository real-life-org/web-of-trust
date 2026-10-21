// @vitest-environment node
// Regressions of Astra's sixth review of #421 (rltp/design/store-launch-v3/app-review-421-6-2026-10-20.md).
// Round 6 adversarial probes; assertions describe the required behavior.
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

it('R6: terminal failure withdraws the live transport copy before the network returns', async () => {
 const w=await world(); const {aId,bId}=await meet(w)
 try {
  w.carrier.setOnline('A',false)
  await w.A.port.trust.send(`c:${aId}`,'expired document','r6-old').done;await w.settle()
  w.clock.advance(8*DAY);await w.settle()
  expect(messages(w.A,aId)[0]?.delivery).toMatchObject({phase:'failed',reason:'expired'})
  await w.A.port.trust.send(`c:${aId}`,'expired document','r6-new').done;await w.settle()
  w.carrier.setOnline('A',true);await w.settle()
  expect(messages(w.B,bId).map(m=>m.text)).toEqual(['expired document'])
 } finally {await w.A.port.runtime.lock('user');await w.B.port.runtime.lock('user')}
})
it('R6: opening expires old pending documents before submitting stored copies', async () => {
 const w=await world(); const {aId,bId}=await meet(w)
 try {
  w.carrier.setOnline('A',false)
  await w.A.port.trust.send(`c:${aId}`,'expired while locked','r6-locked').done;await w.settle()
  await w.A.port.runtime.lock('user')
  w.clock.advance(8*DAY);await w.settle()
  w.carrier.setOnline('A',true)
  await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'));await w.A.port.runtime.unlock.open();await w.settle()
  expect(messages(w.B,bId)).toEqual([])
  expect(messages(w.A,aId)[0]?.delivery).toMatchObject({phase:'failed',reason:'expired'})
 } finally {await w.A.port.runtime.lock('user');await w.B.port.runtime.lock('user')}
})

import { ACTS } from '../../src/adapters/rltp/acts'

// lib 0.6.1 (review 421 R10-1): a retry of an open send asks the library's act journal; an act it never
// committed is not run, whatever else (network, timers) comes meanwhile
it('R6 control: a manual retry plus network return and timer never runs an uncommitted act', async () => {
 const w=await world(); const {aId,bId}=await meet(w)
 const spy=vi.spyOn(ACTS.send!,'run').mockRejectedValueOnce(new Error('temporary failure'))
 try {
  const first=w.A.port.trust.send(`c:${aId}`,'single replay','r6-replay')
  expect(await first.done).toMatchObject({ok:false,error:{code:'unknown-outcome'}})
  const retry=w.A.port.intents.retryIntent(first.actId)
  w.carrier.setOnline('A',false);await w.settle();w.carrier.setOnline('A',true)
  w.clock.advance(10000);await w.settle()
  expect(await retry.done).toMatchObject({ok:false});await w.settle()
  expect(spy).toHaveBeenCalledTimes(1)
  expect(messages(w.B,bId)).toEqual([])
  expect(messages(w.A,aId).map(m=>m.delivery)).toEqual([{phase:'expired'}])
  expect(w.A.port.stores.intents.get()).toEqual([])
 } finally {spy.mockRestore();await w.A.port.runtime.lock('user');await w.B.port.runtime.lock('user')}
})
