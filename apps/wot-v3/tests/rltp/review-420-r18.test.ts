// @vitest-environment node
// Regressions of the eighteenth review of #420 (rltp/design/store-launch-v3/app-review-420-18-2026-10-20.md,
// gpt-6.1-sol): R18-2 (a failed build whose holder close fails) and R18-3 (the matrix's faults reach A).
// The R18-1 probes (carrier calls that threw and take effect later) wait for Anton's decision.
import { afterEach, expect, it, vi } from 'vitest'
import { writableStore } from '../../src/port'
import { IDBFactory } from 'fake-indexeddb'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { fakeEntropy, virtualClock } from '../../src/platform/fake'
import { lib as faults } from '../crash/transport-faults.lib'
import { run as runMatrix } from '../crash/transport-faults.harness'

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

it('R18 matrix seed 7: pendingTransport fault must exercise observed holder A', async () => {
  // The real harness returns green, including its fired-cell accounting.
  await runMatrix(7)
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
