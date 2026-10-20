// @vitest-environment node
// Regressions of the twenty-first review of #420 (rltp/design/store-launch-v3/app-review-420-21-2026-10-21.md,
// gpt-6.1-sol): a failed report reaches the holder before what the carrier answers inside the
// withdrawal it causes (R21-1); one withdrawal pass at a time (R21-2).
import { expect, it } from 'vitest'
import { shareTransport, type Transport, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { writableStore } from '../../src/port'
import { pair } from './pair'

type Deposit = Parameters<Transport['submit']>[0][number]
const online = () => writableStore({ network: 'online' as const, carrier: 'connected' as const })

it('R21: a synchronous report from withdrawal must follow the report that caused withdrawal', () => {
  let registration!: TransportHandlers
  const seen: string[] = []
  const lease = shareTransport({
    status: online(), start(h) { registration = h }, stop() {}, submit() {},
    withdraw(out) {
      // The cancellation discovers that another in-progress attempt was already accepted.
      for (const o of out) registration.report({ digest: o.digest, status: 'accepted' })
    },
  }).lease()
  lease.start({ envelope: async () => 'taken', report(r) { seen.push(r.status) } })
  lease.activate()
  lease.submit([{ digest: 'd' } as Deposit])
  registration.report({ digest: 'd', status: 'failed', reason: 'unroutable' })
  lease.stop()
  expect(seen, 'carrier order failed -> accepted must reach the holder in that order').toEqual(['failed', 'accepted'])
})

it.each([false, true])('R21: the real holder must retain failure before late delivery (reentrant=%s)', async reentrant => {
  let registration!: TransportHandlers
  let digest = ''
  const held = new Set<Deposit>()
  const p = await pair(t => ({ ...t,
    start(h) { registration = h; t.start(h) },
    submit(out) { for (const o of out) { digest ||= o.digest; held.add(o) } },
    withdraw(out) {
      for (const o of out) {
        if (!held.delete(o)) continue
        if (reentrant) registration.report({ digest: o.digest, status: 'delivered', late: false })
      }
    },
  }))
  try {
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    registration.report({ digest, status: 'failed', reason: 'unroutable' })
    if (!reentrant) registration.report({ digest, status: 'delivered', late: false })
    await p.settle()
    const history = (await p.state()).outbox[digest]!.history.map(r => r.status)
    expect(history.slice(-2), 'the failure and its effects must precede the late delivery').toEqual(['failed', 'delivered'])
  } finally { await p.close() }
})

it('R21: a synchronous failed report from withdrawal must not recursively withdraw the same deposits', () => {
  let registration!: TransportHandlers
  let withdrawing = 0
  let maximum = 0
  let calls = 0
  const shared = shareTransport({
    status: online(), start(h) { registration = h }, stop() {}, submit() {},
    withdraw(out) {
      calls++
      maximum = Math.max(maximum, ++withdrawing)
      // Bound the probe, so an adapter feedback loop does not exhaust the JS stack.
      if (calls <= 5) for (const o of out) registration.report({ digest: o.digest, status: 'failed', reason: 'unroutable' })
      withdrawing--
    },
  })
  const lease = shared.lease()
  lease.start({ envelope: async () => 'taken', report() {} })
  lease.activate(); lease.submit([{ digest: 'd' } as Deposit])
  lease.withdraw(['d'])
  lease.stop()
  expect({ calls, maximum }, 'one withdrawal, no reentrant carrier call').toEqual({ calls: 1, maximum: 1 })
})
