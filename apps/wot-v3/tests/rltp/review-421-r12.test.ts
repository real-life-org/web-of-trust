// @vitest-environment node
// Regressions of the twelfth review of #421 (rltp/design/store-launch-v3/app-review-421-12-2026-10-21.md,
// gpt-6.1-sol).
// Review probes only: real library, encrypted fake IndexedDB and real adapter.
import { afterEach, expect, it, vi } from 'vitest'
import { DAY, pair } from './pair'
import type { AppWrite } from '../../src/adapters/rltp/app-db'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import type { IntentRecord } from '../../src/adapters/rltp/journal'

const fault = vi.hoisted(() => ({
  finishSend: false, finishConfirm: false, confirmUnknown: false, running: false, resume: false,
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
      replay: (actId: string, when: number) => {
        fault.replayCalls.push(actId)
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
        if (rec?.command === 'send' && rec.state === 'done' && fault.finishSend) throw Error('send finish unavailable')
        if (rec?.command === 'confirmCard' && rec.state === 'done' && fault.finishConfirm) throw Error('confirm finish unavailable')
        if (rec?.command === 'confirmCard' && rec.state === 'needs-confirmation' && fault.confirmUnknown) throw Error('confirm recovery state unavailable')
        if (rec?.command === 'send' && rec.state === 'running' && fault.running) throw Error('running unavailable')
      }
      return db.write(writes)
    } }
  } }
})
afterEach(() => {
  fault.finishSend = fault.finishConfirm = fault.confirmUnknown = fault.running = fault.resume = false
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

it('R12: take a committed result still retained at day 89.5 before marking the message expired', async () => {
  const { p, send, messages } = await ready()
  try {
    fault.finishSend = true
    const h = send('already received', 'retained')
    await h.done; await p.settle()
    expect(messages('B')).toHaveLength(1)
    await p.shutdownA()
    fault.finishSend = false
    fault.replayCalls = []
    p.clock.advance(89.5 * DAY)
    await p.reopen(true)
    const state = await p.state() as unknown as { acts: Record<string, unknown> }
    expect(state.acts[h.actId], 'the real library still knows this committed act').toBeDefined()
    expect.soft(fault.replayCalls, 'lookup the authoritative result before discarding inputs').toContain(h.actId)
    expect.soft((await p.intents()).find(r => r.actId === h.actId)?.state).toBe('done')
    expect.soft(messages('A')[0]?.delivery?.phase).not.toBe('expired')
  } finally { fault.finishSend = false; await p.close() }
})

it('R12: a known refusal survives failed persistence plus foreground recovery before its retry timer', async () => {
  const p = await pair()
  try {
    p.carrier.setOnline('B', false)
    await p.scan(); await p.settle()
    const id = p.A().models()!.contacts[0]!.id
    fault.finishSend = true
    const h = p.A().intent('send', `c:${id}`, 'send|known-no', { contactId: id, text: 'keep this held', draftKey: 'known-no' })
    expect(await h.done).toMatchObject({ ok: false, error: { code: 'not-ready' } })
    await p.settle()
    fault.finishSend = false
    // No clock progress: automatic lookup wins before persistLater's +1000ms.
    p.foreground(); await p.settle()
    p.clock.advance(1000); await p.settle()
    const rec = (await p.intents()).find(r => r.actId === h.actId)
    const line = (await p.db.readAll()).log.get('msg:out:known-no')
    expect.soft(rec).toMatchObject({ state: 'done', outcome: { ok: false, error: { code: 'not-ready' } } })
    expect.soft(line).toMatchObject({ held: 'not-ready', status: { phase: 'held' } })
  } finally { fault.finishSend = false; await p.close() }
})

it('R12: an entry newly expired by its deadline is purged seven days later with timers alone', async () => {
  const p = await pair()
  try {
    fault.running = true
    const h = p.A().intent('send', 'c:gone', 'send|expired-gc', { contactId: 'gone', text: 'expiry then cleanup', draftKey: 'expired-gc' })
    await h.done; await p.settle()
    for (const delta of [2000, 10_000, 60_000]) { p.clock.advance(delta); await p.settle() }
    // the expiry and the purge are timer work: settle waits for it (timerBusy, review 468 #6), and both
    // checks wait for the outcome itself, never for a number of turns
    p.clock.advance(90 * DAY); await p.settle()
    await vi.waitFor(async () => expect((await p.intents()).find(r => r.actId === h.actId)?.state).toBe('expired'))
    p.clock.advance(8 * DAY); await p.settle()
    await vi.waitFor(async () => expect((await p.intents()).find(r => r.actId === h.actId), 'expired is a finished entry with P7D retention').toBeUndefined())
  } finally { fault.running = false; await p.close() }
})

it('review 468 #6: settle sees the timer work of the expiry, also when its holder calls outlast the bounded drain', async () => {
  const p = await pair()
  const subtle = crypto.subtle as unknown as { encrypt: SubtleCrypto['encrypt']; digest: SubtleCrypto['digest'] }
  const { encrypt, digest } = subtle
  try {
    fault.running = true
    const h = p.A().intent('send', 'c:gone', 'send|expired-slow', { contactId: 'gone', text: 'expiry under load', draftKey: 'expired-slow' })
    await h.done; await p.settle()
    for (const delta of [2000, 10_000, 60_000]) { p.clock.advance(delta); await p.settle() }
    // load: every seal and digest takes 120 macrotask turns, longer than idle's drain of 30
    const turns = async () => { for (let i = 0; i < 120; i++) await new Promise((r) => setTimeout(r, 0)) }
    subtle.encrypt = (async (...a: Parameters<SubtleCrypto['encrypt']>) => { await turns(); return encrypt.apply(crypto.subtle, a) }) as SubtleCrypto['encrypt']
    subtle.digest = (async (...a: Parameters<SubtleCrypto['digest']>) => { await turns(); return digest.apply(crypto.subtle, a) }) as SubtleCrypto['digest']
    p.clock.advance(90 * DAY); await p.settle()
    // no waiting beyond settle: rest means the timer work is done (red before timerBusy: 'journaled')
    expect((await p.intents()).find(r => r.actId === h.actId)?.state).toBe('expired')
  } finally {
    subtle.encrypt = encrypt
    subtle.digest = digest
    fault.running = false
    await p.close()
  }
}, 60_000)

it('R12: completed records are purged after a tick even if resume fails', async () => {
  const p = await pair()
  try {
    const h = p.A().intent('send', 'c:gone', 'send|resume-gc', { contactId: 'gone', text: 'finished refusal', draftKey: 'resume-gc' })
    await h.done; await p.settle()
    expect((await p.intents()).find(r => r.actId === h.actId)?.state).toBe('done')
    fault.resume = true
    p.clock.advance(8 * DAY); await p.settle()
    expect((await p.intents()).find(r => r.actId === h.actId), 'local retention must not depend on a successful holder resume').toBeUndefined()
  } finally { fault.resume = false; await p.close() }
})

it('R12: retry adoption of a known confirm-again result after a failed recovery completion write', async () => {
  const p = await pair()
  try {
    fault.finishConfirm = true
    await p.scan(); await p.settle()
    const rec = (await p.intents()).find(r => r.command === 'confirmCard')!
    expect(rec.state).toBe('needs-confirmation')
    await p.reopen(true) // lookup succeeds, but its app-db completion still fails
    expect(fault.replayCalls).toContain(rec.actId)
    fault.finishConfirm = false
    for (let i = 0; i < 3; i++) {
      p.clock.advance(2000); p.foreground(); await p.settle()
    }
    expect((await p.intents()).find(r => r.actId === rec.actId)?.state).toBe('done')
  } finally { fault.finishConfirm = false; await p.close() }
})

it('R12: adopt the known result of a confirm-again act left running by a process end on reopening', async () => {
  const p = await pair()
  try {
    fault.finishConfirm = fault.confirmUnknown = true
    await p.scan(); await p.settle()
    const rec = (await p.intents()).find(r => r.command === 'confirmCard')!
    expect(rec.state).toBe('running')
    await p.shutdownA()
    fault.finishConfirm = fault.confirmUnknown = false
    fault.replayCalls = []
    await p.reopen(true)
    expect.soft(fault.replayCalls, 'first recovery must lookup a running confirm-again act too').toContain(rec.actId)
    expect.soft((await p.intents()).find(r => r.actId === rec.actId)?.state).toBe('done')
  } finally { fault.finishConfirm = fault.confirmUnknown = false; await p.close() }
})
