// @vitest-environment node
// Regressions of Astra's first review of #421 (rltp/design/store-launch-v3/app-review-421-1-2026-10-20.md),
// the reproductions of the review kept as written.
// 1:1 messages over the real adapter and the real library (Message Tasks 0.1, architecture §2.9 N4):
// send with the sender status, inbox take-over into the app history before takeMessages, offline
// catch-up, a process loss between history and take-over, held drafts on not-ready, a failed message
// at the retry horizon, read marks, order by display time.
import { describe, expect, it, vi } from 'vitest'
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


describe('adversarial review 421', () => {
  // lib 0.6.1 (review 421 R10-1): a send cut off between its journal and its act is never sent blind
  it('same draft with an open intent is never sent twice after recovery, and an uncommitted one not at all', async () => {
    const w = await world()
    const { aId, bId } = await meet(w)
    w.A.faults.killAt = 'after-journal'
    await w.A.port.trust.send(`c:${aId}`, 'one gesture', 'same-key').done
    await w.A.port.trust.send(`c:${aId}`, 'one gesture', 'same-key').done
    await w.settle()
    await w.A.port.runtime.lock('user')
    await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await w.A.port.runtime.unlock.open()
    await w.settle()
    expect(messages(w.B, bId).map(m => m.text)).toEqual([])
    expect(messages(w.A, aId).map(m => m.delivery)).toEqual([{ phase: 'expired' }])
  })
  it('held auto-send interrupted before the act is never sent twice, and not blind, across unlock', async () => {
    const w = await world()
    w.carrier.setOnline('B', false)
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const scanned = await w.A.port.trust.confirmCard(shown.value.qr).done
    if (!scanned.ok) throw new Error('scan')
    const aId = scanned.value.contactId as ContactId
    await w.A.port.trust.send(`c:${aId}`, 'held once', 'held-key').done
    w.A.faults.killAt = 'after-journal'
    w.carrier.setOnline('B', true)
    await w.settle()
    await w.A.port.runtime.lock('user')
    await w.A.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await w.A.port.runtime.unlock.open()
    // the release runs through unlock, sync, the act and the carrier: wait for it, not a fixed number
    // of passes (flaky under load, 20.10.)
    await w.settle()
    await vi.waitFor(async () => {
      await w.settle()
      expect(messages(w.A, aId).map(m => m.delivery)).toEqual([{ phase: 'expired' }])
    }, { timeout: 15000, interval: 20 })
    const bId = value(w.B.port.stores.contacts)[0]!.id
    expect(messages(w.B, bId)).toEqual([])
  })
  it('failed may become delivered on a late ack', async () => {
    const w = await world()
    const { aId, bId } = await meet(w)
    w.carrier.setOnline('B', false)
    await w.A.port.trust.send(`c:${aId}`, 'late', 'late-key').done
    w.clock.advance(8 * DAY)
    await w.settle()
    expect(messages(w.A, aId)[0]?.delivery?.phase).toBe('failed')
    w.carrier.setOnline('B', true)
    await w.settle()
    expect(messages(w.B, bId)).toHaveLength(1)
    expect(messages(w.A, aId)[0]?.delivery).toEqual({ phase: 'delivered', late: true })
  })
})

it('sender and recipient use the same sentAt precision', async () => {
  const w = await world()
  const { aId, bId } = await meet(w)
  w.clock.advance(500)
  await w.A.port.trust.send(`c:${aId}`, 'at half second', 'half').done
  await w.settle()
  expect(messages(w.A, aId)[0]?.at).toBe(messages(w.B, bId)[0]?.at)
})
