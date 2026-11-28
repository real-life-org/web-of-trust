// @vitest-environment node
// The custody lease of the VTI mediator (carrier-mediator.ts): a relationship whose counterpart's hints
// arrive while its instance is being built from a view without them (shared-connect without a carrier:
// the codes carry no hints, the issue step brings them). The build that found no hint ends, and the
// latest view is planned again: one successful build, carried, without a further tick or view.
import { describe, expect, it, vi } from 'vitest'
import type * as VtiMediator from '@real-life/trust-protocol/adapters/vti-mediator'

const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, calls: 0 }))
vi.mock('@real-life/trust-protocol/adapters/vti-mediator', async (orig) => {
  const m = await orig<typeof VtiMediator>()
  return {
    ...m,
    deliveryHint: async (...a: Parameters<typeof m.deliveryHint>) => {
      gate.calls++
      if (gate.hold) await gate.hold
      return m.deliveryHint(...a)
    },
  }
})

import { deliveryHint } from '@real-life/trust-protocol/adapters/vti-mediator'
import { mediatorTransport } from '../../src/adapters/rltp/carrier-mediator'
import type { CarrierOpening, CustodyLease, TransportHandlers } from '../../src/adapters/rltp/transport'
import { mediatorDouble } from '../../harness/mediator-double'
import { virtualClock } from '../../src/platform/fake'

type ContactView = Parameters<CustodyLease['carry']>[0][number]
const b64u = (u8: Uint8Array) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const turn = () => new Promise((r) => setTimeout(r, 0))

describe('a hint that arrives while the relationship is being built', () => {
  it('is taken from the latest view once the build that found none ends: one successful build, carried, no extra tick', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const rootA = new Uint8Array(64).fill(1), rootB = new Uint8Array(64).fill(2)
    const nA = crypto.getRandomValues(new Uint8Array(32)), nB = crypto.getRandomValues(new Uint8Array(32))
    const hintB = await deliveryHint(rootB, med.did, nB)
    const view = (hints?: string[]): ContactView =>
      ({ id: 'c-b', aliases: [], relationships: [{ id: 'r-b', tuples: 1, chainedFrom: [], carrierNonce: { nonce: b64u(nA), generation: '1' }, ...(hints ? { counterpartDeliveryHints: hints } : {}) }] }) as unknown as ContactView
    const acks = new Map<string, unknown>()
    const o: CarrierOpening = {
      answered: async () => [],
      record: async () => undefined,
      rootIkm: rootA,
      gate: { handOver: async (_e, _w, start) => start() },
      acks: { get: async (k) => acks.get(k), put: async (k, v) => void (v === null ? acks.delete(k) : acks.set(k, v)) },
      when: () => clock.now(),
      offer: () => undefined,
      receiveAtCard: async () => ({ answer: 'taken', recorded: null }),
      diagnose: () => undefined,
    }
    const h: TransportHandlers = { envelope: async () => 'taken', report: () => undefined }
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    lease.start(h, o)
    lease.activate()
    // the build of the view without hints is held at the derivation of the own hint
    let release: () => void = () => undefined
    gate.hold = new Promise((r) => (release = r))
    gate.calls = 0
    lease.carry([view()])
    await turn()
    expect(lease.carriage.get().contacts['c-b']).toBe('starting')
    // the issue step's hints arrive meanwhile: plan() skips the relationship while it is built
    lease.carry([view([hintB])])
    gate.hold = null
    release()
    for (let i = 0; i < 50 && lease.carriage.get().contacts['c-b'] !== 'routed'; i++) {
      await med.settled()
      await turn()
    }
    expect(lease.carriage.get().contacts['c-b']).toBe('routed')
    // the held build and exactly one more
    expect(gate.calls).toBe(2)
    await lease.stop()
  })
})
