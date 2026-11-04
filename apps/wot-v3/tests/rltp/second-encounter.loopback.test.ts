// @vitest-environment node
// A second encounter with a known person over the real adapter and the real library (Trust 6a.4): the
// scan records it under a fresh contact; the library's continuity sweep joins it into the first. The
// port then lists one contact whose aliases name the fresh id, and the verify flow's bundle resolves it.
import { describe, expect, it } from 'vitest'
import type { ContactId, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { bundleEvent } from '../../src/hooks/verify'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'

const T0 = Date.parse('2026-11-04T09:00:00+01:00')
const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

describe('a second encounter (loopback)', () => {
  it('the fresh contact of the second scan becomes an alias of the first; the bundle resolves it', async () => {
    const carrier = memoryCarrier()
    const clock = virtualClock(T0, 'Europe/Berlin')
    const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 71 })
    const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 73 })
    const settle = async () => {
      for (let i = 0; i < 8; i++) {
        clock.advance(2000)
        await carrier.settled()
        await A.port.session()?.idle()
        await B.port.session()?.idle()
      }
    }
    const meet = async (): Promise<ContactId> => {
      const shown = await B.port.trust.showCard().done
      if (!shown.ok) throw new Error('show')
      const r = await A.port.trust.confirmCard(shown.value.qr).done
      if (!r.ok) throw new Error('scan')
      await settle()
      const open = value(B.port.stores.decisions).find((d) => d.kind === 'encounter-confirm')
      if (open && open.kind === 'encounter-confirm') await B.port.trust.counterVerify(open.contactId).done
      await settle()
      return r.value.contactId as ContactId
    }
    const first = await meet()
    const second = await meet()
    const contacts = value(A.port.stores.contacts)
    // the library records the second scan under a fresh contact and joins it afterwards
    expect(second).not.toBe(first)
    expect(contacts).toHaveLength(1)
    expect(contacts[0]?.id).toBe(first)
    expect(contacts[0]?.aliases).toContain(second)
    const e = bundleEvent(A.port)
    expect(e && e.type === 'bundle' ? e.aliases?.[second] : null).toBe(first)
  }, 60_000)
})
