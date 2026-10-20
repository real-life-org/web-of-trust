// @vitest-environment node
// Regressions of the thirteenth review of #421 (rltp/design/store-launch-v3/app-review-421-13-2026-10-21.md,
// gpt-6.1-sol, confirmation round).
// Review-only probes: real holder, encrypted fake IndexedDB, real session and carrier.
import { afterEach, expect, it, vi } from 'vitest'
import { DAY, pair } from './pair'
import { webClock } from '../../src/platform/web'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import type { AppWrite } from '../../src/adapters/rltp/app-db'
import type { IntentRecord } from '../../src/adapters/rltp/journal'

const fault = vi.hoisted(() => ({
  finish: false, resume: false, replayFail: false,
  replayWait: null as Promise<void> | null, replayEntered: null as (() => void) | null,
  runningWait: null as Promise<void> | null, runningEntered: null as (() => void) | null,
  replayCalls: [] as string[],
}))
interface HolderLike {
  readonly closed: boolean
  resume(when: number): Promise<unknown>
  replay(actId: string, when: number): Promise<unknown>
}
vi.mock('@real-life/trust-protocol', async original => {
  const lib = await original<{ createHolder: (...args: unknown[]) => Promise<HolderLike> }>()
  return { ...lib, createHolder: async (...args: unknown[]) => {
    const h = await lib.createHolder(...args)
    return { ...h, get closed() { return h.closed },
      resume: (when: number) => fault.resume ? Promise.reject(Error('resume unavailable')) : h.resume(when),
      replay: async (actId: string, when: number) => {
        fault.replayCalls.push(actId)
        fault.replayEntered?.()
        await fault.replayWait
        if (fault.replayFail) throw Error('temporary journal read failure')
        return h.replay(actId, when)
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
        const rec = writes.find(w => w.store === 'intents')?.value as IntentRecord | undefined
        if (rec?.command === 'send' && rec.state === 'done' && fault.finish) throw Error('finish unavailable')
        if (rec?.command === 'send' && rec.state === 'running' && fault.runningWait) {
          fault.runningEntered?.()
          await fault.runningWait
        }
      }
      return db.write(writes)
    } }
  } }
})
afterEach(() => {
  fault.finish = fault.resume = fault.replayFail = false
  fault.replayWait = fault.replayEntered = fault.runningWait = fault.runningEntered = null
  fault.replayCalls = []
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
async function retained(p: Awaited<ReturnType<typeof pair>>, actId: string) {
  expect((await p.state() as unknown as { acts: Record<string, unknown> }).acts[actId], 'real holder still knows the result').toBeDefined()
}

it('R13: temporary replay failure at expiry must not discard a retained committed result', async () => {
  const { p, send, messages } = await ready()
  try {
    fault.finish = true
    const h = send('received already', 'read-failure')
    await h.done; await p.settle()
    expect(messages('B')).toHaveLength(1)
    await p.shutdownA()
    fault.finish = false
    fault.replayFail = true
    p.clock.advance(89.5 * DAY)
    await p.reopen(true)
    await retained(p, h.actId)
    expect((await p.intents()).find(r => r.actId === h.actId)?.state, 'failed read is not unknown-act').not.toBe('expired')
  } finally { fault.replayFail = fault.finish = false; await p.close() }
})

it('R13: failed first resume must not expire an open committed result before lookup', async () => {
  const { p, send } = await ready()
  try {
    fault.finish = true
    const h = send('retain until resume', 'resume-failure')
    await h.done; await p.settle()
    await p.shutdownA()
    fault.finish = false
    fault.resume = true
    fault.replayCalls = []
    p.clock.advance(89.5 * DAY)
    await p.reopen(true)
    await retained(p, h.actId)
    expect.soft(fault.replayCalls).not.toContain(h.actId)
    expect.soft((await p.intents()).find(r => r.actId === h.actId)?.state, 'open recovery waits for successful resume').not.toBe('expired')
    fault.resume = false
    p.foreground(); await p.settle()
    expect.soft((await p.intents()).find(r => r.actId === h.actId)?.state).toBe('done')
  } finally { fault.resume = fault.finish = false; await p.close() }
})

it('R13: a repeated gesture must leave a known not-yet-persisted refusal to its writer', async () => {
  const p = await pair()
  try {
    p.carrier.setOnline('B', false)
    await p.scan(); await p.settle()
    const id = p.A().models()!.contacts[0]!.id
    const send = () => p.A().intent('send', `c:${id}`, 'send|known-no', { contactId: id, text: 'held until ready', draftKey: 'known-no' })
    fault.finish = true
    const h = send()
    expect(await h.done).toMatchObject({ ok: false, error: { code: 'not-ready' } })
    await p.settle()
    fault.finish = false
    await send().done // before persistLater's +1000ms; same human gesture, same inputs
    p.clock.advance(1000); await p.settle()
    expect.soft((await p.intents()).find(r => r.actId === h.actId)).toMatchObject({ state: 'done', outcome: { ok: false, error: { code: 'not-ready' } } })
    expect.soft((await p.db.readAll()).log.get('msg:out:known-no')).toMatchObject({ held: 'not-ready', status: { phase: 'held' } })
  } finally { fault.finish = false; await p.close() }
})

it('R13: crossing expiry while a manual replay waits for running persistence must still adopt its result', async () => {
  const { p, send, messages } = await ready()
  let release = () => {}
  try {
    fault.finish = true
    const h = send('committed before delayed retry', 'crossing')
    await h.done; await p.settle()
    expect(messages('B')).toHaveLength(1)
    fault.finish = false
    fault.runningWait = new Promise<void>(r => { release = r })
    const entered = new Promise<void>(r => { fault.runningEntered = r })
    const retry = p.A().retryIntent(h.actId)
    await entered
    p.clock.advance(89.5 * DAY)
    await p.settle()
    release(); fault.runningWait = null
    await retry.done; await p.settle()
    await retained(p, h.actId)
    expect((await p.intents()).find(r => r.actId === h.actId)?.state).toBe('done')
  } finally { release(); fault.runningWait = null; fault.finish = false; await p.close() }
})

it('R13: overlapping expiry lookups must not overwrite a known settlement with expired', async () => {
  const { p, send } = await ready()
  let release = () => {}
  try {
    fault.finish = true
    const h = send('one settlement owns me', 'overlap')
    await h.done; await p.settle()
    fault.finish = false
    fault.replayWait = new Promise<void>(r => { release = r })
    const entered = new Promise<void>(r => { fault.replayEntered = r })
    p.clock.advance(89.5 * DAY)
    await entered
    p.foreground()
    await p.settle()
    release(); fault.replayWait = null
    await p.settle()
    await retained(p, h.actId)
    expect.soft(fault.replayCalls.filter(id => id === h.actId).length, 'expiry lookups must share ownership').toBe(1)
    expect.soft((await p.intents()).find(r => r.actId === h.actId)?.state).toBe('done')
    expect.soft((await p.db.readAll()).log.get('msg:out:overlap')).toMatchObject({ digest: expect.any(String) })
  } finally { release(); fault.replayWait = null; fault.finish = false; await p.close() }
})

it('R13: a refusal completed by its persistence retry must plan its own retention timer', async () => {
  const p = await pair()
  try {
    fault.finish = true
    const h = p.A().intent('send', 'c:gone', 'send|retry-gc', { contactId: 'gone', text: 'purge my finished record', draftKey: 'retry-gc' })
    await h.done; await p.settle()
    fault.finish = false
    p.clock.advance(1000); await p.settle()
    expect((await p.intents()).find(r => r.actId === h.actId)?.state).toBe('done')
    p.clock.advance(8 * DAY); await p.settle()
    expect((await p.intents()).find(r => r.actId === h.actId), 'P7D retention must run without activation').toBeUndefined()
  } finally { fault.finish = false; await p.close() }
})

it('R13: the web clock must not fire an 89-day journal timer immediately', async () => {
  // Real native timer, no fake timers: the 32-bit timeout limit applies to setTimeout.
  // In this node probe the overflowing delay warns and becomes 1ms.
  const wake = vi.fn()
  const cancel = webClock.setTimer(webClock.now() + 89 * DAY, wake)
  try {
    await new Promise<void>(r => setTimeout(r, 20))
    expect(wake, 'long deadlines must be split into supported timeout intervals').not.toHaveBeenCalled()
  } finally { cancel() }
})
