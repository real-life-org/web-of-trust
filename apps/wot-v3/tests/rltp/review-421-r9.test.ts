// @vitest-environment node
// Regressions of Astra's ninth review of #421 (rltp/design/store-launch-v3/app-review-421-9-2026-10-20.md).
import { expect, it, vi } from 'vitest'
import { DAY, T0, pair } from './pair'
import type { AppWrite } from '../../src/adapters/rltp/app-db'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import type { IntentRecord } from '../../src/adapters/rltp/journal'

const fault = vi.hoisted(() => ({ finish: false, running: false, all: false }))
vi.mock('../../src/adapters/rltp/app-db', async original => {
  const lib = await original<typeof AppDbModule>()
  return { ...lib, idbAppDb: (opts: Parameters<typeof lib.idbAppDb>[0]) => {
    const db = lib.idbAppDb(opts)
    return { ...db, async write(writes: readonly AppWrite[]) {
      if (opts.name.endsWith('-A') && fault.all) throw Error('app storage temporarily unavailable')
      const r = writes.find(w => w.store === 'intents')?.value as IntentRecord | undefined
      if (opts.name.endsWith('-A') && r?.command === 'send') {
        if (fault.finish && r.state === 'done') throw Error('completion write unavailable')
        if (fault.running && r.state === 'running') throw Error('running write unavailable')
      }
      return db.write(writes)
    } }
  } }
})

it('R9: app clock write failure plus clock rollback must not replay a forgotten act into a second mid', async () => {
  const { p, send, messages } = await ready()
  type State = { lastWhen: number; acts: Record<string, { events: { type: string; mid?: string }[] }> }
  try {
    fault.finish = true
    const h = send('one gesture, one message', 'clock-rollback')
    expect(await h.journaled).toBe(true)
    await h.done
    await p.settle()
    expect(messages('B')).toHaveLength(1)
    const first = await p.state() as unknown as State
    const firstMid = first.acts[h.actId]!.events.find(e => e.type === 'message.sent')!.mid
    fault.all = true
    p.clock.advance(91 * DAY)
    p.foreground()
    await p.settle()
    const retained = await p.state() as unknown as State
    expect(retained.acts[h.actId]).toBeUndefined()
    expect(retained.lastWhen).toBeGreaterThanOrEqual(T0 + 91 * DAY)
    const appHigh = (await p.db.readAll()).kv.get('clock') as { high: number }
    expect(appHigh.high).toBeLessThan(T0 + DAY)
    await p.shutdownA()
    // Correct a bad wall clock after process termination; the app's high mark never committed.
    p.clock.advance(-61 * DAY)
    expect(p.clock.now()).toBe(T0 + 30 * DAY)
    fault.all = fault.finish = false
    await p.reopen(true)
    await p.settle()
    const after = await p.state() as unknown as State
    const replayMid = after.acts[h.actId]?.events.find(e => e.type === 'message.sent')?.mid
    expect.soft(replayMid, 'a retained-away act must not be minted anew').toBeUndefined()
    expect.soft(messages('B'), `first mid ${firstMid}; replay mid ${replayMid}`).toHaveLength(1)
  } finally { fault.all = fault.finish = false; await p.close() }
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
  return { p, send, messages }
}

it('R9: inflight draft key must not confirm custody of a different body', async () => {
  const { p, send, messages } = await ready()
  try {
    const original = send('original', 'same')
    const changed = send('corrected text', 'same')
    await original.done
    await changed.done
    await p.settle()
    const snap = await p.db.readAll()
    expect(messages('B').map(m => m.text)).toEqual(['original'])
    expect(JSON.stringify([...snap.log.values(), ...snap.intents.values()])).not.toContain('corrected text')
    expect(await changed.journaled, 'corrected text is not durable anywhere').toBe(false)
  } finally { await p.close() }
})

it('R9: crossing the manual limit with only timers must show expired', async () => {
  const { p, send, messages } = await ready()
  try {
    fault.running = true
    const h = send('must visibly expire', 'timer-expiry')
    await h.done
    await p.settle()
    expect(await h.journaled).toBe(true)
    expect(messages('A')[0]).toMatchObject({ delivery: { phase: 'committing' } })
    // No lifecycle or network event: the app is still foreground and online.
    p.clock.advance(90 * DAY)
    await p.settle()
    expect(messages('B')).toHaveLength(0)
    expect(messages('A')[0]).toMatchObject({ delivery: { phase: 'expired' } })
  } finally { fault.running = false; await p.close() }
})

it('R9: a never executed act older than its horizon must fail, also on foreground recovery', async () => {
  const { p, send, messages } = await ready()
  try {
    fault.running = true
    const h = send('old intention', 'old-intention')
    await h.done
    await p.settle()
    expect(await h.journaled).toBe(true)
    p.clock.advance(8 * DAY)
    await p.settle()
    expect(messages('B')).toHaveLength(0)
    // Active runs tick/resume first; the holder's monotone time is now day 8.
    fault.running = false
    p.foreground()
    await vi.waitFor(async () => {
      await p.settle()
      const r = (await p.db.readAll()).intents.get(h.actId) as IntentRecord
      // the act never started and its horizon passed: the record expires instead of running
      expect(r.state).toBe('expired')
    })
    expect(messages('B'), 'late recovery must not create a fresh delivery horizon').toHaveLength(0)
    expect(messages('A')[0]).toMatchObject({ delivery: { phase: 'expired' } })
  } finally { fault.running = false; await p.close() }
})
