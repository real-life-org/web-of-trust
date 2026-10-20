// @vitest-environment node
// Regressions of the twentieth review of #420 (rltp/design/store-launch-v3/app-review-420-20-2026-10-21.md,
// gpt-6.1-sol): a failed report withdraws the deposits of the digest still pending (R20-1).
import { expect, it, vi } from 'vitest'
import { pair, isAck, DAY } from './pair'
import type { Transport, TransportHandlers } from '../../src/adapters/rltp/transport'
type Deposit = Parameters<Transport['submit']>[0][number]
interface HolderProbe {
  readonly closed: boolean
  pendingTransport(when: number): Promise<unknown>
  handOver(entry: Deposit & { readonly resend?: number }, when: number, start: () => boolean): Promise<boolean>
}

const hooks = vi.hoisted(() => ({ fault: '' as string, fired: 0 }))
vi.mock('@real-life/trust-protocol', async importOriginal => {
  const real = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<HolderProbe> }>()
  return { ...real, createHolder: async (...args: unknown[]) => {
    const h = await real.createHolder(...args)
    return { ...h,
      get closed() { return h.closed },
      pendingTransport(when: number) {
        if (hooks.fault === 'pendingTransport') {
          hooks.fault = ''; hooks.fired++
          return Promise.reject(Error('one transient pendingTransport failure'))
        }
        return h.pendingTransport(when)
      },
      handOver(...args: Parameters<typeof h.handOver>) {
        if (hooks.fault === 'handOver' && args[0].resend !== undefined) {
          hooks.fault = ''; hooks.fired++
          return Promise.reject(Error('one transient handOver failure before start'))
        }
        return h.handOver(...args)
      },
    }
  } }
})

it.each(['unanswered-control', 'later-attempt-failed', 'earlier-attempt-failed-late'])('R20-1 unaccepted deposit is withdrawn: %s', async mode => {
  let h!: TransportHandlers
  const held = new Set<Deposit>()
  let attempts = 0
  let digest = ''
  let late: (() => void) | undefined
  const p = await pair(t => ({ ...t,
    start(x) { h = x; t.start(x) },
    submit(out) {
      for (const o of out) {
        digest ||= o.digest
        if (++attempts === 1) {
          if (mode === 'earlier-attempt-failed-late') {
            // This job has already failed, but its report is delayed within the same generation.
            const registration = h
            late = () => registration.report({ digest: o.digest, status: 'failed', reason: 'unroutable' })
          } else held.add(o)
        } else if (mode === 'later-attempt-failed') {
          h.report({ digest: o.digest, status: 'failed', reason: 'unroutable' })
        } else if (mode === 'earlier-attempt-failed-late') held.add(o)
      }
    },
    withdraw(out) { for (const o of out) held.delete(o) },
  }))
  const service = p.carrier.endpoint('deferred-service')
  const serviceHandlers: TransportHandlers = { envelope: async () => 'not-mine', report() {} }
  service.start(serviceHandlers)
  try {
    expect((await p.scan()).ok).toBe(true); await p.settle()
    p.clock.advance(60_000); await p.settle()
    expect(attempts).toBeGreaterThan(1)
    late?.(); await p.settle()
    if (mode !== 'unanswered-control') expect((await p.state()).outbox[digest]!.history.at(-1)!.status).toBe('failed')
    await p.shutdownA()
    expect.soft([...held].map(o => o.digest), 'earlier deposit remains executable after holder gave up and closed').toEqual([])
    expect(p.B().models()!.decisions).toHaveLength(0)
    // The first begun job finishes late, only if no withdrawal revoked its object.
    for (const o of held) service.submit([o])
    await p.settle()
    expect(p.B().models()!.decisions, 'delivery became possible after the sender was closed').toHaveLength(0)
  } finally { service.stop(serviceHandlers); await p.close() }
})

it.each(['control', 'pendingTransport', 'handOver'])('R20 duplicate ACK recovers automatically after %s', async fault => {
  let saved: Deposit | undefined
  let incoming!: TransportHandlers
  const deposits: { digest: string; resend?: number }[] = []
  const p = await pair(t => ({ ...t,
    start(h) { incoming = h; t.start(h) },
    submit(out) { deposits.push(...out.filter(isAck)); t.submit(out) },
  }), t => ({ ...t,
    submit(out) { for (const o of out) if (!isAck(o)) saved = o; t.submit(out) },
  }))
  try {
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    expect(deposits).toHaveLength(1)
    // All original retry work is over; only the retained, already-sent ACK remains.
    p.clock.advance(8 * DAY); p.foreground(); await p.settle()
    expect(saved).toBeDefined()
    const before = deposits.length
    hooks.fired = 0
    hooks.fault = fault === 'control' ? '' : fault
    expect(await incoming.envelope(saved!.envelope)).toBe('taken')
    await p.settle()
    if (fault !== 'control') expect(hooks.fired).toBe(1)
    // Timers alone, no activation, foreground, redelivery, or explicit offer.
    for (let i = 0; i < 60; i++) { p.clock.advance(60_000); await p.settle() }
    expect(deposits.slice(before), 'the duplicate answer recovers once by timers alone').toHaveLength(1)
    expect(deposits[before]!.resend).toBeDefined()
  } finally { hooks.fault = ''; await p.close() }
})
