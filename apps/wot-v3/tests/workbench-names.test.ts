// Review 503: the workbench resolves a contact to its phone by the phones' current profile names and
// pins it, so a renamed person keeps their edges; the graph prefers the resolved phone over the name.
import { describe, expect, it } from 'vitest'
import { edgesOf, type DeviceContacts } from '../harness/workbench/graph'
import { createWorkbenchWorld, PEOPLE } from '../harness/workbench/world'

describe('the graph prefers the resolved phone over the name', () => {
  it('a contact named differently from its phone still makes the edge when resolved', () => {
    const devices: DeviceContacts[] = [
      { id: 'jonas', name: 'Jonas Weber', contacts: [{ name: 'Noah the Second', verification: 'mutual', trust: { given: false }, peer: 'noah' }] },
      { id: 'noah', name: 'Noah Lindqvist', contacts: [] },
    ]
    expect(edgesOf(devices).map((e) => e.key)).toEqual(['jonas|noah'])
  })

  it('resolved to nobody (two phones of one name): no edge, never a wrong one', () => {
    const devices: DeviceContacts[] = [{ id: 'jonas', name: 'Jonas', contacts: [{ name: 'Sam', verification: 'mutual', trust: { given: false }, peer: null }] }]
    expect(edgesOf(devices)).toEqual([])
  })
})

describe('a renamed person keeps their edges (real library)', () => {
  it('Noah renames himself after meeting Jonas: the edge stays', async () => {
    const w = await createWorkbenchWorld({ people: PEOPLE.slice(0, 2), carrier: { kind: 'mediator' }, lang: 'en', theme: 'light', met: [['jonas', 'noah']] })
    await new Promise((r) => setTimeout(r, 1100))
    expect(w.graph.get().edges.map((e) => e.key)).toEqual(['jonas|noah'])
    const noah = w.devices.get('noah')!
    expect((await noah.port.trust.setProfile({ name: 'Noah L.' }).done).ok).toBe(true)
    // the new name reaches Jonas only with trust (the profile class follows it)
    const jonasId = (() => { const v = noah.port.stores.contacts.get(); return v.status === 'ready' ? v.value[0]!.id : ('' as never) })()
    expect((await noah.port.trust.giveTrust(jonasId).done).ok).toBe(true)
    for (let i = 0; i < 5; i++) {
      w.advance(60_000)
      await w.settle()
    }
    const at = w.devices.get('jonas')!.port.stores.contacts.get()
    expect(at.status === 'ready' ? at.value.map((c) => c.name) : []).toEqual(['Noah L.'])
    await new Promise((r) => setTimeout(r, 1100))
    expect(w.graph.get().edges.map((e) => e.key)).toEqual(['jonas|noah'])
  }, 120_000)
})
