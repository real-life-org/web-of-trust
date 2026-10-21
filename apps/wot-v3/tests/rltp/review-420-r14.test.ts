// @vitest-environment node
// Regressions of Astra's fourteenth review of #420 (rltp/design/store-launch-v3/app-review-420-14-2026-10-20.md).
// Round 14: expectations describe recovery and custody, not the current implementation.
import { expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory } from 'fake-indexeddb'
import { DAY, isAck, pair } from './pair'
import { decodeCardLink } from '../../src/adapters/rltp/card-link'
import { unconfiguredTransport, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { fakeEntropy, virtualClock } from '../../src/platform/fake'

interface HolderProbe {
  readonly closed: boolean
  close(): Promise<void>
  profile(): Promise<unknown>
}
const hooks = vi.hoisted(() => ({
  failProfile: false,
  closeBarrier: null as Promise<void> | null,
  created: 0,
}))
vi.mock('@real-life/trust-protocol', async importOriginal => {
  const lib = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<HolderProbe> }>()
  return { ...lib, createHolder: async (...args: unknown[]) => {
    const h = await lib.createHolder(...args)
    hooks.created++
    const barrier = hooks.closeBarrier
    return {
      ...h,
      get closed() { return h.closed },
      async close() { await h.close(); await barrier },
      profile() {
        if (hooks.failProfile) { hooks.failProfile = false; return Promise.reject(Error('first bundle read failed')) }
        return h.profile()
      },
    }
  } }
})

it('R14 start retry: a held document must leave after transport recovery without another user action', async () => {
  let failStart = false
  let successfulStarts = 0
  const sent: string[] = []
  const p = await pair(t => ({ ...t,
    start(h) {
      if (failStart) throw Error('temporary device start failure')
      successfulStarts++
      t.start(h)
    },
    submit(out) { sent.push(...out.map(o => o.digest)); t.submit(out) },
  }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const digest = sent[0]!
    await p.shutdownA()
    p.carrier.setOnline('A', true)
    await p.reopen(false, () => { failStart = true })
    expect(sent.filter(d => d === digest)).toHaveLength(1)
    failStart = false
    await new Promise(r => setTimeout(r, 1150))
    await p.settle()
    expect(successfulStarts).toBe(2)
    p.clock.advance(60_000)
    await p.settle()
    expect(p.B().models()!.decisions, 'the timer restarted transport but must also offer held custody').toHaveLength(1)
  } finally { failStart = false; await p.close() }
})

it.each([false, true])('R14 stop failure=%s: a locked recipient must keep its carrier mailbox until reopening', async failStop => {
  let fail = false
  let stopAttempts = 0
  let bundleDigest = ''
  let accepted = 0
  const callbacks: { result: string }[] = []
  const p = await pair(t => ({ ...t,
    start(h) { t.start({ ...h, envelope: async env => {
      const result = await h.envelope(env)
      callbacks.push({ result })
      return result
    } }) },
    stop(h) {
      stopAttempts++
      if (fail) { fail = false; throw Error('temporary device stop failure') }
      t.stop(h)
    },
  }), t => ({ ...t,
    submit(out) {
      for (const o of out) if (o.type.includes('encounter-bundle')) bundleDigest = o.digest
      t.submit(out)
    },
    start(h) { t.start({ ...h, report(r) {
      if (r.digest === bundleDigest && r.status === 'accepted') accepted++
      h.report(r)
    } }) },
  }))
  try {
    const card = await p.A().intent<{ qr: string }>('showCard', '', 'card', {}).done
    if (!card.ok) throw Error('show')
    fail = failStop
    await p.shutdownA()
    expect((await p.B().intent('confirmCard', '', 'scan', {
      card: decodeCardLink(card.value.qr), role: 'displayed',
    }).done).ok).toBe(true)
    await p.settle()
    expect(bundleDigest).not.toBe('')
    expect(accepted, 'the sender was told that its carrier took the bundle').toBe(1)
    // a failed stop is tried again (R14-1 fix): one attempt without the fault, more with it
    expect(stopAttempts).toBeGreaterThanOrEqual(1)
    // whatever the retired reception still saw, it never refused for good
    expect(callbacks.every(c => c.result === 'later')).toBe(true)
    await p.reopen()
    await p.rounds(10)
    expect(p.A().models()!.decisions, JSON.stringify(callbacks)).toHaveLength(1)
  } finally { fail = false; await p.close() }
})

it('R14 resend: after a refused one-shot answer the next duplicate asks for another hand-over', async () => {
  let handlers: TransportHandlers | null = null
  let hold = false
  let bundle: unknown
  const sent: string[] = []
  const p = await pair(t => ({ ...t,
    start(h) { handlers = h; t.start(h) },
    submit(out) {
      sent.push(...out.filter(isAck).map(o => o.digest))
      if (hold) {
        for (const o of out) queueMicrotask(() => handlers!.report({
          digest: o.digest, status: 'awaiting-transport', reason: 'transport-unreachable',
        }))
      } else t.submit(out)
    },
  }), t => ({ ...t, submit(out) {
    for (const o of out) if (o.type.includes('encounter-bundle')) bundle = o
    t.submit(out)
  } }))
  const injector = p.carrier.endpoint('injector')
  const injected: TransportHandlers = { envelope: async () => 'not-mine', report: () => {} }
  injector.start(injected)
  try {
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    p.clock.advance(8 * DAY)
    p.foreground()
    await p.settle()
    hold = true
    injector.submit([bundle as never])
    await p.settle()
    const before = sent.length
    hold = false
    injector.submit([bundle as never])
    await p.settle()
    expect(sent.length).toBe(before + 1)
  } finally { injector.stop(injected); await p.close() }
})

it('R14 undo control: a failed construction waits for holder.close before releasing stores, writer or the next opening', async () => {
  let release!: () => void
  hooks.closeBarrier = new Promise<void>(r => { release = r })
  hooks.failProfile = true
  hooks.created = 0
  const released = vi.fn()
  const closedDb = vi.spyOn(IDBDatabase.prototype, 'close')
  const host = rltpHolderHost({
    idb: new IDBFactory(),
    clock: virtualClock(Date.parse('2026-10-20T10:00:00Z'), 'UTC'),
    entropy: fakeEntropy(14420),
    transport: unconfiguredTransport(),
    writer: { acquire: async () => released },
    publish() {}, emit() {}, onCurrent() {},
  })
  const keys = { rootIkm: new Uint8Array(64).fill(71), dek: new Uint8Array(32).fill(72) }
  const first = host.open('undo', keys).catch(e => e as Error)
  const second = host.open('undo', keys)
  try {
    await vi.waitFor(() => expect(hooks.created).toBe(1))
    await new Promise(r => setTimeout(r, 40))
    expect(hooks.created).toBe(1)
    expect(closedDb).not.toHaveBeenCalled()
    expect(released).not.toHaveBeenCalled()
    release()
    expect(await first).toBeInstanceOf(Error)
    const next = await second
    expect(next.kind).toBe('ok')
    if (next.kind === 'ok') await host.close(next.holder)
    expect(released).toHaveBeenCalledTimes(1)
  } finally {
    release()
    hooks.closeBarrier = null
    hooks.failProfile = false
    const next = await second
    if (next.kind === 'ok') await host.close(next.holder)
    closedDb.mockRestore()
  }
})
