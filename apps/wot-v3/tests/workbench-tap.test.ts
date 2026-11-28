// The workbench's wire, watched on the phones (architecture §7.4): over the mediator double (the
// default) and over the in-memory carrier alike, every sealed envelope a phone handed its carrier is
// one entry, and the phone that took it is its recipient. Matched by the envelope's nonce.
import { describe, expect, it } from 'vitest'
import { createWorkbenchWorld, PEOPLE } from '../harness/workbench/world'
import { envelopeKey } from '../harness/workbench/tap'

describe('the wire as the phones saw it', () => {
  for (const kind of ['mediator', 'memory'] as const) {
    it(`over the ${kind} carrier: one meeting and a message each way, every envelope once, every one taken by the other phone`, async () => {
      const w = await createWorkbenchWorld({ people: PEOPLE.slice(0, 2), carrier: { kind }, lang: 'en', theme: 'light', met: [['jonas', 'noah']] })
      await w.settle()
      // the meeting is the connection ceremony, whose own documents travel on wires of their own (or, without
      // a carrier, as codes): the relationship's envelopes are what the phones then write
      const send = async (from: string, text: string) => {
        const d = w.devices.get(from)!
        const c = d.port.stores.contacts.get()
        const id = c.status === 'ready' ? c.value[0]?.id : undefined
        if (!id) throw new Error(`no contact at ${from}`)
        const r = await d.port.trust.send(`c:${id}`, text, `tap-${from}`).done
        // the scanner's first message right after the ceremony may wait for the relationship to be ready
        // (held, Message Tasks 5.1); it goes out by itself once it is
        expect(r.ok || (r.error.kind === 'refused' && r.error.code === 'not-ready')).toBe(true)
        await w.settle()
      }
      await send('jonas', 'hello Noah')
      await send('noah', 'hello Jonas')
      const entries = w.wire.get()
      expect(entries.length).toBeGreaterThanOrEqual(2)
      expect(new Set(entries.map((e) => e.n)).size).toBe(entries.length)
      expect(entries.some((e) => e.from === 'jonas')).toBe(true)
      expect(entries.some((e) => e.from === 'noah')).toBe(true)
      for (const e of entries) {
        expect(e.disposition).toBe('taken')
        expect(e.to).toBe(e.from === 'jonas' ? 'noah' : 'jonas')
      }
    }, 60_000)
  }

  it('the key is the envelope nonce, nothing else', () => {
    expect(envelopeKey({ rkid: 'r', epk: 'e', nonce: 'n1', ciphertext: 'c' })).toBe('n1')
    expect(envelopeKey({ nonce: 3 })).toBeNull()
    expect(envelopeKey(null)).toBeNull()
  })
})
