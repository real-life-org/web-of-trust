// @vitest-environment node
// Regressions of the eleventh review of #421 (rltp/design/store-launch-v3/app-review-421-11-2026-10-21.md,
// gpt-6.1-sol).
// Adversarial probes for review #421, round 11. Production code is unchanged.
import { afterEach, expect, it, vi } from 'vitest'
import { DAY, pair } from './pair'
import type { AppWrite } from '../../src/adapters/rltp/app-db'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import type { IntentRecord } from '../../src/adapters/rltp/journal'

const fault = vi.hoisted(() => ({
  finish: false, confirmFinish: false, running: false, all: false, resume: false,
  sync: false, failSyncAfterRefusal: false,
  replayCalls: 0, replayWait: null as Promise<void> | null,
  replayEntered: null as (() => void) | null,
  sendCalls: [] as string[],
}))
interface HolderLike {
  readonly closed: boolean
  resume(when: number): Promise<unknown>
  replay(actId: string, when: number): Promise<unknown>
  sendMessage(contact: string, text: string, opts: { actId: string }): Promise<unknown>
}
vi.mock('@real-life/trust-protocol', async original => {
  const lib = await original<{ createHolder: (...args: unknown[]) => Promise<HolderLike> }>()
  return { ...lib, createHolder: async (...args: unknown[]) => {
    const h = await lib.createHolder(...args)
    return { ...h, get closed() { return h.closed },
      resume: (when: number) => fault.resume ? Promise.reject(Error('resume unavailable')) : h.resume(when),
      replay: async (actId: string, when: number) => {
        fault.replayCalls++
        fault.replayEntered?.()
        await fault.replayWait
        return h.replay(actId, when)
      },
      sendMessage: (contact: string, text: string, opts: { actId: string }) => {
        fault.sendCalls.push(opts.actId)
        return h.sendMessage(contact, text, opts)
      },
    }
  } }
})
vi.mock('../../src/adapters/rltp/app-db', async original => {
  const lib = await original<typeof AppDbModule>()
  return { ...lib, idbAppDb: (opts: Parameters<typeof lib.idbAppDb>[0]) => {
    const db = lib.idbAppDb(opts)
    return { ...db, async write(writes: readonly AppWrite[]) {
      if (opts.name.endsWith('-A')) {
        if (fault.all) throw Error('app unavailable')
        const rec = writes.find(w => w.store === 'intents')?.value as IntentRecord | undefined
        if (rec?.command === 'send' && rec.state === 'done' && fault.finish) throw Error('finish unavailable')
        if (rec?.command === 'confirmCard' && rec.state === 'done' && fault.confirmFinish) throw Error('confirm finish unavailable')
        if (rec?.command === 'send' && rec.state === 'running' && fault.running) throw Error('running unavailable')
        if (rec?.state === 'done' && rec.outcome?.ok === false && fault.failSyncAfterRefusal) fault.sync = true
        if (fault.sync && writes.some(w => w.store === 'kv' && w.key === 'applied')) throw Error('sync unavailable')
      }
      return db.write(writes)
    } }
  } }
})
afterEach(() => {
  fault.finish = fault.confirmFinish = fault.running = fault.all = fault.resume = fault.sync = fault.failSyncAfterRefusal = false
  fault.replayWait = fault.replayEntered = null
  fault.replayCalls = 0
  fault.sendCalls = []
})
async function ready() {
  const p = await pair()
  await p.scan(); await p.settle()
  const bId = p.B().models()!.contacts[0]!.id
  await p.B().intent('counterVerify', bId, 'counter', { contactId: bId }).done
  await p.settle()
  const aId = p.A().models()!.contacts[0]!.id
  const send = (text: string, key: string) => p.A().intent('send', `c:${aId}`, `send|${key}`, { contactId: aId, text, draftKey: key })
  const messages = (side: 'A' | 'B') => p[side]().models()!.conversations.get(`c:${side === 'A' ? aId : bId}`)!.items.filter(i => i.kind === 'message')
  return { p, send, messages }
}

it.each([false, true])('R11-1: delayed refusal finish must not send twice (sync fault=%s)', async failSync => {
  const p = await pair()
  try {
    p.carrier.setOnline('B', false)
    await p.scan(); await p.settle()
    const aId = p.A().models()!.contacts[0]!.id
    fault.failSyncAfterRefusal = failSync
    const h = p.A().intent('send', `c:${aId}`, 'send|held-race', { contactId: aId, text: 'one gesture', draftKey: 'held-race' })
    expect(await h.done).toMatchObject({ ok: false, error: { code: 'not-ready' } })
    fault.failSyncAfterRefusal = fault.sync = false
    // The original refusal is already durable. Before its retry timer, the relationship is ready
    // and the held draft is sent under a new actId.
    p.carrier.setOnline('B', true); await p.settle()
    const bId = p.B().models()!.contacts[0]!.id
    const received = () => p.B().models()!.conversations.get(`c:${bId}`)!.items.filter(i => i.kind === 'message')
    // the carrier offers again on its own clock (REDELIVER_MS, real time): wait for it, not a fixed pass
    await vi.waitFor(async () => { await p.settle(); expect(received()).toHaveLength(1) }, { timeout: 10_000, interval: 50 })
    p.clock.advance(1000); await p.settle()
    expect(received(), 'the old refusal closure must not replace the successful line by held').toHaveLength(1)
  } finally { fault.failSyncAfterRefusal = fault.sync = false; await p.close() }
})

it.each([false, true])('R11-2: no second mid after rollback and failed resume (replay write fault=%s)', async failRunning => {
  const { p, send, messages } = await ready()
  try {
    fault.finish = true
    const h = send('one human gesture', 'blind-regression')
    await h.done; await p.settle()
    expect(messages('B')).toHaveLength(1)
    fault.running = failRunning
    p.clock.advance(2000); await p.settle()
    const rec = (await p.intents()).find(r => r.actId === h.actId)!
    expect.soft(rec.state, 'a failed replay write cannot prove the original act never started').not.toBe('journaled')
    fault.all = true
    p.clock.advance(91 * DAY); p.foreground(); await p.settle()
    await p.shutdownA()
    p.clock.advance(-90 * DAY)
    fault.all = fault.finish = fault.running = false
    fault.resume = true
    await p.reopen(true)
    // Repeating the same send gesture is a recovery entry point too.
    await send('one human gesture', 'blind-regression').done
    const minted = (await p.state() as unknown as { acts: Record<string, unknown> }).acts[h.actId]
    expect.soft(minted, 'the retained-away act must not be recreated while resume failed').toBeUndefined()
    fault.resume = false
    p.foreground(); await p.settle()
    expect.soft(messages('B'), 'one actId must never yield two received messages').toHaveLength(1)
  } finally { fault.all = fault.finish = fault.running = fault.resume = false; await p.close() }
})

it('R11-3: retryIntent and the original gesture must share one execution', async () => {
  const { p, send } = await ready()
  let release = () => {}
  try {
    fault.finish = true
    const first = send('one replay', 'join-manual')
    await first.done; await p.settle()
    fault.finish = false
    fault.replayWait = new Promise<void>(r => { release = r })
    const entered = new Promise<void>(r => { fault.replayEntered = r })
    const retry = p.A().retryIntent(first.actId)
    await entered
    const same = send('one replay', 'join-manual')
    // Wait for the second app-db read/write to reach the library wrapper.
    await p.settle()
    expect.soft(fault.replayCalls, 'retry key and gesture key may not run the same act concurrently').toBe(1)
    release()
    await retry.done; await same.done
  } finally { release(); fault.finish = false; fault.replayWait = null; await p.close() }
})

it('R11-4: a finished refusal is purged with timers alone even when the holder has no due work', async () => {
  const p = await pair()
  try {
    const h = p.A().intent('send', 'c:gone', 'send|purge', { contactId: 'gone', text: 'keep log, purge intent', draftKey: 'purge' })
    await h.done; await p.settle()
    expect((await p.intents()).find(r => r.actId === h.actId)?.state).toBe('done')
    p.clock.advance(8 * DAY); await p.settle()
    expect((await p.intents()).find(r => r.actId === h.actId), 'done retention must schedule its own cleanup').toBeUndefined()
  } finally { await p.close() }
})

it('R11-4: a never-started act expires with timers alone even when the holder has no due work', async () => {
  const p = await pair()
  try {
    fault.running = true
    const h = p.A().intent('send', 'c:gone', 'send|expiry', { contactId: 'gone', text: 'must expire', draftKey: 'expiry' })
    await h.done; await p.settle()
    for (const delta of [2000, 10_000, 60_000]) { p.clock.advance(delta); await p.settle() }
    p.clock.advance(90 * DAY); await p.settle()
    expect((await p.intents()).find(r => r.actId === h.actId)?.state).toBe('expired')
  } finally { fault.running = false; await p.close() }
})

it('R11-5: a committed confirm-again act is recovered by reading its result, without another confirmation', async () => {
  const p = await pair()
  try {
    fault.confirmFinish = true
    await p.scan(); await p.settle()
    const rec = (await p.intents()).find(r => r.command === 'confirmCard')!
    expect(rec.state).toBe('needs-confirmation')
    expect((await p.state() as unknown as { acts: Record<string, unknown> }).acts[rec.actId]).toBeDefined()
    fault.confirmFinish = false
    fault.replayCalls = 0
    await p.reopen(true)
    expect.soft(fault.replayCalls, 'known encounter results are readable without executing an act').toBeGreaterThan(0)
    expect.soft((await p.intents()).find(r => r.actId === rec.actId)?.state).toBe('done')
  } finally { fault.confirmFinish = false; await p.close() }
})
