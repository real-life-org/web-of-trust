// @vitest-environment node
// Regressions of the seventeenth review of #420 (rltp/design/store-launch-v3/app-review-420-17-2026-10-20.md,
// gpt-6.1-sol): probes against the transport adapter contract (src/adapters/rltp/TRANSPORT.md).
import { expect, it, vi } from 'vitest'
import { pair, DAY } from './pair'
import { shareTransport, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { writableStore } from '../../src/port'
import { IDBFactory } from 'fake-indexeddb'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { fakeEntropy, virtualClock } from '../../src/platform/fake'
import { holderDbName } from '../../src/adapters/rltp/session'
import { idbHolderStore } from '../../src/adapters/rltp/store-idb'
import { createSealer } from '../../src/adapters/rltp/sealed'
import { decodeCardLink } from '../../src/adapters/rltp/card-link'

it('R17 uncertain deposit: throwing after enqueue must preserve the withdrawal obligation', () => {
  const pending = new Set<string>()
  /** the carrier binds a withdrawal to the deposit object (TRANSPORT.md, bound calls) */
  const held = new Set<{ digest: string }>()
  const withdraw = vi.fn((ds: readonly { digest: string }[]) => { for (const o of ds) { held.delete(o); if (![...held].some(x => x.digest === o.digest)) pending.delete(o.digest) } })
  const shared = shareTransport({
    status: writableStore({ network: 'online', carrier: 'connected' }),
    start() {}, stop() {}, withdraw,
    submit(out) {
      for (const o of out) { held.add(o); pending.add(o.digest) }
      throw Error('enqueue happened, service acceptance has not happened')
    },
  })
  const lease = shared.lease()
  lease.start({ envelope: async () => 'taken', report() {} })
  lease.activate()
  expect(lease.submit([{ digest: 'uncertain' } as never])).toBe(false)
  lease.withdraw(['uncertain'])
  lease.stop()
  expect(pending, 'an uncertain unaccepted deposit is still executable after withdrawal and stop').toEqual(new Set())
})

it('R17 two openings: stopping an old lease must not withdraw the current lease deposit', () => {
  const pending = new Set<string>()
  /** the carrier binds a withdrawal to the deposit object (TRANSPORT.md, bound calls) */
  const held = new Set<{ digest: string }>()
  const shared = shareTransport({
    status: writableStore({ network: 'online', carrier: 'connected' }),
    start() {}, stop() {},
    submit(out) { for (const o of out) { held.add(o); pending.add(o.digest) } },
    withdraw(ds) { for (const o of ds) { held.delete(o); if (![...held].some(x => x.digest === o.digest)) pending.delete(o.digest) } },
  })
  const old = shared.lease(), next = shared.lease()
  const handlers: TransportHandlers = { envelope: async () => 'taken', report() {} }
  old.start(handlers); old.activate()
  old.submit([{ digest: 'same-bytes' } as never])
  old.deactivate()
  next.start(handlers); next.activate()
  next.submit([{ digest: 'same-bytes' } as never])
  old.stop()
  try { expect(pending, 'old opening revoked the current opening deposit').toEqual(new Set(['same-bytes'])) }
  finally { next.stop() }
})

it.each(['subscribe', 'get-on-reconnect'] as const)('R17 connect/%s: one transient fault must not lose automatic recovery', async mode => {
  let fail = mode === 'subscribe'
  const sent: string[] = []
  const p = await pair(t => ({ ...t,
    status: {
      get() {
        if (mode === 'get-on-reconnect' && fail) { fail = false; throw Error('one status read failure') }
        return t.status.get()
      },
      subscribe(cb) {
        if (mode === 'subscribe' && fail) { fail = false; throw Error('one subscription failure') }
        return t.status.subscribe(cb)
      },
    },
    submit(out) { sent.push(...out.map(o => o.digest)); t.submit(out) },
  }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const digest = sent[0]!
    // Consume the earlier retry timer while the document is held/offline.
    p.clock.advance(60_000); await p.settle()
    expect((await p.state()).outbox[digest]!.history.at(-1)!.status).toBe('awaiting-transport')
    fail = mode === 'get-on-reconnect'
    p.carrier.setOnline('A', true)
    await p.settle()
    // Timers only; no foreground event, human act, new opening or explicit offer.
    for (let i = 0; i < 60; i++) { p.clock.advance(60_000); await p.settle() }
    expect(p.B().models()!.decisions, 'online carrier recovered, but the adapter never retries connect or the held document').toHaveLength(1)
  } finally { await p.close() }
})

it('R17 uncertain deposit integration: expiry and shutdown must withdraw a deposit whose submit threw', async () => {
  const pending = new Set<string>()
  /** the carrier binds a withdrawal to the deposit object (TRANSPORT.md, bound calls) */
  const held = new Set<{ digest: string }>()
  let fail = true
  const p = await pair(t => ({ ...t,
    submit(out) {
      for (const o of out) { held.add(o); pending.add(o.digest) }
      if (fail) { fail = false; throw Error('one-shot uncertain local deposit') }
    },
    withdraw(ds) { for (const o of ds) { held.delete(o); if (![...held].some(x => x.digest === o.digest)) pending.delete(o.digest) } },
  }))
  try {
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    p.clock.advance(8 * DAY); p.foreground(); await p.settle()
    const outbox = (await p.state()).outbox
    const failed = Object.keys(outbox).filter(d => outbox[d]!.history.at(-1)!.status === 'failed')
    expect(failed.length).toBeGreaterThan(0)
    await p.shutdownA()
    // the uncertain deposit is withdrawn at once (the hand-over comes again); nothing given up stays queued
    expect(failed.filter(d => pending.has(d)), 'a document absent from pendingTransport remains queued after expiry and shutdown').toEqual([])
  } finally { await p.close() }
})

it('R17 host overlap: closing the draining old opening must not withdraw the restored opening deposit', async () => {
  const idb = new IDBFactory(), clock = virtualClock(Date.parse('2026-10-20T10:00:00Z'), 'UTC')
  const pending = new Set<string>()
  /** the carrier binds a withdrawal to the deposit object (TRANSPORT.md, bound calls) */
  const held = new Set<{ digest: string }>()
  const deposits: string[] = []
  const keys = { rootIkm: new Uint8Array(64).fill(41), dek: new Uint8Array(32).fill(42) }
  const deps = {
    idb, clock, entropy: fakeEntropy(17420), writer: { acquire: async () => () => {} },
    publish() {}, emit() {}, onCurrent() {},
  }
  const A = rltpHolderHost({ ...deps, transport: {
    status: writableStore({ network: 'online', carrier: 'connected' }),
    start() {}, stop() {},
    submit(out) { for (const o of out) { held.add(o); pending.add(o.digest); deposits.push(o.digest) } },
    withdraw(ds) { for (const o of ds) { held.delete(o); if (![...held].some(x => x.digest === o.digest)) pending.delete(o.digest) } },
  } })
  const B = rltpHolderHost({ ...deps, transport: {
    status: writableStore({ network: 'online', carrier: 'connected' }),
    start() {}, stop() {}, submit() {},
  } })
  const a = await A.open('old', keys)
  const b = await B.open('peer', { rootIkm: new Uint8Array(64).fill(51), dek: new Uint8Array(32).fill(52) })
  if (a.kind !== 'ok' || b.kind !== 'ok') throw Error('open')
  A.activate?.(a.holder); B.activate?.(b.holder)
  const old = A.current()!
  const card = await B.current()!.intent<{ qr: string }>('showCard', '', 'r17-show', {}).done
  if (!card.ok) throw Error('show')
  expect((await old.intent('confirmCard', '', 'r17-scan', { card: decodeCardLink(card.value.qr), role: 'displayed' }).done).ok).toBe(true)
  await old.idle()
  const digest = [...pending][0]!
  const sealer = await createSealer(keys.dek)
  const source = idbHolderStore({ idb, name: holderDbName('old'), sealer, uuid: () => crypto.randomUUID(), seal: { sealed: false } })
  const target = idbHolderStore({ idb, name: holderDbName('restored'), sealer, uuid: () => crypto.randomUUID(), seal: { sealed: false } })
  // A restore snapshot: same owed bytes in another namespace, both real openings.
  expect((await target.commit(null, (await source.read()).state as Parameters<typeof target.commit>[1])).ok).toBe(true)
  const next = await A.open('restored', keys)
  if (next.kind !== 'ok') throw Error('restore open')
  let entered!: () => void, release!: () => void
  const reading = new Promise<void>(r => { entered = r })
  const barrier = new Promise<void>(r => { release = r })
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
  let paused = false
  const spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
    const aad = (args[0] as AesGcmParams).additionalData
    if (!paused && aad && new TextDecoder().decode(aad) === holderDbName('old')) {
      paused = true; entered(); await barrier
    }
    return decrypt(...args)
  })
  let closing: Promise<void> | undefined
  try {
    const profile = old.setProfile({ name: 'draining' }, 'r17-profile').catch(() => undefined)
    await reading
    closing = A.close(a.holder)
    const before = deposits.filter(d => d === digest).length
    A.activate?.(next.holder)
    await A.current()!.idle()
    expect(deposits.filter(d => d === digest)).toHaveLength(before + 1)
    expect(pending.has(digest)).toBe(true)
    release()
    await profile; await closing
    expect(pending.has(digest), 'old stop withdrew a deposit made by the restored opening during drain').toBe(true)
  } finally {
    release(); spy.mockRestore(); await closing
    await A.close(a.holder); await A.close(next.holder); await B.close(b.holder)
    source.close(); target.close()
  }
})
