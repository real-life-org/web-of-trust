// @vitest-environment node
// Regressions of the tenth review of #421 (rltp/design/store-launch-v3/app-review-421-10-2026-10-20.md).
// Since lib 0.6.1 an open record is settled through holder.replay and expires one day before the
// library's act journal retention (P90D), not at P7D: the expiry probes wait that long.
import { expect, it, vi } from 'vitest'
import { DAY, pair } from './pair'
import type { AppWrite } from '../../src/adapters/rltp/app-db'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import type { IntentRecord } from '../../src/adapters/rltp/journal'

const fault = vi.hoisted(() => ({
  finish: false, all: false, resume: false, sendLost: false, sendAfterCommit: false, receiveAs: null as string | null, running: false, expire: false, expiredAttempts: 0,
  wait: null as Promise<void> | null, entered: null as (() => void) | null,
}))
// the core library is the adapter's alone (architecture §0.1): the test sees it only through the mock
interface HolderLike {
  readonly closed: boolean
  resume(when: number): Promise<unknown>
  receive(env: unknown, when: number): Promise<unknown>
  sendMessage(...args: unknown[]): Promise<unknown>
}
vi.mock('@real-life/trust-protocol', async original => {
  const lib = await original<{ createHolder: (...args: unknown[]) => Promise<HolderLike>; InfraError: new (code: string, message: string) => Error }>()
  return { ...lib, createHolder: async (...args: unknown[]) => {
    const h = await lib.createHolder(...args)
    return { ...h, get closed() { return h.closed },
      resume: (when: number) => fault.resume ? Promise.reject(Error('resume storage unavailable')) : h.resume(when),
      receive: (env: unknown, when: number) => {
        const reason = fault.receiveAs
        if (!reason) return h.receive(env, when)
        fault.receiveAs = null
        return Promise.resolve({ disposition: 'failed', reason, stage: 9 } as never)
      },
      // the act's answer is lost: before the library ran it, or after it committed
      sendMessage: async (...args: unknown[]) => {
        if (fault.sendLost) { fault.sendLost = false; throw new lib.InfraError('store-read', 'lost before the act') }
        const r = await h.sendMessage(...args)
        if (fault.sendAfterCommit) { fault.sendAfterCommit = false; throw new lib.InfraError('unknown-commit-outcome', 'lost after the commit') }
        return r
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
        if (fault.all) throw Error('app storage unavailable')
        const r = writes.find(w => w.store === 'intents')?.value as IntentRecord | undefined
        if (r?.command === 'send' && r.state === 'expired' && fault.expire) {
          fault.expiredAttempts++
          throw Error('expiry write unavailable')
        }
        if (r?.command === 'send' && r.state === 'done' && fault.finish) throw Error('finish unavailable')
        if (r?.command === 'send' && r.state === 'running' && fault.running) {
          fault.entered?.()
          if (fault.wait) await fault.wait
          else throw Error('running unavailable')
        }
      }
      return db.write(writes)
    } }
  } }
})

async function ready() {
  const p = await pair()
  await p.scan(); await p.settle()
  const bId = p.B().models()!.contacts[0]!.id
  await p.B().intent('counterVerify', bId, 'counter', { contactId: bId }).done
  await p.settle()
  const aId = p.A().models()!.contacts[0]!.id
  const send = (text: string, key: string) =>
    p.A().intent('send', `c:${aId}`, `send|${key}`, { contactId: aId, text, draftKey: key })
  const messages = (side: 'A' | 'B') =>
    p[side]().models()!.conversations.get(`c:${side === 'A' ? aId : bId}`)!.items.filter(i => i.kind === 'message')
  return { p, send, messages }
}
type State = { lastWhen: number; acts: Record<string, { events: { type: string; mid?: string }[] }> }

it.each([false, true])('R10-1: rollback inside P7D after journal retention, initial resume fails=%s', async fail => {
  const { p, send, messages } = await ready()
  try {
    fault.finish = true
    const h = send('exactly one human gesture', 'rollback')
    await h.done; await p.settle()
    expect(messages('B')).toHaveLength(1)
    const before = await p.state() as unknown as State
    const firstMid = before.acts[h.actId]!.events.find(e => e.type === 'message.sent')!.mid
    fault.all = true
    p.clock.advance(91 * DAY); p.foreground(); await p.settle()
    expect((await p.state() as unknown as State).acts[h.actId]).toBeUndefined()
    await p.shutdownA()
    p.clock.advance(-90 * DAY)
    fault.all = fault.finish = false
    fault.resume = fail
    await p.reopen(true); await p.settle()
    const after = await p.state() as unknown as State
    const secondMid = after.acts[h.actId]?.events.find(e => e.type === 'message.sent')?.mid
    // Even if submission waits for resume, minting a second message here is forbidden.
    expect.soft(secondMid, `first=${firstMid}, replay=${secondMid}`).toBeUndefined()
    fault.resume = false
    p.foreground(); await p.settle()
    expect.soft(messages('B'), 'the later successful resume must not deliver a second message').toHaveLength(1)
  } finally { fault.all = fault.finish = fault.resume = false; await p.close() }
})

it('R10-2: an automatic replay must not take different input under its running draft key', async () => {
  const { p, send } = await ready()
  let release = () => {}
  try {
    fault.finish = true
    await send('original', 'replay-key').done
    await p.settle()
    fault.finish = false
    fault.wait = new Promise<void>(r => { release = r })
    const entered = new Promise<void>(r => { fault.entered = r })
    fault.running = true
    p.clock.advance(2000)
    await entered
    const changed = send('changed text', 'replay-key')
    release()
    const result = await changed.done
    await p.settle()
    const snapshot = await p.db.readAll()
    expect(JSON.stringify([...snapshot.intents.values(), ...snapshot.log.values()])).not.toContain('changed text')
    expect.soft(result).toMatchObject({ ok: false, error: { code: 'superseded' } })
    expect.soft(changed.journaled, 'send must expose a truthful custody acknowledgement').toBeDefined()
    expect.soft(await changed.journaled).toBe(false)
    const takenByComposer = await (changed.journaled ?? changed.done.then(r =>
      r.ok || (r.error.kind === 'infra' && r.error.code === 'unknown-outcome') ||
      (r.error.kind === 'refused' && ['not-ready', 'contact-blocked', 'not-possible-yet'].includes(r.error.code))))
    expect.soft(takenByComposer, 'useDraft would otherwise clear a body that is nowhere durable').toBe(false)
  } finally { release(); fault.running = fault.finish = false; fault.wait = fault.entered = null; await p.close() }
})

it('R10 control: a never-started message expires at its limit with timers alone', async () => {
  const { p, send, messages } = await ready()
  try {
    fault.running = true
    const h = send('timer must expire me', 'no-due')
    await h.done; await p.settle()
    for (const delta of [2000, 10000, 60000]) { p.clock.advance(delta); await p.settle() }
    p.clock.advance(90 * DAY); await p.settle()
    expect(messages('B')).toHaveLength(0)
    expect(messages('A')[0]).toMatchObject({ delivery: { phase: 'expired' } })
  } finally { fault.running = false; await p.close() }
})

it('R10-3: a failed expiry write must retry after storage recovers without foreground events', async () => {
  const { p, send, messages } = await ready()
  try {
    fault.running = true
    await send('expiry must retry', 'expiry-retry').done
    await p.settle()
    for (const delta of [2000, 10000, 60000]) { p.clock.advance(delta); await p.settle() }
    fault.expire = true
    fault.expiredAttempts = 0
    p.clock.advance(90 * DAY); await p.settle()
    expect(fault.expiredAttempts).toBeGreaterThan(0)
    fault.expire = fault.running = false
    // No unlock, foreground or network change; the transient storage failure is gone.
    for (let i = 0; i < 60; i++) { p.clock.advance(60_000); await p.settle() }
    expect(messages('A')[0]).toMatchObject({ delivery: { phase: 'expired' } })
  } finally { fault.expire = fault.running = false; await p.close() }
})

it('R10-1 replay: an act unknown to the library is never sent blind, the line says expired', async () => {
  const { p, send, messages } = await ready()
  try {
    fault.sendLost = true
    const r = await send('never committed', 'lost').done
    expect(r).toMatchObject({ ok: false })
    for (let i = 0; i < 10; i++) { p.clock.advance(60_000); await p.settle() }
    expect(messages('B'), 'nothing reached the recipient').toHaveLength(0)
    expect(messages('A')).toHaveLength(1)
    expect(messages('A')[0]).toMatchObject({ delivery: { phase: 'expired' } })
  } finally { fault.sendLost = false; await p.close() }
})

it('R10-1 replay: a committed act whose answer was lost takes its journaled result, sent once', async () => {
  const { p, send, messages } = await ready()
  try {
    fault.sendAfterCommit = true
    await send('committed, answer lost', 'after-commit').done
    for (let i = 0; i < 10; i++) { p.clock.advance(60_000); await p.settle() }
    expect(messages('B'), 'the recipient has it once').toHaveLength(1)
    expect(messages('A')).toHaveLength(1)
    expect(messages('A')[0]).not.toMatchObject({ delivery: { phase: 'expired' } })
  } finally { fault.sendAfterCommit = false; await p.close() }
})

it.each([['rate-limited', 'later'], ['gate-future', 'taken'], ['consumed-challenge', 'taken']] as const)(
  'receive failed(%s) answers %s (Delivery §5: every failure but rate-limited is terminal)',
  async (reason, expected) => {
    const answers: string[] = []
    const p = await pair((t) => ({ ...t, start(h) { t.start({ ...h, envelope: async (env) => { const a = await h.envelope(env); answers.push(a); return a } }) } }))
    try {
      fault.receiveAs = reason
      expect((await p.scanned()).ok).toBe(true)
      await p.settle()
      expect(answers[0]).toBe(expected)
    } finally { fault.receiveAs = null; await p.close() }
  },
)
