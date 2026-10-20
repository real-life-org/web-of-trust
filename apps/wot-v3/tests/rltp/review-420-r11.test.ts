// @vitest-environment node
// Adversarial review of 8e160220 (Astra's probes), adapted where noted. Expectations describe the custody contract.
import { expect, it, vi } from 'vitest'
import { DAY, isAck, pair } from './pair'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'
import { virtualClock } from '../../src/platform/fake'
import { secret } from '../../src/port'
import { IDBFactory, IDBDatabase } from 'fake-indexeddb'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { unconfiguredTransport, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { fakeEntropy } from '../../src/platform/fake'

interface HolderProbe { readonly closed: boolean; close(): Promise<void>; tick(when: number): Promise<unknown> }
const hooks = vi.hoisted(() => ({
  afterCreate: null as null | ((h: HolderProbe) => Promise<void>),
  closeBarrier: null as null | Promise<void>,
  failTick: false,
}))
vi.mock('@real-life/trust-protocol', async importOriginal => {
  const lib = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<HolderProbe> }>()
  return { ...lib, createHolder: async (...args: unknown[]) => {
    const h = await lib.createHolder(...args)
    await hooks.afterCreate?.(h)
    const barrier = hooks.closeBarrier
    return {
      ...h,
      get closed() { return h.closed },
      async close() { await h.close(); await barrier },
      tick: (when: number) => hooks.failTick ? Promise.reject(Error('injected tick storage failure')) : h.tick(when),
    }
  } }
})

it('R11-1: a duplicate answer whose deposit began offline is one hand-over (6330); the next redelivery is answered again; no copy waits on the device', async () => {
  let bundle: unknown
  let holdAnswer = false
  const sent: string[] = []
  const p = await pair(t => ({ ...t, submit(out) {
    if (holdAnswer && out.some(isAck)) p.carrier.setOnline('A', false)
    sent.push(...out.filter(isAck).map(o => o.digest))
    t.submit(out)
  } }), t => ({ ...t, submit(out) {
    for (const o of out) if (o.type.includes('encounter-bundle')) bundle = o
    t.submit(out)
  } }))
  const injector = p.carrier.endpoint('injector')
  const injected: TransportHandlers = { envelope: async () => 'not-mine', report: () => {} }
  injector.start(injected)
  try {
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    const ack = sent[0]!
    holdAnswer = true
    injector.submit([bundle as never])
    await p.settle()
    holdAnswer = false
    expect(sent.filter(d => d === ack)).toHaveLength(2)
    // the carrier kept no copy: going online sends nothing more
    const accepted = (await p.state())
    p.carrier.setOnline('A', true)
    await p.settle()
    expect(sent.filter(d => d === ack)).toHaveLength(2)
    expect(Object.values(accepted.effects).find(e => e.ack?.digest === ack)?.ack?.answerDue).toBeUndefined()
    await p.reopen(true)
    // the sender's next redelivery asks for the next answer
    injector.submit([bundle as never])
    await p.settle()
    expect(sent.filter(d => d === ack)).toHaveLength(3)
  } finally { injector.stop(injected); await p.close() }
})

it('R11: a buffered resend absent after effect retention must be withdrawn', async () => {
  let bundle: unknown
  let holdAnswer = false
  const accepted: string[] = []
  let ack = ''
  const p = await pair(t => ({ ...t,
    start(h) { t.start({ ...h, report(r) { if (r.status === 'accepted') accepted.push(r.digest); h.report(r) } }) },
    submit(out) {
      for (const o of out) if (isAck(o) && !ack) ack = o.digest
      if (holdAnswer && out.some(isAck)) p.carrier.setOnline('A', false)
      t.submit(out)
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
    holdAnswer = true
    injector.submit([bundle as never])
    await p.settle()
    p.clock.advance(100 * DAY)
    p.foreground()
    await p.settle()
    expect(Object.values((await p.state()).effects).some(e => e.ack)).toBe(false)
    const before = accepted.filter(d => d === ack).length
    p.carrier.setOnline('A', true)
    await p.settle()
    expect(accepted.filter(d => d === ack).length, 'no service acceptance of a resend the holder no longer names').toBe(before)
  } finally { injector.stop(injected); await p.close() }
})

it('R11: returning online at expiry cannot flush before asynchronous due transitions', async () => {
  const accepted: string[] = []
  let doc = ''
  const p = await pair(t => ({ ...t,
    submit(out) { for (const o of out) if (!isAck(o) && !doc) doc = o.digest; t.submit(out) },
    start(h) {
      t.start({ ...h, report(r) { if (r.status === 'accepted') accepted.push(r.digest); h.report(r) } })
    },
  }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    expect(accepted).toHaveLength(0)
    // Timer callbacks start async work. Network return is synchronous before that work commits.
    p.clock.advance(8 * DAY)
    p.carrier.setOnline('A', true)
    await p.settle()
    expect(accepted.filter(d => d === doc), 'an expired envelope must not reach the service').toHaveLength(0)
  } finally { await p.close() }
})

it('R11: a failed due tick in an already resumed opening cannot leave expired copies sendable', async () => {
  const accepted: string[] = []
  let doc = ''
  const p = await pair(t => ({ ...t,
    submit(out) { for (const o of out) if (!isAck(o) && !doc) doc = o.digest; t.submit(out) },
    start(h) {
      t.start({ ...h, report(r) { if (r.status === 'accepted') accepted.push(r.digest); h.report(r) } })
    },
  }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    hooks.failTick = true
    p.clock.advance(8 * DAY)
    p.foreground()
    await p.settle()
    p.carrier.setOnline('A', true)
    await p.settle()
    expect(accepted.filter(d => d === doc), '6135: no submission when due transitions could not be applied').toHaveLength(0)
  } finally { hooks.failTick = false; await p.close() }
})

it('R11: lock during opening then unlock cannot create two live holders over the same store', async () => {
  const clock = virtualClock(Date.parse('2026-10-20T10:00:00Z'), 'UTC')
  const A = await loopbackDevice({
    carrier: memoryCarrier(), clock, id: 'A', name: 'A',
    words: LOOPBACK_PHRASES[0], seed: 11420,
  })
  const ns = A.port.session()!.ns
  let entered!: () => void, release!: () => void
  const atClockRead = new Promise<void>(r => { entered = r })
  const barrier = new Promise<void>(r => { release = r })
  const created: HolderProbe[] = []
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
  let blocked = false
  const slowClockRead = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
    const aad = (args[0] as AesGcmParams).additionalData
    // Real await in build(): the holder exists, but host.open has not returned/adopted it.
    if (!blocked && aad && new TextDecoder().decode(aad) === `wot-v3-app-${ns}/kv/clock`) {
      blocked = true
      entered()
      await barrier
    }
    return decrypt(...args)
  })
  let opening: ReturnType<typeof A.port.runtime.unlock.open> | undefined
  try {
    await A.port.runtime.lock('user')
    expect((await A.port.runtime.unlock.passphrase(secret('harness passphrase'))).ok).toBe(true)
    hooks.afterCreate = async h => { created.push(h) }
    opening = A.port.runtime.unlock.open()
    await atClockRead
    await A.port.runtime.lock('user')
    expect((await A.port.runtime.unlock.passphrase(secret('harness passphrase'))).ok).toBe(true)
    const reopened = A.port.runtime.unlock.open()
    // A valid implementation waits here for the old construction and close.
    for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 5))
    const liveBeforeRelease = created.filter(h => !h.closed).length
    release()
    await opening
    await reopened
    expect(liveBeforeRelease, 'one opening per store also covers construction preempted by lock').toBeLessThanOrEqual(1)
  } finally { release(); await opening; hooks.afterCreate = null; slowClockRead.mockRestore(); await A.port.runtime.lock('user') }
})

it('R11: one refused activation hand-over recovers by timer without foreground or user action', async () => {
  let fail = false
  let refused = 0
  const p = await pair(t => ({ ...t, submit(out) {
    if (fail) { fail = false; refused++; throw Error('temporary carrier failure') }
    t.submit(out)
  } }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    fail = true
    await p.reopen()
    expect(refused).toBe(1)
    p.carrier.setOnline('A', true)
    for (let i = 0; i < 10; i++) { p.clock.advance(60_000); await p.settle() }
    expect(p.B().models()?.decisions, 'network return and timers must recover the refused hand-over').toHaveLength(1)
  } finally { await p.close() }
})

it.each(['close', 'forget'] as const)('R11 control: %s waits for holder.close before closing stores, releasing writer and reopening ns', async mode => {
  let release!: () => void
  const barrier = new Promise<void>(r => { release = r })
  hooks.closeBarrier = barrier
  const releases = vi.fn()
  let creations = 0
  hooks.afterCreate = async () => { creations++ }
  const closeDb = vi.spyOn(IDBDatabase.prototype, 'close')
  const keys = { rootIkm: new Uint8Array(64).fill(71), dek: new Uint8Array(32).fill(72) }
  const host = rltpHolderHost({
    idb: new IDBFactory(), clock: virtualClock(Date.parse('2026-10-20T10:00:00Z'), 'UTC'),
    entropy: fakeEntropy(11421), transport: unconfiguredTransport(),
    writer: { acquire: async () => releases }, publish: () => {}, emit: () => {}, onCurrent: () => {},
  })
  const first = await host.open('same', keys)
  if (first.kind !== 'ok') throw Error('open')
  let close: Promise<void> | undefined
  try {
    const before = closeDb.mock.calls.length
    if (mode === 'close') close = host.close(first.holder)
    else host.forget('same')
    const next = host.open('same', keys)
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5))
    expect(creations).toBe(1)
    expect(closeDb.mock.calls.length).toBe(before)
    expect(releases).not.toHaveBeenCalled()
    release()
    await close
    const second = await next
    expect(second.kind).toBe('ok')
    expect(creations).toBe(2)
    if (second.kind === 'ok') await host.close(second.holder)
    expect(releases).toHaveBeenCalledTimes(1)
  } finally { release(); await close; hooks.closeBarrier = null; hooks.afterCreate = null; closeDb.mockRestore() }
})
