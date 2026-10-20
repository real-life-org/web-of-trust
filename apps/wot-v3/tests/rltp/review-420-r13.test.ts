// @vitest-environment node
// Regressions of Astra's thirteenth review of #420 (rltp/design/store-launch-v3/app-review-420-13-2026-10-20.md).
// Adversarial R13 probes. R13-1..3 assert the contract; R13-4 characterizes
// a limitation without claiming that this unexpired document violates 6135.
import { expect, it, vi } from 'vitest'
import { pair } from './pair'
import { memoryCarrier, shareTransport, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { virtualClock } from '../../src/platform/fake'
import { loopbackDevice, LOOPBACK_PHRASES } from '../../harness/loopback'
import { secret } from '../../src/port'

const fault = vi.hoisted(() => ({ tick: false, failures: 0 }))
vi.mock('@real-life/trust-protocol', async importOriginal => {
  // the core library is the adapter's alone (architecture §0.1): the test sees it only through the mock
  const lib = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<{ readonly closed: boolean; tick(when: number): Promise<unknown> }> }>()
  return { ...lib, createHolder: async (...args: unknown[]) => {
    const h = await lib.createHolder(...args)
    return {
      ...h,
      get closed() { return h.closed },
      tick: (when: number) => {
        if (fault.tick) { fault.failures++; return Promise.reject(Error('tick storage failure')) }
        return h.tick(when)
      },
    }
  } }
})

it('R13-4 diagnostic: a failed tick does not block an unexpired document on network return', async () => {
  const sent: string[] = []
  const p = await pair(t => ({ ...t, submit(out) { sent.push(...out.map(o => o.digest)); t.submit(out) } }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const digest = sent[0]!
    fault.tick = true
    p.clock.advance(60_000)
    p.foreground()
    await p.settle()
    expect(fault.failures).toBeGreaterThan(0)
    const before = sent.filter(d => d === digest).length
    p.carrier.setOnline('A', true)
    await p.settle()
    // A tick failure does not invalidate the real engine's earlier resume.
    // This is not a proof of missed due transitions for this document:
    // it documents the limit of the stronger "nothing is sent" claim.
    expect(sent.filter(d => d === digest)).toHaveLength(before + 1)
    expect(p.B().models()!.decisions).toHaveLength(1)
  } finally { fault.tick = false; await p.close() }
})

it('R13-2: a transient device start failure must not leave unlocked without a session on retry', async () => {
  const carrier = memoryCarrier()
  const starts = vi.fn()
  let fail = false
  const A = await loopbackDevice({
    carrier: { ...carrier, endpoint(id) {
      const t = carrier.endpoint(id)
      return { ...t, start(h) {
        starts()
        if (fail) { fail = false; throw Error('transient start failure') }
        t.start(h)
      } }
    } },
    clock: virtualClock(Date.parse('2026-10-20T10:00:00Z'), 'UTC'),
    id: 'A', name: 'A', words: LOOPBACK_PHRASES[0], seed: 13420,
  })
  try {
    await A.port.runtime.lock('user')
    expect((await A.port.runtime.unlock.passphrase(secret('harness passphrase'))).ok).toBe(true)
    fail = true
    await A.port.runtime.unlock.open().catch(() => undefined)
    expect((await A.port.runtime.unlock.open()).ok).toBe(true)
    expect(A.port.runtime.state.get()).toMatchObject({ status: 'unlocked' })
    // the failed start does not fail the unlock; the device transport starts again shortly
    await new Promise(r => setTimeout(r, 1100))
    expect.soft(starts, 'initial setup, failed start, successful retry').toHaveBeenCalledTimes(3)
    expect.soft(A.port.session(), 'successful unlock must install the adapter session').not.toBeNull()
    expect((await A.port.trust.showCard().done).ok).toBe(true)
  } finally { fail = false; await A.port.runtime.lock('user') }
})

it('R13-3: a retired device generation must not deliver an envelope to the next opening', async () => {
  const callbacks: TransportHandlers[] = []
  const t = memoryCarrier().endpoint('A')
  const shared = shareTransport({ ...t, start(h) { callbacks.push(h); t.start(h) } })
  const old = shared.lease(), next = shared.lease()
  old.start({ envelope: async () => 'taken', report() {} })
  old.activate()
  old.stop()
  const receive = vi.fn(async () => 'taken' as const)
  next.start({ envelope: receive, report() {} })
  next.activate()
  try {
    await callbacks[0]!.envelope({ late: true })
    expect(receive, 'architecture 2.1.7: an old generation result is discarded').not.toHaveBeenCalled()
  } finally { next.stop() }
})

it('R13-1: transport stop failure during runtime.lock must still lock the identity and reject new acts', async () => {
  const carrier = memoryCarrier()
  let failStop = false
  const A = await loopbackDevice({
    carrier: { ...carrier, endpoint(id) {
      const t = carrier.endpoint(id)
      return { ...t, stop(h) {
        if (failStop) { failStop = false; throw Error('injected stop failure') }
        t.stop(h)
      } }
    } },
    clock: virtualClock(Date.parse('2026-10-20T10:00:00Z'), 'UTC'),
    id: 'A', name: 'A', words: LOOPBACK_PHRASES[0], seed: 13421,
  })
  try {
    failStop = true
    let error: unknown
    try { await A.port.runtime.lock('user') } catch (e) { error = e }
    expect.soft(error, 'lock never rejects because a cleanup step failed').toBeUndefined()
    expect.soft(A.port.runtime.state.get()).toMatchObject({ status: 'locked' })
    expect.soft(A.port.session(), 'the session must be detached synchronously').toBeNull()
    const result = await A.port.trust.showCard().done
    expect(result, 'no human act may commit after lock').toMatchObject({ ok: false, error: { kind: 'locked' } })
  } finally { failStop = false; await A.port.runtime.lock('user') }
})
