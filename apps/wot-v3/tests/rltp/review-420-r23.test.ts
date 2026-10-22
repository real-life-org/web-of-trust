// @vitest-environment node
// Review 420 round 23 (gpt-6.1-sol): terminal deposits leave the lease and the owed withdrawals (R23-1),
// the matrix rejects a silently lost duplicate answer (R23-2), rule 6 orders end, withdrawal and reports.
import { expect, it, vi } from 'vitest'
import { shareTransport, type Transport, type TransportHandlers, type unconfiguredTransport, type memoryCarrier } from '../../src/adapters/rltp/transport'
import { writableStore } from '../../src/port'
import { virtualClock as transportClock } from '../../src/platform/fake'
/** the device clock of the shared transport's retries (#430) */
const tclock = transportClock(0, 'UTC')

type Deposit = Parameters<Transport['submit']>[0][number]
const mutation = vi.hoisted(() => ({ dropAnswers: false, dropped: 0 }))
vi.mock('@real-life/trust-protocol', async importOriginal => (await import('../crash/transport-faults.lib')).mockLib(importOriginal))
vi.mock('../../src/adapters/rltp/transport', async importOriginal => {
  const real = await importOriginal<{ shareTransport: typeof shareTransport; unconfiguredTransport: typeof unconfiguredTransport; memoryCarrier: typeof memoryCarrier }>()
  return { ...real, shareTransport(t: Transport, clock: Parameters<typeof shareTransport>[1]) {
    const shared = real.shareTransport(t, clock)
    return { ...shared, lease() {
      const lease = shared.lease()
      return { ...lease, submit(out: readonly Deposit[]) {
        if (mutation.dropAnswers && out.some(o => (o as Deposit & { resend?: number }).resend !== undefined)) {
          mutation.dropped += out.length
          // Deliberate mutant: consume the one-shot answer but never start its deposit.
          return true
        }
        return lease.submit(out)
      } }
    } }
  } }
})
const online = () => writableStore({ network: 'online' as const, carrier: 'connected' as const })
const handlers = (): TransportHandlers => ({ envelope: async () => 'taken', report() {} })
const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
const collect = async () => {
  for (let n = 0; n < 8; n++) {
    await new Promise(r => setTimeout(r, 0))
    gc!()
  }
}

it.skipIf(!gc).each(['accepted', 'failed', 'withdrawn'] as const)('gc-only R23: completed %s deposit releases its envelope while the opening remains active', async status => {
  let registration!: TransportHandlers
  const reports: string[] = []
  const shared = shareTransport({ status: online(), start(h) { registration = h }, stop() {}, submit() {}, withdraw() {} }, tclock)
  const lease = shared.lease()
  lease.start({ ...handlers(), report(r) { reports.push(r.status) } }); lease.activate()
  const weak = (() => {
    const o = { digest: 'completed', envelope: { private: 'old-envelope' } } as unknown as Deposit
    lease.submit([o])
    if (status === 'withdrawn') lease.withdraw([o.digest])
    else if (status === 'accepted') registration.report({ digest: o.digest, status }, o)
    else registration.report({ digest: o.digest, status, reason: 'unroutable' }, o)
    return new WeakRef(o)
  })()
  try {
    await collect()
    expect(weak.deref(), 'only digest/lease routing is needed for later reports; completed envelopes must be collectible').toBeUndefined()
    // A late report still reaches the opening without retaining its old envelope.
    if (status !== 'withdrawn') {
      registration.report({ digest: 'completed', status: 'delivered', late: true })
      expect(reports.at(-1)).toBe('delivered')
    }
  } finally { lease.stop() }
  expect(shared.faults()).toEqual([])
})

it.skipIf(!gc).each(['accepted', 'failed'] as const)('gc-only R23: a %s report during a refused withdrawal must release the stopped opening', async status => {
  let registration: TransportHandlers | null = null
  let refuse = true
  const shared = shareTransport({
    status: online(), start(h) { registration = h }, stop(h) { if (registration === h) registration = null }, submit() {},
    withdraw(out) {
      if (!refuse) return
      refuse = false
      for (const o of out) {
        if (status === 'accepted') registration!.report({ digest: o.digest, status }, o)
        else registration!.report({ digest: o.digest, status, reason: 'unroutable' }, o)
      }
      throw Error('withdrawal confirmation lost; the queued report ends the deposit')
    },
  }, tclock)
  const weak = (() => {
    const lease = shared.lease()
    lease.start(handlers()); lease.activate()
    const o = { digest: 'withdraw-report', envelope: { private: 'closed-opening' } } as unknown as Deposit
    lease.submit([o]); lease.withdraw([o.digest]); lease.stop()
    return new WeakRef(o)
  })()
  await collect()
  expect(weak.deref(), 'owed must not retain a terminal deposit and its closed lease forever').toBeUndefined()
  expect(shared.faults()).toHaveLength(1)
})

it('R23: end, withdrawal and synchronous reports keep arrival order', () => {
  let registration!: TransportHandlers
  const seen: string[] = []
  let withdrawals = 0
  const shared = shareTransport({
    status: online(), start(h) { registration = h }, stop() {}, submit() {},
    withdraw(out) {
      withdrawals++
      for (const o of out) {
        registration.report({ digest: o.digest, status: 'accepted' }, o)
        registration.report({ digest: o.digest, status: 'delivered', late: false }, o)
      }
    },
  }, tclock)
  const lease = shared.lease()
  lease.start({ ...handlers(), report(r) { seen.push(r.status); if (r.status === 'failed') { lease.end(['d']); lease.withdraw(['d']) } } })
  lease.activate()
  const a = { digest: 'd' } as Deposit, b = { digest: 'd' } as Deposit
  lease.submit([a]); lease.submit([b])
  registration.report({ digest: 'd', status: 'failed', reason: 'unroutable' }, a)
  expect(seen).toEqual(['failed', 'accepted', 'delivered'])
  expect(withdrawals).toBe(1)
  lease.stop()
})

it('R23: withdrawing an already-withdrawing deposit does not recurse', () => {
  vi.useFakeTimers()
  try {
    let calls = 0
    const shared = shareTransport({ status: online(), start() {}, stop() {}, submit() {}, withdraw() { calls++; lease.withdraw(['d']) } }, tclock)
    const lease = shared.lease(); lease.start(handlers()); lease.activate(); lease.submit([{ digest: 'd' } as Deposit])
    lease.withdraw(['d']); lease.stop()
    expect(calls).toBe(1)
  } finally { vi.useRealTimers() }
})

it('R23: 600 event orders agree with a single-deposit oracle, including synchronous withdrawal reports', () => {
  type Op = 'end' | 'withdraw' | 'failed' | 'accepted' | 'delivered'
  const permutations = (xs: readonly Op[]): Op[][] => xs.length === 0 ? [[]] : xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map(tail => [x, ...tail]))
  const callbacks: readonly (readonly ('failed' | 'accepted' | 'delivered')[])[] = [[], ['failed'], ['accepted'], ['failed', 'delivered'], ['accepted', 'delivered']]
  let cases = 0
  for (const order of permutations(['end', 'withdraw', 'failed', 'accepted', 'delivered'])) for (const replies of callbacks) {
    let registration!: TransportHandlers
    const o = { digest: 'one-deposit' } as Deposit
    const seen: string[] = [], expected: string[] = []
    let withdrawals = 0, expectedWithdrawals = 0
    // The oracle needs only whether custody is still pending and whether `delivered` ended the routing
    // (Delivery §6.1, TRANSPORT.md rule 6); it never reads adapter state.
    let pending = true
    let routed = true
    const expect1 = (status: string) => {
      if (!routed) return
      expected.push(status)
      if (status === 'delivered') routed = false
    }
    const report = (status: 'failed' | 'accepted' | 'delivered') => {
      if (status === 'failed') registration.report({ digest: o.digest, status, reason: 'unroutable' }, o)
      else if (status === 'delivered') registration.report({ digest: o.digest, status, late: false }, o)
      else registration.report({ digest: o.digest, status }, o)
    }
    const lease = shareTransport({
      status: online(), start(h) { registration = h }, stop() {}, submit() {},
      withdraw() { withdrawals++; for (const status of replies) report(status) },
    }, tclock).lease()
    lease.start({ ...handlers(), report(r) { seen.push(r.status) } }); lease.activate(); lease.submit([o])
    for (const op of order) {
      if (op === 'end') lease.end([o.digest])
      else if (op === 'withdraw') {
        if (pending) { expectedWithdrawals++; replies.forEach(expect1); pending = false }
        lease.withdraw([o.digest])
      } else { pending = false; expect1(op); report(op) }
    }
    expect({ seen, withdrawals }, `${order.join(',')} / callbacks ${replies.join(',')}`).toEqual({ seen: expected, withdrawals: expectedWithdrawals })
    lease.stop()
    cases++
  }
  expect(cases).toBe(600)
})

it('R23 matrix sensitivity: seed 7 must reject losing every duplicate answer', async () => {
  mutation.dropAnswers = true
  mutation.dropped = 0
  try {
    const { run, visited } = await import('../crash/transport-faults.harness')
    visited.clear()
    let rejected = false
    try { await run(7) } catch { rejected = true }
    expect(mutation.dropped, 'the countermodel must actually suppress a duplicate answer').toBeGreaterThan(0)
    expect(visited.has('answer/ended'), 'the new rule-6 cell must run').toBe(true)
    expect(rejected, `the matrix must reject silently losing ${mutation.dropped} answers whose hand-over it thinks began`).toBe(true)
  } finally { mutation.dropAnswers = false }
}, 60_000)
