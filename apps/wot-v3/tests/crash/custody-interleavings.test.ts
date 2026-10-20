// @vitest-environment node
// Interleavings of the transport custody (Delivery 0.83 RLTP-DEL-6120 to 6135, 6330, 6335; lib
// 0.6.0) through the real rltp adapter, the sibling of lifecycle-interleavings.test.ts for what an
// opening hands to the carrier. A seeded generator runs acts on both sides (profile documents,
// acknowledgements), duplicates, the network going away and back, locks, process ends, failing
// resumes and time. Invariants after every step: nothing reaches the device from an opening that is
// not the one in use, nothing the holder gave up is handed over again, the app keeps no outbound
// store. At the end (online, no faults) every document of A is accepted or given up.
//
// Cells (each must be visited by some run, as in lifecycle-interleavings): a lock during a
// hand-over, a process end with a duplicate's answer due, a resume that fails at opening.
// A failing run names its seed and the step log; `SEED=<n>` reruns one seed alone.
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../../src/adapters/rltp/transport'
import { DAY, isAck, pair } from '../rltp/pair'
import { DONE_RETENTION_MS, isOpen } from '../../src/adapters/rltp/journal'

/** the limit of an open record with the default horizon: P90D − 1 day (session.ts) */
const MANUAL_LIMIT_MS = 89 * DAY

const fault = vi.hoisted(() => ({ resume: false }))
// the core library is the adapter's alone (architecture §0.1): the test sees it only through the mock
interface HolderLike { resume(when: number): Promise<unknown>; tick(when: number): Promise<unknown>; readonly closed: boolean }
vi.mock('@real-life/trust-protocol', async (importOriginal) => {
  const lib = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<HolderLike>; InfraError: new (code: string, message: string) => Error }>()
  return {
    ...lib,
    createHolder: async (...args: unknown[]) => {
      const h = await lib.createHolder(...args)
      // the holder is frozen: a wrapper with the same methods, resume switchable
      const w: HolderLike = {
        ...h,
        resume: (when: number) => (fault.resume ? Promise.reject(new lib.InfraError('storage', 'injected')) : h.resume(when)),
        get closed() {
          return h.closed
        },
      }
      return w
    },
  }
})

function rng(seed: number) {
  let a = seed >>> 0 || 1
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] as T }
}

const CELLS = ['lock-during-hand-over', 'process-end-with-answer-due', 'resume-fails'] as const
type Cell = (typeof CELLS)[number]
const visited = new Set<Cell>()
const ONLY = process.env.SEED ? Number(process.env.SEED) : null
const SEEDS = ONLY !== null ? [ONLY] : Array.from({ length: 18 }, (_, i) => i + 1)

type Step = 'aProfile' | 'bProfile' | 'dup' | 'offline' | 'online' | 'lock' | 'end' | 'resumeFails' | 'time' | 'days'
const STEPS: readonly Step[] = ['aProfile', 'aProfile', 'bProfile', 'bProfile', 'dup', 'offline', 'online', 'lock', 'end', 'resumeFails', 'time', 'time', 'days']

async function run(seed: number) {
  const r = rng(seed * 104729 + 7)
  const log: string[] = []
  const violations: string[] = []
  /** A has an opening in use; false from the start of a shutdown to the activation of the next */
  let inUse = true
  let lockInSubmit = false
  let refuseAcks = false
  let lockHook: () => void = () => {}
  const given: Set<string> = new Set()
  const submitted: { digest: string; type: string }[] = []
  let lastB: unknown = null
  const wrapA = (t: Transport): Transport => ({ ...t, submit(out) {
    if (refuseAcks && out.some(isAck)) throw Error('carrier unavailable')
    for (const o of out) {
      if (!inUse) violations.push(`submit ${o.type} ${o.digest.slice(0, 10)} while no opening is in use`)
      if (!isAck(o) && given.has(o.digest)) violations.push(`submit of given-up ${o.digest.slice(0, 10)}`)
      submitted.push({ digest: o.digest, type: o.type })
    }
    t.submit(out)
    if (lockInSubmit) { lockInSubmit = false; lockHook() }
  } })
  const wrapB = (t: Transport): Transport => ({ ...t, submit(out) {
    for (const o of out) if (!isAck(o)) lastB = o
    t.submit(out)
  } })
  const p = await pair(wrapA, wrapB)
  const injector = p.carrier.endpoint('injector')
  injector.start({ envelope: async () => 'not-mine', report: () => {} })
  const shutdown = async () => { inUse = false; await p.shutdownA() }
  const reopen = async (fresh: boolean) => {
    inUse = false
    await p.reopen(fresh, () => { inUse = true })
  }
  lockHook = () => {
    visited.add('lock-during-hand-over')
    log.push('  (lock inside hand-over)')
    pendingLock = shutdown()
  }
  let pendingLock: Promise<void> | null = null
  const observe = async () => {
    const st = await p.state()
    for (const [d, o] of Object.entries(st.outbox)) if (o.history.at(-1)?.status === 'failed') given.add(d)
    if ((await p.kvKeys()).some((k) => k.startsWith('out:'))) violations.push('app-db holds an outbound copy')
    return st
  }
  let n = 0
  try {
    // B scans A: B's bundle reaches A, A acknowledges it; its copy is the duplicate of 'dup'
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    const force = CELLS[seed % CELLS.length]!
    const forceAt = 2 + r.int(8)
    for (let i = 0; i < 14; i++) {
      const step: Step = i === forceAt ? (force === 'lock-during-hand-over' ? 'aProfile' : force === 'resume-fails' ? 'resumeFails' : 'dup') : r.pick(STEPS)
      log.push(`${i}: ${step}`)
      if (pendingLock) { await pendingLock; pendingLock = null; await reopen(false) }
      switch (step) {
        case 'aProfile':
          if (i === forceAt || r.next() < 0.25) lockInSubmit = true
          await p.A().setProfile({ name: `A${++n}` }, `a-${seed}-${n}`).catch(() => undefined)
          break
        case 'bProfile':
          await p.B().setProfile({ name: `B${++n}` }, `b-${seed}-${n}`).catch(() => undefined)
          break
        case 'dup': {
          // the answer due is not handed over in this opening (the carrier refuses): the process ends first
          const endFirst = i === forceAt || r.next() < 0.5
          if (endFirst) refuseAcks = true
          injector.submit([lastB as never])
          await p.settle()
          refuseAcks = false
          const st = await observe()
          if (endFirst) {
            if (Object.values(st.effects).some((e) => e.ack?.answerDue !== undefined)) visited.add('process-end-with-answer-due')
            log.push('  (process end)')
            await reopen(true)
          }
          break
        }
        case 'offline': p.carrier.setOnline('A', false); break
        case 'online': p.carrier.setOnline('A', true); break
        case 'lock': await shutdown(); await reopen(false); break
        case 'end': await reopen(true); break
        case 'resumeFails': {
          fault.resume = true
          await reopen(true)
          visited.add('resume-fails')
          const before = submitted.length
          await p.rounds(2)
          if (submitted.length !== before) violations.push('handed over while resume failed')
          fault.resume = false
          break
        }
        case 'time': p.clock.advance((1 + r.int(30)) * 60_000); p.foreground(); break
        case 'days': p.clock.advance(8 * DAY); p.foreground(); break
      }
      await p.settle()
      if (pendingLock) { await pendingLock; pendingLock = null; await reopen(false) }
      await observe()
      // after a tick past a deadline (time and days run the foreground's due time): no journal entry
      // outlives its retention, no open one its limit
      if (step === 'time' || step === 'days') {
        const t = p.clock.now()
        for (const rec of await p.intents()) {
          if (!isOpen(rec) && (rec.finishedAt ?? rec.createdAt) + DONE_RETENTION_MS < t) violations.push(`intent ${rec.actId} (${rec.state}) outlived its retention`)
          if (isOpen(rec) && rec.createdAt + MANUAL_LIMIT_MS < t) violations.push(`open intent ${rec.actId} outlived its limit`)
        }
      }
      if (violations.length) break
    }
    // the end: online, no faults, time for the retries; everything of A is accepted or given up
    fault.resume = false
    p.carrier.setOnline('A', true)
    await p.rounds(10)
    const st = await observe()
    for (const [d, o] of Object.entries(st.outbox)) {
      const last = o.history.at(-1)?.status
      if (last !== 'accepted' && last !== 'delivered' && last !== 'failed') violations.push(`${d.slice(0, 10)} still ${last} at the end`)
    }
  } finally {
    fault.resume = false
    refuseAcks = false
    injector.stop()
    await p.close()
  }
  expect(violations, `seed ${seed}\n${log.join('\n')}`).toEqual([])
}

describe('transport custody: every cell, every opening', () => {
  afterAll(() => {
    if (ONLY === null) expect(CELLS.filter((c) => !visited.has(c)), 'cells no run visited').toEqual([])
  })
  it.each(SEEDS)('seed %i keeps custody across locks, process ends and failed resumes', async (seed) => run(seed), 60_000)
})
