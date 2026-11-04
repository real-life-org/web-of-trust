// The workbench's wire, watched on the phones (architecture §7.4): over the mediator double (the
// default) and over the in-memory carrier alike, every sealed envelope a phone handed its carrier is
// one entry, and the phone that took it is its recipient. Matched by the envelope's nonce.
import { describe, expect, it } from 'vitest'
import { createWorkbenchWorld, PEOPLE } from '../harness/workbench/world'
import { envelopeKey } from '../harness/workbench/tap'

describe('the wire as the phones saw it', () => {
  for (const kind of ['mediator', 'memory'] as const) {
    it(`over the ${kind} carrier: one meeting, every envelope once, every one taken by the other phone`, async () => {
      const w = await createWorkbenchWorld({ people: PEOPLE.slice(0, 2), carrier: { kind }, lang: 'en', theme: 'light', met: [['jonas', 'noah']] })
      await w.settle()
      const entries = w.wire.get()
      expect(entries.length).toBeGreaterThanOrEqual(2)
      expect(new Set(entries.map((e) => e.n)).size).toBe(entries.length)
      expect(entries.some((e) => e.type === 'encounter-bundle/0.1' && e.from === 'jonas')).toBe(true)
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
