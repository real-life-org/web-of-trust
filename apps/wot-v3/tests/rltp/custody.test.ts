// @vitest-environment node
// The holder's custody of outbound documents (Delivery 0.83 RLTP-DEL-6120 to 6135, 6330, 6335; lib
// 0.6.0), through the real adapter: one transport lease per opening, hand-over only from
// holder.pendingTransport through holder.handOver after a completed resume, no app-side store, the
// lease's copies withdrawn when the opening ends. Replaces the app-outbox regressions of reviews
// 420 R6 to R10 and 421 R5, R6 (rltp/design/store-launch-v3/app-outbox-lock-diagnose-2026-10-20.md).
import type { TransportHandlers } from '../../src/adapters/rltp/transport'
import { expect, it } from 'vitest'
import { DAY, counting, isAck, pair } from './pair'

const count = (seen: { digest: string }[], d: string) => seen.filter((x) => x.digest === d).length

it('a document held offline survives a process end and reaches the contact from the holder alone (R7-1, R8-1, R9)', async () => {
  const seen: { digest: string; type: string }[] = []
  const p = await pair(counting(seen))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const doc = seen.find((o) => !isAck(o))!.digest
    expect((await p.state()).outbox[doc]).toBeDefined()
    // no app-side copy anywhere
    expect((await p.kvKeys()).some((k) => k.startsWith('out:'))).toBe(false)
    await p.reopen(true)
    expect(count(seen, doc)).toBe(2) // the next opening hands it over again
    p.carrier.setOnline('A', true)
    await p.rounds()
    expect(p.B().models()?.decisions).toHaveLength(1)
  } finally { await p.close() }
})

it('an acknowledgement held offline survives a process end and goes out again; awaiting-transport ends nothing (R9-1, 6330)', async () => {
  const seen: { digest: string; type: string }[] = []
  let offlineAtAck = true
  const p = await pair((t) => ({ ...t, submit(out) {
    for (const o of out) {
      seen.push({ digest: o.digest, type: o.type })
      if (isAck(o) && offlineAtAck) p.carrier.setOnline('A', false)
    }
    t.submit(out)
  } }))
  try {
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    const ack = seen.find(isAck)!.digest
    const held = Object.values((await p.state()).effects).find((e) => e.ack?.digest === ack)!.ack!
    expect(held.sent ?? false).toBe(false)
    offlineAtAck = false
    await p.reopen(true)
    p.carrier.setOnline('A', true)
    await p.rounds()
    expect(count(seen, ack)).toBeGreaterThan(1)
    const after = Object.values((await p.state()).effects).find((e) => e.ack?.digest === ack)!.ack!
    expect(after.sentBy).toBe('accepted')
  } finally { await p.close() }
})

it('an acknowledgement without any report stops at the holder\'s horizon and never outlives it (R10-1, 6335)', async () => {
  const seen: { digest: string; type: string }[] = []
  // acknowledgements never reach the carrier: no report at all
  const p = await pair(counting(seen, (o) => !isAck(o)))
  try {
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    const ack = seen.find(isAck)!.digest
    p.clock.advance(8 * DAY)
    p.foreground(); await p.settle()
    expect(Object.values((await p.state()).effects).find((e) => e.ack?.digest === ack)?.ack?.sentBy).toBe('horizon')
    const before = count(seen, ack)
    await p.reopen(true)
    expect(count(seen, ack)).toBe(before)
    p.clock.advance(100 * DAY)
    p.foreground(); await p.settle()
    await p.reopen(true)
    expect(count(seen, ack)).toBe(before)
  } finally { await p.close() }
})

it('a duplicate is answered once with the stored acknowledgement and decides nothing twice (R10 control, 6330)', async () => {
  const seen: { digest: string; type: string }[] = []
  let bundle: unknown
  const p = await pair(counting(seen), (t) => ({ ...t, submit(out) {
    for (const o of out) if (o.type.includes('encounter-bundle')) bundle = o
    t.submit(out)
  } }))
  try {
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    const ack = seen.find(isAck)!.digest
    const ids = p.A().models()!.decisions.map((d) => d.id)
    expect(ids).toHaveLength(1)
    const before = count(seen, ack)
    const injector = p.carrier.endpoint('injector')
    const injected: TransportHandlers = { envelope: async () => 'not-mine', report: () => {} }
  injector.start(injected)
    injector.submit([bundle as never])
    await p.settle()
    expect(p.A().models()!.decisions.map((d) => d.id)).toEqual(ids)
    expect(count(seen, ack)).toBe(before + 1)
    injector.stop(injected)
  } finally { await p.close() }
})

it('a duplicate\'s answer due at a process end goes out from the next opening (process end with an answer due)', async () => {
  const seen: { digest: string; type: string }[] = []
  let bundle: unknown
  let refuseAcks = false
  const p = await pair((t) => ({ ...t, submit(out) {
    if (refuseAcks && out.some(isAck)) throw Error('carrier unavailable')
    seen.push(...out.map((o) => ({ digest: o.digest, type: o.type })))
    t.submit(out)
  } }), (t) => ({ ...t, submit(out) {
    for (const o of out) if (o.type.includes('encounter-bundle')) bundle = o
    t.submit(out)
  } }))
  try {
    expect((await p.scanned()).ok).toBe(true)
    await p.settle()
    const ack = seen.find(isAck)!.digest
    const before = count(seen, ack)
    refuseAcks = true
    const injector = p.carrier.endpoint('injector')
    const injected: TransportHandlers = { envelope: async () => 'not-mine', report: () => {} }
  injector.start(injected)
    injector.submit([bundle as never])
    await p.settle()
    injector.stop(injected)
    expect(count(seen, ack)).toBe(before)
    const due = Object.values((await p.state()).effects).find((e) => e.ack?.digest === ack)!.ack!
    expect(due.answerDue).toBeDefined()
    refuseAcks = false
    await p.reopen(true)
    expect(count(seen, ack)).toBe(before + 1)
    await p.reopen(true)
    expect(count(seen, ack)).toBe(before + 1) // the begun hand-over ended it
  } finally { await p.close() }
})

it('a document expired while closed is never handed over again (R8-2, R10 control, 421 R6-1)', async () => {
  const seen: { digest: string; type: string }[] = []
  const p = await pair(counting(seen))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const doc = seen.find((o) => !isAck(o))!.digest
    const before = count(seen, doc)
    await p.shutdownA()
    p.clock.advance(8 * DAY)
    await p.reopen(true)
    expect(count(seen, doc)).toBe(before)
    p.carrier.setOnline('A', true)
    await p.settle()
    expect(p.B().models()!.decisions).toHaveLength(0)
  } finally { await p.close() }
})

it('a document the holder gives up while open leaves the device: going online sends nothing (R8-2, 6135)', async () => {
  const seen: { digest: string; type: string }[] = []
  const p = await pair(counting(seen))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const doc = seen.find((o) => !isAck(o))!.digest
    p.clock.advance(8 * DAY)
    p.foreground(); await p.settle()
    expect((await p.state()).outbox[doc]!.history.at(-1)!.status).toBe('failed')
    p.carrier.setOnline('A', true)
    await p.settle()
    expect(p.B().models()!.decisions).toHaveLength(0)
    await p.reopen()
    expect(count(seen, doc)).toBe(1)
  } finally { await p.close() }
})

it('a lock during a hand-over: nothing reaches the contact after it, the next opening hands over again (lock during hand-over)', async () => {
  const seen: { digest: string; type: string }[] = []
  let lockOnSubmit = false
  let lock = () => {}
  const p = await pair((t) => ({ ...t, submit(out) {
    seen.push(...out.map((o) => ({ digest: o.digest, type: o.type })))
    t.submit(out)
    if (lockOnSubmit) { lockOnSubmit = false; lock() }
  } }))
  lock = () => { void p.shutdownA() }
  try {
    p.carrier.setOnline('A', false)
    lockOnSubmit = true
    await p.scan() // the act committed; its journal may end locked
    await p.settle()
    expect(seen.filter((o) => !isAck(o))).toHaveLength(1)
    // the device withdrew the copy with the lease: going online delivers nothing
    p.carrier.setOnline('A', true)
    await p.settle()
    expect(p.B().models()!.decisions).toHaveLength(0)
    await p.reopen(true)
    await p.rounds()
    expect(p.B().models()!.decisions).toHaveLength(1)
  } finally { await p.close() }
})

it('a refused hand-over at activation recovers without another act (R7-2)', async () => {
  let fail = false, refusals = 0
  const p = await pair((t) => ({ ...t, submit(out) {
    if (fail) { fail = false; refusals++; throw Error('temporarily unavailable') }
    t.submit(out)
  } }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    fail = true
    await p.reopen()
    expect(refusals).toBe(1)
    expect(p.A()).not.toBeNull()
    p.carrier.setOnline('A', true)
    await p.rounds()
    expect(p.B().models()?.decisions).toHaveLength(1)
  } finally { await p.close() }
})
