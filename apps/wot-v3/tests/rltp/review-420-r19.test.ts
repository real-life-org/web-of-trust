// @vitest-environment node
// Regressions of the nineteenth review of #420 (rltp/design/store-launch-v3/app-review-420-19-2026-10-21.md,
// gpt-6.1-sol): every unaccepted deposit object withdrawn (R19-1), no report into a generation being
// deactivated (R19-2), revocation of pending effects as the carrier's duty (R19-3).
import { expect, it, vi } from 'vitest'
import { shareTransport, type Transport, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { writableStore } from '../../src/port'
import { DAY, pair } from './pair'

type Deposit = Parameters<Transport['submit']>[0][number]
const online = () => writableStore({ network: 'online' as const, carrier: 'connected' as const })
const handlers = (): TransportHandlers => ({ envelope: async () => 'taken', report() {} })

it('R19-1 repeated due handovers: shutdown must withdraw every unaccepted deposit object', async () => {
  // An idempotent carrier keeps its first in-progress deposit for a digest. It never accepted it.
  const held = new Map<string, Deposit>()
  const calls: Deposit[] = []
  const p = await pair(t => ({ ...t,
    submit(out) {
      for (const o of out) { calls.push(o); if (!held.has(o.digest)) held.set(o.digest, o) }
    },
    withdraw(out) { for (const o of out) if (held.get(o.digest) === o) held.delete(o.digest) },
  }))
  try {
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const first = calls[0]!
    p.clock.advance(60_000); await p.settle()
    const repeated = calls.filter(o => o.digest === first.digest)
    expect(repeated.length).toBeGreaterThan(1)
    expect(repeated[1]).not.toBe(first)
    p.clock.advance(8 * DAY); await p.settle()
    expect((await p.state()).outbox[first.digest]!.history.at(-1)!.status).toBe('failed')
    await p.shutdownA()
    expect([...held.keys()], 'the first unaccepted object is still executable after expiry and shutdown').toEqual([])
  } finally { await p.close() }
})

it('R19-2 a withdrawal retry must not deliver a report into the generation being deactivated', () => {
  let registered!: TransportHandlers
  let fail = true
  const received = vi.fn()
  const lease = shareTransport({
    status: online(), start(h) { registered = h }, stop() {}, submit() {},
    withdraw() {
      if (fail) { fail = false; throw Error('retry withdrawal') }
      // A carrier can deliver a callback synchronously from any operation.
      registered.report({ digest: 'd', status: 'accepted' })
    },
  }).lease()
  lease.start({ ...handlers(), report: r => {
    expect(lease.ready(), 'the opening is already out of use inside the callback').toBe(false)
    received(r)
  } }); lease.activate()
  lease.submit([{ digest: 'd' } as Deposit])
  lease.withdraw(['d'])
  received.mockClear()
  lease.deactivate()
  try { expect(received, 'report arrived after deactivation began').not.toHaveBeenCalled() }
  finally { lease.stop() }
})

it('R19 control: late stop and late withdrawal only affect their own registration/deposit', () => {
  let current: TransportHandlers | null = null
  const held = new Set<Deposit>()
  const late: (() => void)[] = []
  let delay = true
  const shared = shareTransport({
    status: online(), start(h) { current = h },
    stop(h) { const end = () => { if (current === h) current = null }; if (delay) { late.push(end); throw Error('late stop') } end() },
    submit(out) { for (const o of out) held.add(o) },
    withdraw(out) { const end = () => { for (const o of out) held.delete(o) }; if (delay) { late.push(end); throw Error('late withdrawal') } end() },
  })
  const a = shared.lease(), b = shared.lease()
  a.start(handlers()); a.activate(); a.submit([{ digest: 'd' } as Deposit]); a.stop()
  delay = false
  b.start(handlers()); b.activate(); const next = { digest: 'd' } as Deposit; b.submit([next])
  const active = current
  for (const fn of late) fn()
  try { expect(current).toBe(active); expect([...held]).toEqual([next]) }
  finally { b.stop() }
})

// R19-3: a carrier that lets a revoked start or deposit take effect breaks TRANSPORT.md rule 5 (a
// carrier duty, not the adapter's); the control below models a carrier that honours the revocation.
it('R19-3 control: cancellation markers make late start and submit completion safe', () => {
  let active: TransportHandlers | null = null
  const ended = new WeakSet<TransportHandlers>()
  const withdrawn = new WeakSet<Deposit>()
  const held = new Set<Deposit>()
  let lateStart!: () => void, lateDeposit!: () => void
  let failStart = true
  const lease = shareTransport({
    status: online(),
    start(h) {
      const complete = () => { if (!ended.has(h)) active = h }
      if (failStart) { failStart = false; lateStart = complete; throw Error('uncertain start') }
      complete()
    },
    stop(h) { ended.add(h); if (active === h) active = null },
    submit(out) {
      lateDeposit = () => { for (const o of out) if (!withdrawn.has(o)) held.add(o) }
      throw Error('uncertain submit')
    },
    withdraw(out) { for (const o of out) { withdrawn.add(o); held.delete(o) } },
  }).lease()
  lease.start(handlers()); lease.activate(); expect(lease.ready()).toBe(true)
  const current = active
  lateStart(); expect(active).toBe(current)
  expect(lease.submit([{ digest: 'd' } as Deposit])).toBe(false)
  lease.stop(); lateDeposit()
  expect(active).toBeNull(); expect([...held]).toEqual([])
})
