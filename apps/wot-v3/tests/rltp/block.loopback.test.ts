// @vitest-environment node
// Block and unblock on the real adapter and the real library (paper §7, Message Tasks 6): silent
// block plus pause; a blocked contact's messages are not shown while the ack still goes out (what the
// blocked one sees is unchanged); after unblocking nothing discarded reappears; new messages show.
import { describe, expect, it } from 'vitest'
import type { ContactId, Conversation, Loadable, MessageItem, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice } from '../../harness/loopback'

const T0 = Date.parse('2026-10-15T13:30:00-07:00')
const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

async function met() {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'America/Los_Angeles')
  const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 41 })
  const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 43 })
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
    }
  }
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw new Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done
  await settle()
  const bId = value(B.port.stores.contacts)[0]!.id
  await B.port.trust.counterVerify(bId).done
  await settle()
  const aId = value(A.port.stores.contacts)[0]!.id
  return { carrier, clock, A, B, aId, bId, settle }
}

const texts = (d: LoopbackDevice, id: ContactId) =>
  value(d.port.stores.conversation(`c:${id}`) as ReadStore<Loadable<Conversation>>).items.filter((i): i is MessageItem => i.kind === 'message').map((m) => m.text)

describe('block over the real adapter (loopback)', () => {
  it('B blocks A: A writes and sees delivered; B shows nothing, keeps nothing; the composer is closed', async () => {
    const w = await met()
    await w.A.port.trust.send(`c:${w.aId}`, 'before the block', 'd0').done
    await w.settle()
    const blocked = await w.B.port.trust.block({ kind: 'contact', contactId: w.bId }).done
    expect(blocked.ok).toBe(true)
    await w.settle()
    const row = value(w.B.port.stores.contacts)[0]
    expect(row).toMatchObject({ blocked: true, trust: { paused: true } })
    expect(value(w.B.port.stores.blocked)).toMatchObject([{ target: { kind: 'contact', contactId: w.bId }, label: 'Al' }])
    expect(value(w.B.port.stores.conversation(`c:${w.bId}`)).composer).toEqual({ ok: false, reason: 'blocked' })
    expect(value(w.B.port.stores.contact(w.bId))?.actions).toMatchObject({ block: { ok: false }, unblock: { ok: true } })
    // the earlier message is hidden while blocked
    expect(texts(w.B, w.bId)).toEqual([])
    w.clock.advance(60_000)
    await w.A.port.trust.send(`c:${w.aId}`, 'while blocked', 'd1').done
    await w.settle()
    // the blocked side observes nothing it would not without the block (§7.5)
    const own = value(w.A.port.stores.conversation(`c:${w.aId}`)).items.filter((i): i is MessageItem => i.kind === 'message')
    expect(own.map((m) => m.delivery?.phase)).toEqual(['delivered', 'delivered'])
    expect(texts(w.B, w.bId)).toEqual([])
    expect(await w.B.port.session()?.inboxSize()).toBe(0)
    // B cannot write while the block holds
    const r = await w.B.port.trust.send(`c:${w.bId}`, 'no', 'b1').done
    expect(r).toMatchObject({ ok: false, error: { code: 'contact-blocked' } })

    // unblock: what came during the block does not reappear (§7.3); new messages show
    expect((await w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId }).done).ok).toBe(true)
    await w.settle()
    expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: false } })
    expect(texts(w.B, w.bId)).toEqual(['before the block'])
    w.clock.advance(60_000)
    await w.A.port.trust.send(`c:${w.aId}`, 'after the block', 'd2').done
    await w.settle()
    expect(texts(w.B, w.bId)).toEqual(['before the block', 'after the block'])
  })
})
