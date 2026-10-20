// @vitest-environment node
// Port rules of architecture §2.1 on the real adapter (the synchronous contract in
// tests/port-contract.ts drives the simulation; the real adapter publishes asynchronously, so its
// rules are checked here after each published bundle): frozen values, stable references, one
// revision across all stores, structural sharing of untouched rows, stores LOADING when locked.
import { describe, expect, it } from 'vitest'
import type { AppPort, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'

const T0 = Date.parse('2026-10-15T13:30:00-07:00')

function loadables(port: AppPort): [string, ReadStore<Loadable<unknown>>][] {
  const s = port.stores
  return Object.entries({ contacts: s.contacts, groups: s.groups, decisions: s.decisions, candidacies: s.candidacies, profile: s.profile, standing: s.standing, visibility: s.visibility, blocked: s.blocked, reports: s.reports })
}

async function meet(shower: AppPort, scanner: AppPort) {
  const shown = await shower.trust.showCard().done
  if (!shown.ok) throw new Error('show')
  const r = await scanner.trust.confirmCard(shown.value.qr).done
  if (!r.ok) throw new Error('scan')
}

describe('port rules on the real adapter', () => {
  it('one revision, frozen, stable references, structural sharing', async () => {
    const carrier = memoryCarrier()
    const clock = virtualClock(T0, 'America/Los_Angeles')
    const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 3 })
    const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 5 })
    const C = await loopbackDevice({ carrier, id: 'C', name: 'Cem', words: LOOPBACK_PHRASES[2], clock, seed: 7 })
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await carrier.settled()
        for (const d of [A, B, C]) await d.port.session()?.idle()
      }
    }
    await meet(B.port, A.port)
    await meet(C.port, A.port)
    await settle()
    const contacts = A.port.stores.contacts.get()
    if (contacts.status !== 'ready') throw new Error('not ready')
    expect(Object.isFrozen(contacts.value)).toBe(true)
    expect(contacts.value.every((c) => Object.isFrozen(c) && Object.isFrozen(c.conversation))).toBe(true)
    expect(A.port.stores.contacts.get()).toBe(contacts)
    const revisions = loadables(A.port).map(([n, s]) => {
      const v = s.get()
      return v.status === 'ready' ? v.asOf : `${n}:${v.status}`
    })
    expect(new Set(revisions).size, revisions.join(',')).toBe(1)

    // C confirms A: only A's row for Cem changes; the row for Bea keeps its reference
    const bea = contacts.value.find((c) => c.name === 'Bea')
    const cDecision = C.port.stores.decisions.get()
    if (cDecision.status !== 'ready' || cDecision.value[0]?.kind !== 'encounter-confirm') throw new Error('no decision at C')
    expect((await C.port.trust.counterVerify(cDecision.value[0].contactId).done).ok).toBe(true)
    await settle()
    const after = A.port.stores.contacts.get()
    if (after.status !== 'ready') throw new Error('not ready')
    expect(after.value.find((c) => c.name === 'Cem')?.verification).toBe('mutual')
    expect(after.value.find((c) => c.name === 'Bea')).toBe(bea)

    await A.port.runtime.lock('user')
    for (const [n, s] of loadables(A.port)) expect(s.get().status, n).toBe('loading')
  })
})
