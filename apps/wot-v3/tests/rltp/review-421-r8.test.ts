// @vitest-environment node
// Regressions of Astra's eighth review of #421 (rltp/design/store-launch-v3/app-review-421-8-2026-10-20.md).
import { expect, it, vi } from 'vitest'
import { DAY, pair } from './pair'
import type { AppWrite } from '../../src/adapters/rltp/app-db'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import type { IntentRecord } from '../../src/adapters/rltp/journal'

const fault = vi.hoisted(() => ({
  finish: false,
  running: false,
  wait: null as Promise<void> | null,
  entered: null as (() => void) | null,
}))
vi.mock('../../src/adapters/rltp/app-db', async (original) => {
  const lib = await original<typeof AppDbModule>()
  return { ...lib, idbAppDb: (opts: Parameters<typeof lib.idbAppDb>[0]) => {
    const db = lib.idbAppDb(opts)
    return { ...db, async write(writes: readonly AppWrite[]) {
      if (opts.name.endsWith('-A')) {
        const r = writes.find(w => w.store === 'intents')?.value as IntentRecord | undefined
        if (r?.command === 'send' && r.state === 'done' && fault.finish) {
          fault.finish = false
          throw new Error('completion write failed')
        }
        if (r?.command === 'send' && r.state === 'running' && fault.running) {
          fault.running = false
          fault.entered?.()
          await fault.wait
        }
      }
      return db.write(writes)
    } }
  } }
})

async function ready() {
  const p = await pair()
  await p.scan()
  await p.settle()
  const bId = p.B().models()!.contacts[0]!.id
  await p.B().intent('counterVerify', bId, 'counter', { contactId: bId }).done
  await p.settle()
  const aId = p.A().models()!.contacts[0]!.id
  const send = (text: string, draftKey: string) =>
    p.A().intent('send', `c:${aId}`, `send|${draftKey}`, { contactId: aId, text, draftKey })
  const messages = (side: 'A' | 'B') =>
    p[side]().models()!.conversations.get(`c:${side === 'A' ? aId : bId}`)!.items.filter(i => i.kind === 'message')
  return { p, aId, send, messages }
}

it.each([false, true])('R8 control: same act and mid after reopening (fresh host: %s), inside P7D, after reopening', async (fresh) => {
  const { p, send, messages } = await ready()
  try {
    fault.finish = true
    const h = send('recover exactly once', 'control')
    await h.done
    await p.settle()
    const before = await p.state() as unknown as { acts: Record<string, { events: unknown[] }> }
    const events = before.acts[h.actId]!.events
    await p.shutdownA()
    p.clock.advance(5 * DAY) // inside the retry horizon: the replay runs (past it, the record expires)
    await p.reopen(fresh)
    await p.settle()
    const after = await p.state() as unknown as { acts: Record<string, { events: unknown[] }> }
    expect(after.acts[h.actId]!.events).toEqual(events)
    expect(messages('B')).toHaveLength(1)
    expect(messages('A')).toHaveLength(1)
    expect(messages('A')[0]).toMatchObject({ delivery: { phase: 'delivered' } })
  } finally { fault.finish = false; await p.close() }
})

it('R8: a replay delayed in app storage must recheck retention before invoking the holder', async () => {
  const { p, send, messages } = await ready()
  let release = () => {}
  try {
    fault.finish = true
    const first = send('one human gesture', 'retention-race')
    expect(await first.journaled).toBe(true)
    expect(await first.done).toMatchObject({ ok: false, error: { code: 'unknown-outcome' } })
    await p.settle()
    expect(messages('B')).toHaveLength(1)
    type Acts = { acts: Record<string, { events: { type: string; mid?: string }[] }> }
    const firstState = await p.state() as unknown as Acts
    const firstMid = firstState.acts[first.actId]!.events.find(e => e.type === 'message.sent')!.mid
    fault.wait = new Promise<void>(r => { release = r })
    const entered = new Promise<void>(r => { fault.entered = r })
    fault.running = true
    // The scheduled replay is allowed at day 6, but its app write waits.
    p.clock.advance(6 * DAY)
    await entered
    // Meanwhile the retry horizon passes: the record must expire at the act, not run late.
    p.clock.advance(3 * DAY)
    p.foreground()
    await p.settle()
    release()
    await p.settle()
    await p.rounds(2)
    const finalState = await p.state() as unknown as Acts
    // the limit is checked at the act: the first act stays the only one, no second mid
    expect(finalState.acts[first.actId]!.events.find(e => e.type === 'message.sent')!.mid).toBe(firstMid)
    expect(messages('A')).toHaveLength(1)
    expect(messages('B')).toHaveLength(1)
  } finally {
    release()
    fault.finish = fault.running = false
    await p.close()
  }
})

it('R8: crossing the manual limit in an open session must show expired', async () => {
  const { p, send, messages } = await ready()
  try {
    fault.finish = true
    await send('outcome still open', 'live-expiry').done
    await p.settle()
    p.clock.advance(90 * DAY)
    p.foreground()
    await p.settle()
    p.carrier.setOnline('A', false)
    p.carrier.setOnline('A', true)
    await p.settle()
    expect(messages('A')[0]).toMatchObject({ delivery: { phase: 'expired' } })
  } finally { fault.finish = false; await p.close() }
})

it('R8: a completed draft key must not acknowledge custody of different text', async () => {
  const { p, send } = await ready()
  try {
    expect((await send('original', 'used-key').done).ok).toBe(true)
    const edited = send('corrected text', 'used-key')
    await edited.done
    const snap = await p.db.readAll()
    expect(JSON.stringify([...snap.log.values(), ...snap.intents.values()])).not.toContain('corrected text')
    expect(await edited.journaled).toBe(false)
  } finally { await p.close() }
})

it('R8: a non-held refusal must keep text after journaled=true', async () => {
  const p = await pair()
  try {
    const h = p.A().intent('send', 'c:gone', 'send|gone', { contactId: 'gone', text: 'do not lose this', draftKey: 'gone' })
    expect(await h.journaled).toBe(true)
    expect(await h.done).toMatchObject({ ok: false })
    const snap = await p.db.readAll()
    expect(JSON.stringify([...snap.log.values(), ...snap.intents.values()])).toContain('do not lose this')
  } finally { await p.close() }
})
