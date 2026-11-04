// @vitest-environment node
// Contacts in common over the real adapter and the real library (Trust §5, lib 0.12 sharedContacts):
// Noah's star to Jonas carries, blinded, the contacts who trust Noah; Jonas tests it against the
// anchors he holds. Lea is in common only if Lea trusted Noah (she is in Noah's star) and Lea trusted
// Jonas (he holds her anchor). Noah's own trust in Jonas is not needed: the star goes to every mutual
// contact by default, it reveals nothing but matches. The contact details name her; it is Noah's claim (5.2), nothing proven.
import { describe, expect, it } from 'vitest'
import type { ContactId, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice } from '../../harness/loopback'

const T0 = Date.parse('2026-11-04T09:00:00+01:00')
const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

async function three() {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'Europe/Berlin')
  const J = await loopbackDevice({ carrier, id: 'J', name: 'Jonas', words: LOOPBACK_PHRASES[0], clock, seed: 61 })
  const N = await loopbackDevice({ carrier, id: 'N', name: 'Noah', words: LOOPBACK_PHRASES[1], clock, seed: 63 })
  const L = await loopbackDevice({ carrier, id: 'L', name: 'Lea', words: LOOPBACK_PHRASES[2], clock, seed: 65 })
  const all = [J, N, L]
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      clock.advance(1000)
      await carrier.settled()
      for (const d of all) await d.port.session()?.idle()
    }
  }
  const idOf = (at: LoopbackDevice, name: string): ContactId => {
    const c = value(at.port.stores.contacts).find((x) => x.name === name)
    if (!c) throw new Error(`no ${name}`)
    return c.id
  }
  /** a scans b's code, b confirms back: mutual */
  const meet = async (a: LoopbackDevice, b: LoopbackDevice, bName: string, aName: string) => {
    const shown = await b.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    await a.port.trust.confirmCard(shown.value.qr).done
    await settle()
    await b.port.trust.counterVerify(idOf(b, aName)).done
    await settle()
    void bName
  }
  await meet(J, N, 'Noah', 'Jonas')
  await meet(N, L, 'Lea', 'Noah')
  await meet(J, L, 'Lea', 'Jonas')
  const trust = async (from: LoopbackDevice, toName: string) => {
    expect((await from.port.trust.giveTrust(idOf(from, toName)).done).ok).toBe(true)
    await settle()
  }
  return { J, N, L, idOf, trust, settle }
}

const shared = (at: LoopbackDevice, id: ContactId) => value(at.port.stores.contact(id))?.sharedContacts ?? null

describe('contacts in common (loopback, three phones)', () => {
  it('Lea trusts Noah and Jonas: Jonas sees Lea in common with Noah, by name (Noah trusted nobody)', async () => {
    const w = await three()
    await w.trust(w.L, 'Noah')
    await w.trust(w.L, 'Jonas')
    const noahAtJonas = w.idOf(w.J, 'Noah')
    expect(shared(w.J, noahAtJonas)).toEqual([{ id: w.idOf(w.J, 'Lea'), name: 'Lea' }])
  }, 60_000)

  it('Lea did not trust Jonas: Jonas holds no anchor of hers, Noah’s star hits nothing he can name', async () => {
    const w = await three()
    await w.trust(w.L, 'Noah')
    await w.trust(w.N, 'Jonas')
    const s = shared(w.J, w.idOf(w.J, 'Noah'))
    expect(s === null || s.length === 0).toBe(true)
  }, 60_000)

  it('Noah blocked at Jonas: his star is processed, not shown; unblocked, the contacts in common are back', async () => {
    const w = await three()
    const noahAtJonas = w.idOf(w.J, 'Noah')
    expect((await w.J.port.trust.block({ kind: 'contact', contactId: noahAtJonas }).done).ok).toBe(true)
    await w.settle()
    // the star arrives while the block holds (Lea's trust comes after it)
    await w.trust(w.L, 'Noah')
    await w.trust(w.L, 'Jonas')
    expect(shared(w.J, noahAtJonas)).toBeNull()
    expect((await w.J.port.trust.unblock({ kind: 'contact', contactId: noahAtJonas }).done).ok).toBe(true)
    await w.settle()
    expect(shared(w.J, noahAtJonas)).toEqual([{ id: w.idOf(w.J, 'Lea'), name: 'Lea' }])
  }, 60_000)
})
