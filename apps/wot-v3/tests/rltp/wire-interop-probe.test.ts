// @vitest-environment node
// The interop probe of the developer area (src/adapters/rltp/interop-probe.ts; TRANSPORT.md "Interop
// probe") over the mediator double: one carried document to the did:key of a foreign Trust Task agent,
// and the agent's answer in the delivery line. The agent is a double on the same mediator, built from
// the app's own wire without a counterpart (it answers whoever wrote): it reads the binding envelope
// and answers as trust-tasks-rs does, `trust-task-error/0.5` `unsupportedType` (a consumer without a
// handler) or `trust-task-next-step/0.1` (a handler that holds the document open).
import { afterEach, describe, expect, it } from 'vitest'
import { SEALED_ENVELOPE_TYPE, TRUST_TASK_ERROR_TYPE, TRUST_TASK_NEXT_STEP_TYPE, TSP_BINDING_ENVELOPE_TYPE } from '@real-life/trust-protocol/adapters/vti-mediator'
import { interopProbe, probeDelivery } from '../../src/adapters/rltp/interop-probe'
import { createVtiWire, type VtiWire } from '../../src/adapters/rltp/wire'
import type { InteropProbe, InteropProbeState } from '../../src/port'
import { mediatorDouble, type MediatorDouble } from '../../harness/mediator-double'
import { virtualClock, type VirtualClock } from '../../src/platform/fake'

const turn = () => new Promise((r) => setTimeout(r, 0))
const canon = (v: unknown): string =>
  v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`

/** a foreign Trust Task agent on the double: answers every carried document it receives */
async function agent(med: MediatorDouble, clock: VirtualClock, kind: 'unsupportedType' | 'next-step', seed = 7) {
  const wire: VtiWire = await createVtiWire({ rootIkm: new Uint8Array(64).fill(seed), mediatorDid: med.did, nonce: new Uint8Array(32).fill(8), clock, net: med.net })
  const seen: { type: string; issuer: string; recipient: string }[] = []
  wire.onDeliver(async (bytes, sender) => {
    const env = JSON.parse(new TextDecoder().decode(bytes)) as { type: string; document: { id: string; type: string; issuer: string; recipient: string } }
    seen.push({ type: env.type === TSP_BINDING_ENVELOPE_TYPE ? env.document.type : env.type, issuer: env.document.issuer, recipient: env.document.recipient })
    const inResponseTo = { id: env.document.id, typeUri: env.document.type }
    const common = { id: `urn:uuid:${crypto.randomUUID()}`, issuedAt: '2026-10-27T17:27:50.395371028Z', issuer: wire.connectionDid, recipient: sender, threadId: env.document.id }
    const document =
      kind === 'unsupportedType'
        ? { ...common, type: TRUST_TASK_ERROR_TYPE, payload: { code: 'unsupportedType', inResponseTo, message: `no handler for ${env.document.type}`, retryable: false } }
        : { ...common, type: TRUST_TASK_NEXT_STEP_TYPE, payload: { continuation: 'proceed', expects: [{ typeUri: 'https://trusttasks.org/spec/trust-task-ok/0.1' }], inResponseTo, message: 'understood; waiting' } }
    wire.bind({ connectionDid: sender })
    await wire.deposit('', new TextEncoder().encode(canon({ document, type: TSP_BINDING_ENVELOPE_TYPE })), 'direct')
    return true
  })
  await wire.authenticate({ did: wire.connectionDid, challenge: '', sessionId: '' })
  return { did: wire.connectionDid, seen, wire }
}

/** device time in steps of the probe's tick until the state holds */
async function until(clock: VirtualClock, med: MediatorDouble, probe: InteropProbe, ok: (s: InteropProbeState) => boolean) {
  for (let i = 0; i < 40 && !ok(probe.state.get()); i++) {
    await med.settled()
    await turn()
    clock.advance(1000)
    await turn()
  }
  return probe.state.get()
}

describe('the interop probe', () => {
  const open: { stop(): void }[] = []
  afterEach(() => {
    for (const x of open.splice(0)) x.stop()
  })

  it('a foreign consumer without a handler answers unsupportedType: the line shows the refusal with its code', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const a = await agent(med, clock, 'unsupportedType')
    open.push({ stop: () => a.wire.close() })
    const probe = interopProbe({ mediatorDid: med.did, clock, net: med.net })
    open.push(probe)
    probe.send(` ${a.did} `)
    const st = await until(clock, med, probe, (s) => s.phase === 'running' && s.delivery?.phase === 'failed')
    expect(st).toEqual({ phase: 'running', counterpart: a.did, mode: 'routed', delivery: { phase: 'failed', reason: 'rejected', code: 'unsupportedType', retry: { ok: false, reason: 'not-supported' } } })
    // the agent saw a carried document addressed to it, never the sample inside the seal
    expect(a.seen).toHaveLength(1)
    expect(a.seen[0]).toMatchObject({ type: SEALED_ENVELOPE_TYPE, recipient: a.did })
  }, 30_000)

  it('the probe stops its tick once the line is final (failed or delivered): no timer of it runs on', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const a = await agent(med, clock, 'unsupportedType')
    open.push({ stop: () => a.wire.close() })
    // the probe's own timers: planned and not yet cancelled or fired
    let planned = 0
    const counted = {
      now: () => clock.now(),
      setTimer: (at: number, cb: () => void) => {
        planned++
        let live = true
        const cancel = clock.setTimer(at, () => {
          if (live) planned--
          live = false
          cb()
        })
        return () => {
          if (live) planned--
          live = false
          cancel()
        }
      },
    }
    const probe = interopProbe({ mediatorDid: med.did, clock: counted, net: med.net })
    open.push(probe)
    probe.send(a.did)
    const st = await until(clock, med, probe, (s) => s.phase === 'running' && s.delivery?.phase === 'failed')
    expect(st).toMatchObject({ phase: 'running', delivery: { phase: 'failed', code: 'unsupportedType' } })
    // one more tick may still be planned from before the answer; after it, nothing more
    clock.advance(1000)
    await turn()
    await med.settled()
    clock.advance(1000)
    await turn()
    expect(planned).toBe(0)
  }, 30_000)

  it('a handler that holds the document answers with a next step: accepted and held', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const a = await agent(med, clock, 'next-step')
    open.push({ stop: () => a.wire.close() })
    const probe = interopProbe({ mediatorDid: med.did, clock, net: med.net })
    open.push(probe)
    probe.send(a.did)
    const st = await until(clock, med, probe, (s) => s.phase === 'running' && s.delivery?.phase === 'accepted' && s.delivery.held === true)
    expect(st).toMatchObject({ phase: 'running', counterpart: a.did, delivery: { phase: 'accepted', held: true } })
  }, 30_000)

  it('a send that overtakes a starting probe ends only that probe: the newer one runs on and gets its answer (whatever step the older start had reached)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    // the second send lands after k turns of the first start: every step of it is met by some k
    for (let k = 0; k < 12; k++) {
      // an agent per round: its wire binds to the first sender it answers
      const a = await agent(med, clock, 'unsupportedType', 20 + k)
      const probe = interopProbe({ mediatorDid: med.did, clock, net: med.net })
      open.push(probe)
      const before = med.forwarded.length
      probe.send(a.did)
      for (let i = 0; i < k; i++) await turn()
      probe.send(a.did)
      // the newer probe is never ended by the older start: its document goes out. When the older start
      // was ended before it deposited, one document went out, the newer one's, and the agent's answer
      // reaches the line; when the older one had deposited too, the agent's wire bound to the first
      // sender answers only that one
      const st = await until(clock, med, probe, (s) => s.phase === 'running' && s.delivery?.phase === 'failed')
      const delivery = st.phase === 'running' ? st.delivery : null
      expect(st, `second send after ${k} turns`).toMatchObject({ phase: 'running', mode: 'routed' })
      if (med.forwarded.length - before === 1) expect(delivery, `second send after ${k} turns`).toMatchObject({ phase: 'failed', reason: 'rejected', code: 'unsupportedType' })
      else expect(delivery?.phase, `second send after ${k} turns`).toBe('accepted')
      probe.stop()
      a.wire.close()
    }
  }, 120_000)

  it('an identifier that is no Ed25519 did:key is refused before anything goes out; stop returns to idle', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const probe = interopProbe({ mediatorDid: med.did, clock, net: med.net })
    for (const bad of ['', 'did:web:example.org', 'did:key:z6LStLK2kxribiLHz6U4vpGfzMtmgc4q5WjR4mvhS6KG1W16', 'did:key:z6Mk']) {
      probe.send(bad)
      expect(probe.state.get()).toEqual({ phase: 'invalid' })
    }
    await med.settled()
    expect(med.direct).toEqual([])
    expect(med.forwarded).toEqual([])
    probe.stop()
    expect(probe.state.get()).toEqual({ phase: 'idle' })
  })

  it('probeDelivery maps the submission states onto the delivery line of a message', () => {
    expect(probeDelivery(null)).toEqual({ phase: 'submitted' })
    expect(probeDelivery({ state: 'awaiting-transport', reason: 'offline' })).toEqual({ phase: 'queued', reason: 'offline' })
    expect(probeDelivery({ state: 'awaiting-transport', reason: 'carrier-refused-retriable' })).toEqual({ phase: 'queued', reason: 'carrier-retry' })
    expect(probeDelivery({ state: 'accepted' })).toEqual({ phase: 'accepted' })
    expect(probeDelivery({ state: 'accepted', held: true })).toEqual({ phase: 'accepted', held: true })
    expect(probeDelivery({ state: 'delivered', late: false })).toEqual({ phase: 'delivered', late: false })
    expect(probeDelivery({ state: 'failed', reason: 'rejected-by-receiver', code: 'unsupportedType' })).toEqual({ phase: 'failed', reason: 'rejected', code: 'unsupportedType', retry: { ok: false, reason: 'not-supported' } })
    expect(probeDelivery({ state: 'failed', reason: 'expired-by-adapter-policy' })).toEqual({ phase: 'failed', reason: 'expired', retry: { ok: false, reason: 'not-supported' } })
  })
})
