// @vitest-environment node
// Regressions of Astra's twelfth review of #420 (rltp/design/store-launch-v3/app-review-420-12-2026-10-20.md).
import { expect, it, vi } from 'vitest'
import { pair, isAck, DAY } from './pair'
import { memoryCarrier, shareTransport, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { writableStore } from '../../src/port'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { fakeEntropy, virtualClock } from '../../src/platform/fake'
import { IDBFactory } from 'fake-indexeddb'

interface HolderProbe {
  readonly closed: boolean
  close(): Promise<void>
  resume(when: number): Promise<unknown>
  tick(when: number): Promise<unknown>
}
const hooks = vi.hoisted(() => ({ created: [] as HolderProbe[], fault: null as 'resume' | 'tick' | null }))
vi.mock('@real-life/trust-protocol', async importOriginal => {
  const lib = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<HolderProbe> }>()
  return { ...lib, createHolder: async (...args: unknown[]) => {
    const h = await lib.createHolder(...args)
    hooks.created.push(h)
    return {
      ...h,
      get closed() { return h.closed },
      resume: (when: number) => hooks.fault === 'resume' ? Promise.reject(Error('resume failed')) : h.resume(when),
      tick: (when: number) => hooks.fault === 'tick' ? Promise.reject(Error('tick failed')) : h.tick(when),
    }
  } }
})

it('R12-4 synchronous awaiting-transport must recover on network return and timers', async () => {
  let handlers: TransportHandlers | null = null
  let hold = true
  const attempts: string[] = []
  const p = await pair(t => ({
    ...t,
    start(h) { handlers = h; t.start(h) },
    submit(out) {
      attempts.push(...out.map(o => o.digest))
      if (hold) {
        for (const o of out) handlers!.report({ digest: o.digest, status: 'awaiting-transport', reason: 'offline' })
      } else t.submit(out)
    },
  }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    expect(attempts).toHaveLength(1)
    const digest = attempts[0]!
    hold = false
    p.carrier.setOnline('A', true)
    await p.rounds(10)
    expect(attempts.filter(d => d === digest), JSON.stringify((await p.state()).outbox[digest]?.history)).toHaveLength(2)
    expect(p.B().models()!.decisions).toHaveLength(1)
  } finally { await p.close() }
})

it('R12 control: a held ACK eventually answers a new stage-4 duplicate by timer', async () => {
  let handlers: TransportHandlers | null = null
  let hold = true
  let bundle: unknown
  const sent: string[] = []
  const p = await pair(t => ({
    ...t,
    start(h) { handlers = h; t.start(h) },
    submit(out) {
      for (const o of out) if (isAck(o)) sent.push(o.digest)
      if (hold) {
        const h = handlers!
        for (const o of out) queueMicrotask(() => h.report({ digest: o.digest, status: 'awaiting-transport', reason: 'transport-unreachable' }))
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
    expect(sent).toHaveLength(1)
    // Let the earlier due work run while transport is still unreachable. There is no network
    // offline/online transition when the carrier recovers; the duplicate itself is the new request.
    p.clock.advance(DAY)
    await p.settle()
    const before = sent.length
    hold = false
    injector.submit([bundle as never])
    await p.settle()
    p.clock.advance(60 * 60_000)
    await p.settle()
    expect(sent.length, 'the new duplicate grants a distinct hand-over despite a held original ACK').toBeGreaterThan(before)
  } finally { injector.stop(injected); await p.close() }
})

it('R12-3 a stopped lease must not route real memory-carrier reports into the next opening', async () => {
  const carrier = memoryCarrier()
  const shared = shareTransport(carrier.endpoint('A'))
  carrier.setOnline('A', false)
  const old = shared.lease()
  const first = vi.fn(), second = vi.fn()
  old.start({ envelope: async () => 'taken', report: first })
  old.activate()
  old.submit([{ digest: 'old-document' } as never])
  old.stop()
  const next = shared.lease()
  next.start({ envelope: async () => 'taken', report: second })
  next.activate()
  await carrier.settled()
  expect(second, 'generation of the report ended; no fallback to active').not.toHaveBeenCalled()
  next.stop()
})

it('R12-3 a late failed report must not terminate custody in the reopened real holder', async () => {
  const callbacks: TransportHandlers[] = []
  const sent: string[] = []
  const p = await pair(t => ({ ...t,
    start(h) { callbacks.push(h); t.start(h) },
    submit(out) { sent.push(...out.map(o => o.digest)); t.submit(out) },
  }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const digest = sent[0]!
    const old = callbacks[0]!
    await p.reopen()
    expect((await p.state()).outbox[digest]!.history.at(-1)!.status).toBe('awaiting-transport')
    // A result of the earlier deposit arrives after a new opening claimed this same digest.
    old.report({ digest, status: 'failed', reason: 'unroutable' })
    await p.settle()
    expect.soft((await p.state()).outbox[digest]!.history.at(-1)!.status).toBe('awaiting-transport')
    p.carrier.setOnline('A', true)
    await p.settle()
    expect(p.B().models()!.decisions).toHaveLength(1)
  } finally { await p.close() }
})

it('R12 R10 control: a regular document absent after retention cannot be resurrected', async () => {
  const submitted: string[] = []
  const p = await pair(t => ({ ...t, submit(out) {
    submitted.push(...out.map(o => o.digest)); t.submit(out)
  } }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const digest = submitted[0]!
    p.clock.advance(8 * DAY); p.foreground(); await p.settle()
    expect((await p.state()).outbox[digest]!.history.at(-1)!.status).toBe('failed')
    const before = submitted.filter(d => d === digest).length
    await p.shutdownA()
    p.clock.advance(100 * DAY)
    await p.reopen(true)
    expect((await p.state()).outbox[digest]).toBeUndefined()
    expect(submitted.filter(d => d === digest)).toHaveLength(before)
  } finally { await p.close() }
})

it('R12-2 a failed transport stop must not let the writer go before holder.close', async () => {
  hooks.created = []
  let failStop = true
  const released = vi.fn()
  const host = rltpHolderHost({
    idb: new IDBFactory(),
    clock: virtualClock(Date.parse('2026-10-20T10:00:00Z'), 'UTC'),
    entropy: fakeEntropy(12420),
    writer: { acquire: async () => released },
    transport: {
      status: writableStore({ network: 'online', carrier: 'connected' }),
      start() {}, submit() {},
      stop() { if (failStop) { failStop = false; throw Error('stop failed') } },
    },
    publish() {}, emit() {}, onCurrent() {},
  })
  const keys = { rootIkm: new Uint8Array(64).fill(71), dek: new Uint8Array(32).fill(72) }
  const first = await host.open('same', keys)
  if (first.kind !== 'ok') throw Error('open')
  host.activate?.(first.holder)
  try {
    await host.close(first.holder).catch(() => undefined)
    expect.soft(hooks.created[0]!.closed, 'holder.close must run even if stopping transport throws').toBe(true)
    if (!hooks.created[0]!.closed) expect.soft(released, 'no writer release with an unclosed holder').not.toHaveBeenCalled()
    const second = await host.open('same', keys)
    expect.soft(hooks.created.filter(h => !h.closed), 'at most one live holder for this store').toHaveLength(1)
    if (second.kind === 'ok') await host.close(second.holder)
  } finally {
    failStop = false
    await host.close(first.holder)
    for (const h of hooks.created) await h.close()
  }
})

it.each(['expiry', 'lock'] as const)('R12-1 %s during handOver store read must prevent the deposit', async mode => {
  const submitted: string[] = []
  const p = await pair(t => ({ ...t, submit(out) {
    submitted.push(...out.map(o => o.digest)); t.submit(out)
  } }))
  let release!: () => void
  const barrier = new Promise<void>(r => { release = r })
  let entered!: () => void
  const paused = new Promise<void>(r => { entered = r })
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
  let reads = 0
  let spy: ReturnType<typeof vi.spyOn> | undefined
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const digest = submitted[0]!
    spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      const aad = (args[0] as AesGcmParams).additionalData
      // pendingTransport reads first, handOver reads next; all prior work is settled.
      if (aad && new TextDecoder().decode(aad) === 'wot-v3-holder-A' && ++reads === 2) {
        entered()
        await barrier
      }
      return decrypt(...args)
    })
    p.carrier.setOnline('A', true)
    await paused
    // Tick is queued behind the running handOver. This is also a suspended browser waking after expiry.
    let shutdown: Promise<void> | undefined
    if (mode === 'expiry') p.clock.advance(8 * DAY)
    else shutdown = p.shutdownA()
    release()
    await shutdown
    await p.settle()
    expect(submitted.filter(d => d === digest), 'no hand-over after the deadline passed during the asynchronous read').toHaveLength(1)
  } finally { release(); spy?.mockRestore(); await p.close() }
})

it.each(['resume', 'tick'] as const)('R12 control: failed opening %s recovers by timer alone', async fault => {
  const sent: string[] = []
  const p = await pair(t => ({ ...t, submit(out) { sent.push(...out.map(o => o.digest)); t.submit(out) } }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const digest = sent[0]!
    hooks.fault = fault
    await p.reopen(true)
    p.carrier.setOnline('A', true)
    await p.settle()
    expect(sent.filter(d => d === digest)).toHaveLength(1)
    hooks.fault = null
    p.clock.advance(1000)
    await p.settle()
    expect(sent.filter(d => d === digest)).toHaveLength(2)
    expect(p.B().models()!.decisions).toHaveLength(1)
  } finally { hooks.fault = null; await p.close() }
})
