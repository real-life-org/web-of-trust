// @vitest-environment node
// Regressions of the sixteenth review of #420 (rltp/design/store-launch-v3/app-review-420-16-2026-10-20.md,
// gpt-6.1-sol): probes against the transport adapter contract (src/adapters/rltp/TRANSPORT.md).
import { expect, it, vi } from 'vitest'
import { pair, DAY } from './pair'
import { shareTransport, TRANSPORT_RETRY_MS, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { writableStore } from '../../src/port'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { IDBFactory } from 'fake-indexeddb'
import { fakeEntropy, virtualClock } from '../../src/platform/fake'
import { virtualClock as transportClock } from '../../src/platform/fake'
/** the device clock of the shared transport's retries (#430) */
const tclock = transportClock(0, 'UTC')

interface HolderProbe {
  readonly closed: boolean
  receive(env: unknown, when: number): Promise<unknown>
  setProfile(...args: unknown[]): Promise<unknown>
}
const hooks = vi.hoisted(() => ({
  transient: null as string | null,
  receiveHold: null as Promise<void> | null,
  received: null as (() => void) | null,
  profileHold: null as Promise<void> | null,
}))
vi.mock('@real-life/trust-protocol', async importOriginal => {
  const lib = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<HolderProbe> }>()
  return { ...lib, createHolder: async (...args: unknown[]) => {
    const h = await lib.createHolder(...args)
    return {
      ...h,
      get closed() { return h.closed },
      async receive(env: unknown, when: number) {
        if (hooks.transient) {
          const reason = hooks.transient
          hooks.transient = null
          return { disposition: 'failed', reason, stage: 8 }
        }
        const result = await h.receive(env, when)
        const hold = hooks.receiveHold
        hooks.received?.()
        await hold
        return result
      },
      async setProfile(...args: unknown[]) {
        await hooks.profileHold
        return h.setProfile(...args)
      },
    }
  } }
})

it('R16 withdraw: a one-shot withdrawal fault is retried before the old deposit can complete', async () => {
  let fail = true
  const pending: string[] = []
  const withdraw = vi.fn((deposits: readonly { digest: string }[]) => {
    if (fail) { fail = false; throw Error('one-shot withdraw failure') }
    for (const { digest: d } of deposits) {
      const i = pending.indexOf(d)
      if (i >= 0) pending.splice(i, 1)
    }
  })
  const shared = shareTransport({
    status: writableStore({ network: 'online', carrier: 'connected' }),
    start() {}, stop() {},
    submit(out) { pending.push(...out.map(o => o.digest)) },
    withdraw,
  }, tclock)
  const lease = shared.lease()
  lease.start({ envelope: async () => 'taken', report() {} })
  lease.activate()
  lease.submit([{ digest: 'no-longer-named' } as never])
  lease.withdraw(['no-longer-named'])
  // Both another explicit withdrawal and shutdown should preserve a failed obligation.
  lease.withdraw(['no-longer-named'])
  lease.stop()
  tclock.advance(TRANSPORT_RETRY_MS) // the retry runs on the device clock (#430)
  expect(pending, 'a not-yet-accepted deposit remains able to leave after shutdown').toEqual([])
})

it('R16 receive: rate-limited must retain the carrier copy', async () => {
  const answers: string[] = []
  const p = await pair(t => ({ ...t, start(h) {
    t.start({ ...h, async envelope(env) {
      const a = await h.envelope(env)
      answers.push(a)
      return a
    } })
  } }))
  try {
    hooks.transient = 'rate-limited'
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    expect.soft(answers[0], 'a transient holder refusal is not positive takeover').toBe('later')
    p.clock.advance(1000) // the retry and the redelivery run on the device clock (#430)
    await p.settle()
    expect(p.A().models()!.decisions, 'recovered receiver must get the retained bundle').toHaveLength(1)
  } finally { hooks.transient = null; await p.close() }
})

it('R16 drain: an already-running receive must not acknowledge after host.close detaches the opening', async () => {
  let releaseReceive!: () => void, releaseProfile!: () => void, entered!: () => void
  const incoming = new Promise<void>(r => { entered = r })
  const answers: string[] = []
  let callbacks!: TransportHandlers
  const released = vi.fn()
  const host = rltpHolderHost({
    idb: new IDBFactory(), clock: virtualClock(Date.parse('2026-10-20T10:00:00Z'), 'UTC'),
    entropy: fakeEntropy(16420), writer: { acquire: async () => released },
    transport: {
      status: writableStore({ network: 'online', carrier: 'connected' }),
      start(h) { callbacks = h }, stop() {}, submit() {},
    },
    publish() {}, emit() {}, onCurrent() {},
  })
  const opened = await host.open('drain', { rootIkm: new Uint8Array(64).fill(41), dek: new Uint8Array(32).fill(42) })
  if (opened.kind !== 'ok') throw Error('open')
  host.activate?.(opened.holder)
  const session = host.current()!
  await session.idle()
  let closing: Promise<void> | undefined
  try {
    hooks.receiveHold = new Promise(r => { releaseReceive = r })
    hooks.received = entered
    const receive = callbacks.envelope({}).then(a => { answers.push(a) })
    await incoming
    hooks.profileHold = new Promise(r => { releaseProfile = r })
    const profile = session.setProfile({ name: 'draining' }, 'r16-profile').catch(() => undefined)
    closing = host.close(opened.holder)
    expect(host.current()).toBeNull()
    expect(released).not.toHaveBeenCalled()
    releaseReceive()
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
    await receive
    expect.soft(answers[0], 'the gate closed but the lease is still live throughout the drain').toBe('later')
    releaseProfile()
    await profile
    await closing
  } finally {
    releaseReceive?.(); releaseProfile?.()
    hooks.receiveHold = hooks.profileHold = null
    hooks.received = null
    await closing
    await host.close(opened.holder)
  }
})

it('R16 withdrawal on expiry: a failed withdrawal must not outlive its holder entry', async () => {
  let fail = true
  const pending: string[] = []
  const p = await pair(t => ({ ...t,
    submit(out) { pending.push(...out.map(o => o.digest)) },
    withdraw(deposits) {
      if (fail) { fail = false; throw Error('one-shot withdraw failure') }
      for (const { digest: d } of deposits) {
        let i: number
        while ((i = pending.indexOf(d)) >= 0) pending.splice(i, 1)
      }
    },
  }))
  try {
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const digest = pending[0]!
    p.clock.advance(8 * DAY); p.foreground(); await p.settle()
    expect((await p.state()).outbox[digest]!.history.at(-1)!.status).toBe('failed')
    await p.shutdownA()
    expect(pending, 'expired submission still held by carrier after the lease forgot its digest').toEqual([])
  } finally { await p.close() }
})

it.each(['delivered', 'failed'] as const)('R16 reports: accepted must not suppress a later %s from the same generation', async status => {
  let callbacks!: TransportHandlers
  const deposits: string[] = []
  const p = await pair(t => ({ ...t,
    start(h) { callbacks = h; t.start(h) },
    submit(out) { deposits.push(...out.map(o => o.digest)) },
  }))
  try {
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const digest = deposits[0]!
    callbacks.report({ digest, status: 'accepted' })
    await p.settle()
    expect((await p.state()).outbox[digest]!.history.at(-1)!.status).toBe('accepted')
    callbacks.report(status === 'delivered'
      ? { digest, status, late: false }
      : { digest, status, reason: 'unroutable' })
    await p.settle()
    expect((await p.state()).outbox[digest]!.history.at(-1)!.status, 'positive service report was silently dropped').toBe(status)
  } finally { await p.close() }
})

it('R16 reports: a late delivered after failed still belongs to this opening', async () => {
  let callbacks!: TransportHandlers
  let digest = ''
  const p = await pair(t => ({ ...t,
    start(h) { callbacks = h; t.start(h) },
    submit(out) { digest ||= out[0]!.digest },
  }))
  try {
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    callbacks.report({ digest, status: 'failed', reason: 'unroutable' })
    await p.settle()
    expect((await p.state()).outbox[digest]!.history.at(-1)!.status).toBe('failed')
    callbacks.report({ digest, status: 'delivered', late: true })
    await p.settle()
    expect((await p.state()).outbox[digest]!.history.at(-1)!.status).toBe('delivered')
  } finally { await p.close() }
})

it('R16 control: reactivating the same lease gives fresh handlers and rejects old replies', async () => {
  const generations: TransportHandlers[] = []
  const report = vi.fn()
  const lease = shareTransport({
    status: writableStore({ network: 'online', carrier: 'connected' }),
    start(h) { generations.push(h) }, stop() {}, submit() {},
  }, tclock).lease()
  lease.start({ envelope: async () => 'taken', report })
  lease.activate()
  lease.submit([{ digest: 'same-digest' } as never])
  lease.deactivate()
  lease.activate()
  lease.submit([{ digest: 'same-digest' } as never])
  expect(generations).toHaveLength(2)
  expect(await generations[0]!.envelope({})).toBe('later')
  generations[0]!.report({ digest: 'same-digest', status: 'accepted' })
  expect(report).not.toHaveBeenCalled()
  generations[1]!.report({ digest: 'same-digest', status: 'accepted' })
  expect(report).toHaveBeenCalledTimes(1)
  lease.stop()
})

it.each(['throws', 'stops'] as const)('R16 control: synchronous delivery in a start that then %s answers later', async mode => {
  let answer!: Promise<string>
  let fail = true
  const shared = shareTransport({
    status: writableStore({ network: 'online', carrier: 'connected' }),
    start(h) {
      answer = h.envelope({})
      if (mode === 'throws' && fail) { fail = false; throw Error('start failed after synchronous delivery') }
    }, stop() {}, submit() {},
  }, tclock)
  const lease = shared.lease()
  lease.start({ envelope: async () => { if (mode === 'stops') lease.stop(); return 'taken' }, report() {} })
  lease.activate()
  expect(await answer).toBe('later')
  lease.stop()
  // Let the retry retire its failed start before leaving the test (device time, #430).
  if (mode === 'throws') tclock.advance(TRANSPORT_RETRY_MS)
})
