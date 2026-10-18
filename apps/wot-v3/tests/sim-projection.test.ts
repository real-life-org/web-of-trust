// The simulation projects the IIW scenario into the read models the screens need.
import { describe, expect, it } from 'vitest'
import { createSimPort, createSimWorld } from '../src/adapters/sim'
import { fakeEntropy, virtualClock } from '../src/platform/fake'
import type { Loadable } from '../src/port'
import { iiw } from '../harness/scenarios'

function ready<T>(l: Loadable<T>): T {
  if (l.status !== 'ready') throw new Error(l.status)
  return l.value
}

const port = () => {
  const clock = virtualClock(Date.parse(iiw.clock.start), iiw.clock.timeZone)
  return createSimPort(createSimWorld(iiw.world, { clock, entropy: fakeEntropy() }))
}

describe('simulation projection (IIW)', () => {
  it('orders contacts by last activity and carries verification, trust, unread and open decisions', () => {
    const list = ready(port().stores.contacts.get())
    expect(list.map((c) => c.name)).toEqual(['Sofia Alvarez', 'Priya Raman', 'Marcus Chen', 'Tarek Aydin', 'Lena Baumgart'])
    const marcus = list.find((c) => c.id === 'marcus')!
    expect(marcus.verification).toBe('incoming')
    expect(marcus.conversation.unread).toBe(1)
    expect(marcus.conversation.openDecisions).toBe(1)
    expect(marcus.conversation.preview).toMatchObject({ kind: 'decision', i18n: { key: 'encounter-confirm', values: { name: 'Marcus Chen' } } })
    const tarek = list.find((c) => c.id === 'tarek')!
    expect(tarek.trust).toMatchObject({ given: true, received: false })
  })

  it('inserts day dividers in the scenario time zone and maps delivery states', () => {
    const conv = ready(port().stores.conversation('c:priya').get())
    expect(conv.items.filter((i) => i.kind === 'day').map((i) => (i.kind === 'day' ? i.day : ''))).toEqual(['2026-10-14', '2026-10-15'])
    const mine = conv.items.find((i) => i.kind === 'message' && i.author.kind === 'self')
    expect(mine).toMatchObject({ delivery: { phase: 'delivered' }, origin: 'this-device' })
    expect(conv.composer).toEqual({ ok: false, reason: 'not-supported' })
  })

  it('returns an error for an unknown conversation instead of loading forever', () => {
    expect(port().stores.conversation('c:nobody').get().status).toBe('error')
  })

  it('commands end as unavailable/not-supported in the read-only scaffold', async () => {
    const h = port().trust.giveTrust('priya' as never)
    expect(h.actId).toMatch(/^[0-9a-f-]{36}$/)
    await expect(h.done).resolves.toEqual({ ok: false, error: { kind: 'unavailable', reason: 'not-supported' } })
  })
})
