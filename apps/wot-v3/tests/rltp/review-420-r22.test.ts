// @vitest-environment node
// Regressions of the twenty-second review of #420 (rltp/design/store-launch-v3/app-review-420-22-2026-10-21.md,
// gpt-6.1-sol): a duplicate's answer is not withdrawn when its begun hand-over ends its entry (R22-1); a
// carrier without withdraw leaves nothing owed (R22-2, the GC cases need --expose-gc).
import { expect, it } from 'vitest'
import { DAY, isAck, pair } from './pair'
import type { Transport, TransportHandlers } from '../../src/adapters/rltp/transport'
import { shareTransport, unconfiguredTransport } from '../../src/adapters/rltp/transport'

type Deposit = Parameters<Transport['submit']>[0][number] & { readonly resend?: number }

it('R22 control: a regular deposit can complete after an asynchronous service roundtrip', async () => {
  let registration!: TransportHandlers
  const pending = new Set<Deposit>()
  const p = await pair(t => ({ ...t,
    start(h) { registration = h; t.start(h) },
    submit(out) { for (const o of out) pending.add(o) },
    withdraw(out) { for (const o of out) pending.delete(o) },
  }))
  try {
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    expect(pending.size).toBe(1)
    const deposit = [...pending][0]!
    pending.delete(deposit)
    registration.report({ digest: deposit.digest, status: 'accepted' })
    await p.settle()
    expect((await p.state()).outbox[deposit.digest]!.history.at(-1)!.status).toBe('accepted')
  } finally { await p.close() }
})

it('R22 probe: a begun duplicate ACK deposit must be allowed to complete asynchronously', async () => {
  let incoming!: TransportHandlers
  let saved: Deposit | undefined
  let slow = false
  const started: Deposit[] = []
  const pending = new Set<Deposit>()
  const withdrawn: Deposit[] = []
  const complete: (() => void)[] = []
  let accepted = 0
  const p = await pair(t => ({ ...t,
    start(h) { incoming = h; t.start(h) },
    submit(out) {
      for (const o of out) {
        if (slow && isAck(o)) {
          // The request starts now, but service acceptance is asynchronous. Withdrawal aborts this
          // exact request, including pending work, as rule 5 requires. There is no offline queue.
          started.push(o); pending.add(o)
          const registration = incoming
          complete.push(() => {
            if (!pending.delete(o)) return
            accepted++
            registration.report({ digest: o.digest, status: 'accepted' })
          })
        }
        else t.submit([o])
      }
    },
    withdraw(out) {
      for (const o of out) if (pending.delete(o)) withdrawn.push(o)
      t.withdraw?.(out)
    },
  }), t => ({ ...t,
    submit(out) { for (const o of out) if (!isAck(o)) saved = o; t.submit(out) },
  }))
  try {
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    p.clock.advance(8 * DAY); p.foreground(); await p.settle()
    slow = true
    for (let n = 0; n < 3; n++) {
      expect(await incoming.envelope(saved!.envelope)).toBe('taken')
      await p.settle()
      for (const finish of complete.splice(0)) finish()
      await p.settle()
    }
    expect(started).toHaveLength(3)
    expect(started.every(o => o.resend !== undefined)).toBe(true)
    expect({ accepted, withdrawn: withdrawn.length }, 'three healthy asynchronous attempts must not all be cancelled by their own hand-over commit').toEqual({ accepted: 3, withdrawn: 0 })
  } finally { await p.close() }
})

// Run with: pnpm exec vitest run tests/rltp/review-420-r22-probe.test.ts --execArgv=--expose-gc
// The ordinary suite skips this one because it does not expose the collector.
const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
it.skipIf(!gc).each([false, true])('R22 probe: an unconfigured carrier must release envelope objects after shutdown (no-op withdrawal=%s)', async withWithdrawal => {
  const carrier = unconfiguredTransport()
  // A positive control for collection: the same carrier with an explicit no-op withdrawal.
  if (withWithdrawal) carrier.withdraw = () => {}
  const shared = shareTransport(carrier)
  const lease = shared.lease()
  lease.start({ envelope: async () => 'taken', report() {} })
  lease.activate()
  const weak = (() => {
    const deposit = { digest: 'no-carrier-copy' } as Deposit
    expect(lease.submit([deposit])).toBe(true)
    return new WeakRef(deposit)
  })()
  // Let unconfiguredTransport's awaiting-transport callback finish before ending the opening.
  await new Promise(r => setTimeout(r, 0))
  lease.stop()
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 0))
    gc!()
  }
  expect(weak.deref()?.digest, 'the carrier kept no copy, yet the shared adapter retains the envelope after stop').toBeUndefined()
  // Keep the host-level shared transport reachable through the assertion, as in the real app.
  expect(shared.faults()).toEqual([])
})
