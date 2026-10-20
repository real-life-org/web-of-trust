// @vitest-environment node
// Regressions of Astra's fifteenth review of #420 (rltp/design/store-launch-v3/app-review-420-15-2026-10-20.md).
// Adversarial R15 probes: assertions describe the required behaviour.
import type { TransportHandlers } from '../../src/adapters/rltp/transport'
import { expect, it, vi } from 'vitest'
import { DAY, isAck, pair } from './pair'
import { decodeCardLink } from '../../src/adapters/rltp/card-link'

interface HolderProbe {
  readonly closed: boolean
  receive(env: unknown, when: number): Promise<unknown>
  handOver(entry: unknown, when: number, start: () => boolean): Promise<boolean>
  tick(when: number): Promise<unknown>
  resume(when: number): Promise<unknown>
}
const hooks = vi.hoisted(() => ({
  failReceive: false,
  failHandOver: false,
  receiveQueued: null as null | (() => void),
  handOverFailures: 0,
  failDue: null as null | 'tick' | 'resume',
}))
vi.mock('@real-life/trust-protocol', async importOriginal => {
  const lib = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<HolderProbe> }>()
  return { ...lib, createHolder: async (...args: unknown[]) => {
    const h = await lib.createHolder(...args)
    return {
      ...h,
      get closed() { return h.closed },
      tick: (when: number) => hooks.failDue === 'tick' ? Promise.reject(Error('tick storage failure')) : h.tick(when),
      resume: (when: number) => hooks.failDue === 'resume' ? Promise.reject(Error('resume storage failure')) : h.resume(when),
      receive(env: unknown, when: number) {
        if (hooks.failReceive) {
          hooks.failReceive = false
          return Promise.reject(Error('one transient receive storage failure'))
        }
        const result = h.receive(env, when)
        hooks.receiveQueued?.()
        return result
      },
      handOver(entry: unknown, when: number, start: () => boolean) {
        if (hooks.failHandOver) {
          hooks.failHandOver = false
          hooks.handOverFailures++
          return Promise.reject(Error('one transient handOver storage read failure'))
        }
        return h.handOver(entry, when, start)
      },
    }
  } }
})

it('R15-1a: a transient receive failure keeps an accepted bundle at the carrier', async () => {
  const dispositions: string[] = []
  let accepted = 0
  const p = await pair(t => ({ ...t, start(h) {
    t.start({ ...h, async envelope(env) {
      const result = await h.envelope(env)
      dispositions.push(result)
      return result
    } })
  } }), t => ({ ...t, start(h) {
    t.start({ ...h, report(r) { if (r.status === 'accepted') accepted++; h.report(r) } })
  } }))
  try {
    hooks.failReceive = true
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    expect(accepted).toBeGreaterThan(0)
    expect.soft(dispositions[0], 'temporary storage failure is not evidence of a foreign rkid').toBe('later')
    await new Promise(r => setTimeout(r, 1150))
    await p.settle()
    expect(p.A().models()!.decisions, 'the accepted document must be redelivered after storage recovers').toHaveLength(1)
  } finally { hooks.failReceive = false; await p.close() }
})

it('R15-1b: receive queued before lock must be retained when holder.close rejects the queued call', async () => {
  const dispositions: string[] = []
  const p = await pair(t => ({ ...t, start(h) {
    t.start({ ...h, async envelope(env) {
      const result = await h.envelope(env)
      dispositions.push(result)
      return result
    } })
  } }))
  let release!: () => void
  let entered!: () => void
  let received!: () => void
  const barrier = new Promise<void>(r => { release = r })
  const reading = new Promise<void>(r => { entered = r })
  const queued = new Promise<void>(r => { received = r })
  let blocked = false
  let closing: Promise<void> | undefined
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
  let spy: ReturnType<typeof vi.spyOn> | undefined
  try {
    const card = await p.A().intent<{ qr: string }>('showCard', '', 'r15-show', {}).done
    if (!card.ok) throw Error('show')
    await p.settle()
    spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      const aad = (args[0] as AesGcmParams).additionalData
      if (!blocked && aad && new TextDecoder().decode(aad) === 'wot-v3-holder-A') {
        blocked = true
        entered()
        await barrier
      }
      return decrypt(...args)
    })
    // The real holder operation, not a mock queue, is paused inside its store read.
    const profile = p.A().setProfile({ name: 'A changed' }, 'r15-profile').catch(() => undefined)
    await reading
    hooks.receiveQueued = () => { hooks.receiveQueued = null; received() }
    const scan = p.B().intent('confirmCard', '', 'r15-scan', {
      card: decodeCardLink(card.value.qr), role: 'displayed',
    }).done
    await queued
    closing = p.shutdownA()
    release()
    await profile
    await scan
    await closing
    await p.settle()
    expect.soft(dispositions[0], 'the generation was valid on entry but ended while receive waited').toBe('later')
    await p.reopen()
    await new Promise(r => setTimeout(r, 1150))
    await p.settle()
    expect(p.A().models()!.decisions, 'reopening must receive the carrier-held bundle').toHaveLength(1)
  } finally {
    release()
    hooks.receiveQueued = null
    spy?.mockRestore()
    await closing
    await p.close()
  }
})

it('R15 control: a transient handOver read failure retries a due duplicate answer without a new act', async () => {
  let bundle: unknown
  const sent: string[] = []
  const p = await pair(t => ({ ...t, submit(out) {
    sent.push(...out.filter(isAck).map(o => o.digest))
    t.submit(out)
  } }), t => ({ ...t, submit(out) {
    for (const o of out) if (o.type.includes('encounter-bundle')) bundle = o
    t.submit(out)
  } }))
  const injector = p.carrier.endpoint('injector')
  const injected: TransportHandlers = { envelope: async () => 'not-mine', report: () => {} }
  injector.start(injected)
  try {
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    p.clock.advance(8 * DAY)
    p.foreground()
    await p.settle()
    const ack = sent[0]!
    const before = sent.filter(d => d === ack).length
    hooks.handOverFailures = 0
    hooks.failHandOver = true
    injector.submit([bundle as never])
    await p.settle()
    expect(hooks.handOverFailures).toBe(1)
    expect(Object.values((await p.state()).effects).some(e => e.ack?.answerDue)).toBe(true)
    // No foreground, network transition, new duplicate or user action.
    for (let i = 0; i < 60; i++) { p.clock.advance(60_000); await p.settle() }
    expect(sent.filter(d => d === ack).length, 'an hour after a one-shot storage error, the owed answer must have been retried').toBe(before + 1)
  } finally { hooks.failHandOver = false; injector.stop(injected); await p.close() }
})

it.each(['tick', 'resume'] as const)('R15 control: failed initial %s recovers by timer alone', async fault => {
  const sent: string[] = []
  const p = await pair(t => ({ ...t, submit(out) {
    sent.push(...out.map(o => o.digest))
    t.submit(out)
  } }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    await p.shutdownA()
    p.carrier.setOnline('A', true)
    const before = sent.length
    hooks.failDue = fault
    await p.reopen()
    expect(sent).toHaveLength(before)
    hooks.failDue = null
    p.clock.advance(1000)
    await p.settle()
    expect(p.B().models()!.decisions).toHaveLength(1)
    expect(sent.filter(d => d === sent[0])).toHaveLength(2)
  } finally { hooks.failDue = null; await p.close() }
})
