// @vitest-environment node
// Regressions of the eighteenth review of #420 (rltp/design/store-launch-v3/app-review-420-18-2026-10-20.md,
// gpt-6.1-sol): R18-2 (a failed build whose holder close fails) and R18-3 (the matrix's faults reach A).
// R18-1 (carrier calls that threw and take effect later) at the end: bound calls (Anton, 20.10.).
import { afterEach, expect, it, vi } from 'vitest'
import { shareTransport, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { writableStore } from '../../src/port'
import { pair } from './pair'
import { IDBFactory } from 'fake-indexeddb'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { fakeEntropy, virtualClock } from '../../src/platform/fake'
import { lib as faults } from '../crash/transport-faults.lib'
import { CELLS, RUNS, run as runMatrix } from '../crash/transport-faults.harness'
import { virtualClock as transportClock } from '../../src/platform/fake'
/** the device clock of the shared transport's retries (#430) */
const tclock = transportClock(0, 'UTC')

interface HolderProbe {
  readonly closed: boolean
  close(): Promise<void>
  profile(): Promise<unknown>
  pendingTransport(when: number): Promise<unknown>
}
const hooks = vi.hoisted(() => ({ failBuild: false, failClose: false, holders: [] as HolderProbe[], closeCalls: 0, pendingFailedOn: [] as HolderProbe[] }))
vi.mock('@real-life/trust-protocol', async importOriginal => {
  const injection = await import('../crash/transport-faults.lib')
  const lib = await injection.mockLib(importOriginal) as unknown as { createHolder: (...args: unknown[]) => Promise<HolderProbe> }
  return { ...lib, createHolder: async (...args: Parameters<typeof lib.createHolder>) => {
    const h = await lib.createHolder(...args)
    hooks.holders.push(h)
    return {
      ...h,
      get closed() { return h.closed },
      pendingTransport(when: number) {
        // counted only where the injected fault fired
        const armed = injection.lib.failPending
        const result = h.pendingTransport(when)
        if (armed && !injection.lib.failPending) hooks.pendingFailedOn.push(h)
        return result
      },
      profile() {
        if (hooks.failBuild) { hooks.failBuild = false; return Promise.reject(Error('initial view read failed')) }
        return h.profile()
      },
      close() {
        hooks.closeCalls++
        if (hooks.failClose) { hooks.failClose = false; return Promise.reject(Error('close failed before ending holder')) }
        return h.close()
      },
    }
  } }
})
afterEach(async () => {
  faults.reset()
  hooks.failBuild = hooks.failClose = false
  for (const h of hooks.holders.splice(0)) await h.close()
  hooks.closeCalls = 0
  hooks.pendingFailedOn = []
})

it('R18 matrix: the pendingTransport fault exercises the observed holder A', async () => {
  // the seed that forces the cell
  await runMatrix(1 + (CELLS.indexOf('deposit/pendingTransport-rejects') % RUNS))
  expect(hooks.pendingFailedOn).toHaveLength(1)
  // First created holder: A. Second: B. Every subsequent opening is A again.
  expect(hooks.holders.indexOf(hooks.pendingFailedOn[0]!), 'green matrix counted the pendingTransport fault on unobserved B').not.toBe(1)
}, 60_000)

it.each([false, true])('R18 failed build (close fails=%s): acquired holder closes before next opening', async failClose => {
  const released = vi.fn()
  const host = rltpHolderHost({
    idb: new IDBFactory(), clock: virtualClock(Date.parse('2026-10-20T10:00:00Z'), 'UTC'),
    entropy: fakeEntropy(18420), writer: { acquire: async () => released },
    transport: { status: writableStore({ network: 'online', carrier: 'connected' }), start() {}, stop() {}, submit() {} },
    publish() {}, emit() {}, onCurrent() {},
  })
  const keys = { rootIkm: new Uint8Array(64).fill(41), dek: new Uint8Array(32).fill(42) }
  hooks.failBuild = true
  hooks.failClose = failClose
  await expect(host.open('build-fault', keys)).rejects.toThrow('initial view read failed')
  const first = hooks.holders[0]!
  expect.soft(released.mock.calls.length === 0 || first.closed, 'writer released before holder.close completed').toBe(true)
  const second = await host.open('build-fault', keys)
  try {
    expect(second.kind).toBe('ok')
    expect.soft(first.closed, 'next open did not close the failed build holder').toBe(true)
    if (failClose) expect.soft(hooks.closeCalls, 'orphaned holder close was never retried').toBeGreaterThan(1)
  } finally { if (second.kind === 'ok') await host.close(second.holder) }
})

// R18-1 (Anton 20.10.: bound calls): a carrier call that threw and takes effect later reaches only its
// own object. The carriers below honour the binding, as TRANSPORT.md requires of every carrier.
it.each([false, true])('R18-1 withdrawal (late effect=%s): never drops the next opening deposit', uncertain => {
  const held = new Set<{ digest: string }>()
  let late: (() => void) | undefined
  let fail = uncertain
  const shared = shareTransport({
    status: writableStore({ network: 'online', carrier: 'connected' }), start() {}, stop() {},
    submit(out) { for (const o of out) held.add(o) },
    withdraw(ds) {
      const drop = () => { for (const o of ds) held.delete(o) }
      if (fail) { fail = false; late = drop; throw Error('withdraw started, confirmation lost') }
      drop()
    },
  }, tclock)
  const old = shared.lease(), next = shared.lease()
  const h: TransportHandlers = { envelope: async () => 'taken', report() {} }
  old.start(h); old.activate(); old.submit([{ digest: 'same-bytes' } as never]); old.stop()
  next.start(h); next.activate()
  expect(next.submit([{ digest: 'same-bytes' } as never])).toBe(true)
  late?.()
  try { expect([...held].map(o => o.digest), 'old withdrawal deleted current opening deposit').toEqual(['same-bytes']) }
  finally { next.stop() }
})

it.each([false, true])('R18-1 stop (late effect=%s): the active generation keeps running', async uncertain => {
  let active: TransportHandlers | null = null
  let late: (() => void) | undefined
  let delay = uncertain
  const starts = vi.fn((h: TransportHandlers) => { active = h })
  const lease = shareTransport({
    status: writableStore({ network: 'online', carrier: 'connected' }), start: starts,
    stop(h) {
      const end = () => { if (active === h) active = null }
      if (delay) { delay = false; late = end; throw Error('stop started, confirmation lost') }
      end()
    },
    submit(out) { if (active) for (const o of out) active.report({ digest: o.digest, status: 'accepted' }) },
  }, tclock).lease()
  const reports = vi.fn()
  lease.start({ envelope: async () => 'taken', report: reports })
  lease.activate(); lease.deactivate(); lease.activate()
  expect(starts).toHaveBeenCalledTimes(2)
  late?.()
  expect(lease.ready()).toBe(true)
  lease.submit([{ digest: 'document' } as never])
  try { expect(reports, 'old stop killed new start').toHaveBeenCalled() }
  finally { lease.stop() }
})

it.each([false, true])('R18-1 real holders (late stop=%s): delivery goes on', async uncertain => {
  let late: (() => void) | undefined
  let fail = uncertain
  const start = vi.fn()
  const sent: string[] = []
  const p = await pair(t => ({ ...t,
    start(h) { start(); t.start(h) },
    stop(h) {
      if (fail) { fail = false; late = () => t.stop(h); throw Error('stop started, confirmation lost') }
      t.stop(h)
    },
    submit(out) { sent.push(...out.map(o => o.digest)); t.submit(out) },
  }))
  try {
    await p.reopen()
    late?.()
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const digest = sent[0]!
    for (let i = 0; i < 5; i++) { p.clock.advance(60_000); await p.settle() }
    expect(start).toHaveBeenCalledTimes(2)
    expect(p.B().models()!.decisions, 'one late stop suppresses every subsequent delivery').toHaveLength(1)
    expect((await p.state()).outbox[digest]!.history.some(h => h.status === 'accepted')).toBe(true)
  } finally { await p.close() }
})
