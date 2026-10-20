// @vitest-environment node
// 1:1 messages over the real adapter and the real library (Message Tasks 0.1, architecture §2.9 N4):
// send with the sender status, inbox take-over into the app history before takeMessages, offline
// catch-up, a process loss between history and take-over, held drafts on not-ready, a failed message
// at the retry horizon, read marks, order by display time.
import { describe, expect, it } from 'vitest'
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

describe('messages over the real adapter (loopback)', () => {
  it('A writes, B receives into its history and the library inbox is empty; A sees delivered', async () => {
    const w = await world()
    const { aId, bId } = await meet(w)
    const h = w.A.port.trust.send(`c:${aId}`, 'See you at the stall.', 'draft-1')
    // shown from the journal while the act runs
    await Promise.resolve()
    const sent = await h.done
    expect(sent.ok).toBe(true)
    expect(messages(w.A, aId).map((m) => m.text)).toEqual(['See you at the stall.'])
    expect(['submitted', 'accepted', 'delivered']).toContain(messages(w.A, aId)[0]?.delivery?.phase)
    await w.settle()
    expect(messages(w.A, aId)[0]?.delivery).toEqual({ phase: 'delivered', late: false })
    const got = messages(w.B, bId)
    expect(got.map((m) => [m.text, m.origin, m.author.kind])).toEqual([['See you at the stall.', 'received', 'contact']])
    expect(await w.B.port.session()?.inboxSize()).toBe(0)
    const row = value(w.B.port.stores.contacts)[0]
    expect(row?.conversation.unread).toBe(1)
    expect(row?.conversation.preview).toMatchObject({ kind: 'message', text: 'See you at the stall.' })
    // reading up to the message clears the count
    w.B.port.trust.markRead(`c:${bId}`, got[0]!.id)
    await w.settle()
    expect(value(w.B.port.stores.contacts)[0]?.conversation.unread).toBe(0)
    // a second tap with the same draft key is the same intent: one message
    const again = await w.A.port.trust.send(`c:${aId}`, 'See you at the stall.', 'draft-1').done
    expect(again.ok).toBe(true)
    await w.settle()
    expect(messages(w.B, bId)).toHaveLength(1)
  })

  it('offline catch-up: B offline, A writes twice; the carrier keeps them; B reads them in order once online', async () => {
    const w = await world()
    const { aId, bId } = await meet(w)
    w.carrier.setOnline('B', false)
    await w.A.port.trust.send(`c:${aId}`, 'first', 'd1').done
    w.clock.advance(1000)
    await w.A.port.trust.send(`c:${aId}`, 'second', 'd2').done
    await w.settle()
    expect(messages(w.A, aId).map((m) => m.delivery?.phase)).toEqual(['accepted', 'accepted'])
    expect(messages(w.B, bId)).toEqual([])
    w.carrier.setOnline('B', true)
    await w.settle()
    expect(messages(w.B, bId).map((m) => m.text)).toEqual(['first', 'second'])
    expect(messages(w.A, aId).map((m) => m.delivery?.phase)).toEqual(['delivered', 'delivered'])
  })

  it('a process loss after the history is written and before takeMessages loses nothing and duplicates nothing', async () => {
    const w = await world()
    const { aId, bId } = await meet(w)
    w.B.faults.killAt = 'before-take'
    await w.A.port.trust.send(`c:${aId}`, 'kept', 'd1').done
    await w.settle()
    expect(await w.B.port.session()?.inboxSize()).toBe(1)
    await w.B.port.runtime.lock('user')
    await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await w.B.port.runtime.unlock.open()
    await w.settle()
    expect(messages(w.B, bId).map((m) => m.text)).toEqual(['kept'])
    expect(await w.B.port.session()?.inboxSize()).toBe(0)
  })

  it('B locked while A writes: the message waits at the carrier and arrives after unlocking', async () => {
    const w = await world()
    const { aId, bId } = await meet(w)
    await w.B.port.runtime.lock('user')
    await w.A.port.trust.send(`c:${aId}`, 'while you were away', 'd1').done
    await w.settle()
    await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await w.B.port.runtime.unlock.open()
    await w.settle()
    expect(messages(w.B, bId).map((m) => m.text)).toEqual(['while you were away'])
  })

  it('not ready: the app holds the message and sends it once a document of the contact arrived', async () => {
    const w = await world()
    // A scans while B is offline: A's tuple has no document of B yet
    w.carrier.setOnline('B', false)
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const scanned = await w.A.port.trust.confirmCard(shown.value.qr).done
    if (!scanned.ok) throw new Error('scan')
    const aId = scanned.value.contactId as ContactId
    const r = await w.A.port.trust.send(`c:${aId}`, 'hello, are you there?', 'held-1').done
    expect(r).toMatchObject({ ok: false, error: { kind: 'refused', code: 'not-ready' } })
    expect(messages(w.A, aId).map((m) => [m.text, m.delivery])).toEqual([['hello, are you there?', { phase: 'held', reason: 'not-ready' }]])
    w.carrier.setOnline('B', true)
    await w.settle()
    await w.settle()
    const bId = value(w.B.port.stores.contacts)[0]!.id
    expect(messages(w.B, bId).map((m) => m.text)).toEqual(['hello, are you there?'])
    expect(messages(w.A, aId).map((m) => m.delivery?.phase)).toEqual(['delivered'])
  })

  it('undelivered until the retry horizon: failed, not repeated by the core; sent again as a new message', async () => {
    const w = await world()
    const { aId, bId } = await meet(w)
    w.carrier.setOnline('A', false)
    await w.A.port.trust.send(`c:${aId}`, 'lost in the void', 'd1').done
    w.clock.advance(8 * DAY)
    await w.settle()
    const [failed] = messages(w.A, aId)
    expect(failed?.delivery).toEqual({ phase: 'failed', reason: 'expired', retry: { ok: false, reason: 'not-supported' } })
    // the carrier never got it: nothing arrives late
    w.carrier.drop('A')
    w.carrier.setOnline('A', true)
    await w.A.port.trust.send(`c:${aId}`, 'lost in the void', 'd2').done
    await w.settle()
    expect(messages(w.A, aId).map((m) => m.delivery?.phase)).toEqual(['failed', 'delivered'])
    expect(messages(w.B, bId).map((m) => m.text)).toEqual(['lost in the void'])
  })

  it('both write: one conversation ordered by display time', async () => {
    const w = await world()
    const { aId, bId } = await meet(w)
    await w.A.port.trust.send(`c:${aId}`, 'one', 'a1').done
    await w.settle()
    w.clock.advance(60_000)
    await w.B.port.trust.send(`c:${bId}`, 'two', 'b1').done
    await w.settle()
    w.clock.advance(60_000)
    await w.A.port.trust.send(`c:${aId}`, 'three', 'a2').done
    await w.settle()
    expect(messages(w.A, aId).map((m) => [m.text, m.origin])).toEqual([['one', 'this-device'], ['two', 'received'], ['three', 'this-device']])
    expect(messages(w.B, bId).map((m) => [m.text, m.origin])).toEqual([['one', 'received'], ['two', 'this-device'], ['three', 'received']])
  })
})
