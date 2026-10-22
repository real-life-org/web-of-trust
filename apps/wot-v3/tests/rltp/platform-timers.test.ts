// @vitest-environment node
// Platform step: every delay of the rltp adapter is a timer on the device clock (#430), and a holder
// close is bounded (§2.1 rule 9 S2/S5): a host that hangs never holds a lock or the next unlock, the
// opening stays registered and closing, the diagnostic store gets the code.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { IDBFactory } from 'fake-indexeddb'
import { expect, it, vi } from 'vitest'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { CLOSE_LIMIT_MS, HolderCloseTimeout } from '../../src/adapters/rltp/session'
import { shareTransport, TRANSPORT_RETRY_MS, unconfiguredTransport, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { writableStore } from '../../src/port'
import { fakeEntropy, virtualClock } from '../../src/platform/fake'

const hold = vi.hoisted(() => ({ close: null as Promise<void> | null }))
vi.mock('@real-life/trust-protocol', async (original) => {
  const lib = await original<{ createHolder: (...a: unknown[]) => Promise<{ close(): Promise<void> }> }>()
  return {
    ...lib,
    createHolder: async (...a: unknown[]) => {
      const h = await lib.createHolder(...a)
      return Object.assign(Object.create(Object.getPrototypeOf(h) as object) as object, h, {
        close: async () => {
          if (hold.close) await hold.close
          return h.close()
        },
      })
    },
  }
})

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

it('#430: no wall-clock delay in adapters/rltp (only zero-delay turn yields)', () => {
  const dir = path.resolve(__dirname, '../../src/adapters/rltp')
  const found: string[] = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const code = readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    for (const m of code.matchAll(/setTimeout\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) if (!/,\s*0\s*$/.test(m[1] ?? '')) found.push(`${f}: ${m[0]}`)
    for (const m of code.matchAll(/setInterval\(/g)) found.push(`${f}: ${m[0]}`)
  }
  expect(found).toEqual([])
})

it('#430: a refused start is retried after the retry delay of device time, not before', () => {
  const clock = virtualClock(0, 'UTC')
  let fail = true
  const starts: TransportHandlers[] = []
  const shared = shareTransport(
    {
      status: writableStore({ network: 'online', carrier: 'connected' }),
      start(h) {
        starts.push(h)
        if (fail) {
          fail = false
          throw Error('refused')
        }
      },
      stop() {},
      submit() {},
    },
    clock,
  )
  const lease = shared.lease()
  lease.start({ envelope: async () => 'taken', report() {} })
  lease.activate()
  expect(starts).toHaveLength(1)
  clock.advance(TRANSPORT_RETRY_MS - 1)
  expect(starts).toHaveLength(1)
  clock.advance(1)
  expect(starts).toHaveLength(2)
  expect(lease.ready()).toBe(true)
  lease.stop()
})

it('one shutdown (quiesce, then close) shares one 2 s window (review 432 R1-11)', async () => {
  const clock = virtualClock(Date.parse('2026-10-21T10:00:00Z'), 'UTC')
  const host = rltpHolderHost({
    idb: new IDBFactory(), clock, entropy: fakeEntropy(4310), transport: unconfiguredTransport(),
    writer: { acquire: async () => () => {} }, publish: () => {}, emit: () => {}, onCurrent: () => {},
  })
  const opened = await host.open('ns2', { rootIkm: new Uint8Array(64).fill(3), dek: new Uint8Array(32).fill(4) })
  if (opened.kind !== 'ok') throw Error('open')
  let release!: () => void
  hold.close = new Promise<void>((r) => (release = r))
  let outcome: unknown = 'pending'
  const shutdown = (async () => {
    await host.quiesce(opened.holder)
    await host.close(opened.holder)
  })()
  shutdown.then(() => (outcome = 'closed'), (e: unknown) => (outcome = e))
  await flush()
  clock.advance(CLOSE_LIMIT_MS)
  await flush()
  expect(outcome).toBeInstanceOf(HolderCloseTimeout)
  release()
  hold.close = null
  await flush()
  await host.close(opened.holder)
})

it('S2/S5: a hanging holder close is bounded; the opening stays registered, the next open fails instead of waiting, and closes once the host returns', async () => {
  const clock = virtualClock(Date.parse('2026-10-21T10:00:00Z'), 'UTC')
  const recorded: string[] = []
  const host = rltpHolderHost({
    idb: new IDBFactory(),
    clock,
    entropy: fakeEntropy(4300),
    transport: unconfiguredTransport(),
    writer: { acquire: async () => () => {} },
    diagnostics: { record: (e) => (recorded.push(e.code), 'd1' as never) },
    publish: () => {},
    emit: () => {},
    onCurrent: () => {},
  })
  const keys = { rootIkm: new Uint8Array(64).fill(7), dek: new Uint8Array(32).fill(8) }
  const opened = await host.open('ns1', keys)
  if (opened.kind !== 'ok') throw Error('open')
  host.activate?.(opened.holder)

  let release!: () => void
  hold.close = new Promise<void>((r) => (release = r))
  const closing = host.close(opened.holder)
  let outcome: unknown = 'pending'
  closing.then(
    () => (outcome = 'closed'),
    (e: unknown) => (outcome = e),
  )
  await flush()
  expect(outcome).toBe('pending')
  clock.advance(CLOSE_LIMIT_MS)
  await flush()
  expect(outcome).toBeInstanceOf(HolderCloseTimeout)
  expect(recorded).toEqual(['holder-close-timeout'])

  // the next open of the namespace tries the close again, within the same bound, and then fails
  const again = host.open('ns1', keys)
  let second: unknown = 'pending'
  again.then(
    (r) => (second = r),
    (e: unknown) => (second = e),
  )
  await flush()
  clock.advance(CLOSE_LIMIT_MS)
  await flush()
  expect(second).toBeInstanceOf(HolderCloseTimeout)

  // the host returns: the next open closes the earlier opening and opens the namespace
  release()
  hold.close = null
  await flush()
  const third = await host.open('ns1', keys)
  expect(third.kind).toBe('ok')
  if (third.kind === 'ok') await host.close(third.holder)
})
