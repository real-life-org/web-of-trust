// The workbench's star lines over the real library (architecture §7.4, Trust §5): three phones met
// pairwise; Lea trusts Noah and Jonas. Jonas's star to Noah carries Lea (she trusted Jonas), Noah holds
// her anchor (she trusted Noah): Noah's camera knows Jonas–Lea through the star; and the other way
// round Jonas knows Noah–Lea. Lea's own camera learns nothing: nobody trusted her, she holds no anchor.
import { describe, expect, it } from 'vitest'
import { createWorkbenchWorld, PEOPLE } from '../harness/workbench/world'

describe('known through a star, on the real library', () => {
  it('Noah learns Jonas–Lea, Jonas learns Noah–Lea; Lea learns nothing', async () => {
    const w = await createWorkbenchWorld({ people: PEOPLE.slice(0, 3), carrier: { kind: 'mediator' }, lang: 'en', theme: 'light', met: [['jonas', 'noah'], ['noah', 'lea'], ['jonas', 'lea']] })
    const id = (at: string, name: string) => {
      const v = w.devices.get(at)!.port.stores.contacts.get()
      if (v.status !== 'ready') throw new Error('contacts')
      return v.value.find((c) => c.name === name)!.id
    }
    const trust = async (from: string, to: string) => {
      expect((await w.devices.get(from)!.port.trust.giveTrust(id(from, to)).done).ok).toBe(true)
    }
    await trust('lea', 'Noah Lindqvist')
    await trust('lea', 'Jonas Weber')
    for (let i = 0; i < 5; i++) {
      w.clock.advance(60_000)
      await w.settle()
    }
    await new Promise((r) => setTimeout(r, 1100))
    expect(w.graph.get().stars.noah?.map((e) => e.key)).toEqual(['jonas|lea'])
    expect(w.graph.get().stars.jonas?.map((e) => e.key)).toEqual(['lea|noah'])
    expect(w.graph.get().stars.lea ?? []).toEqual([])
  }, 120_000)
})
