// @vitest-environment node
// #426 (post-merge review of #420): a duplicate's answer begun while the regular acknowledgement of the
// same digest is still pending keeps its own identity up to the lease (TRANSPORT.md rule 6). The end of
// the regular retries, a failure or acceptance naming another deposit, and a shutdown are each decided
// per deposit; the answer ends only by the carrier taking the digest or by the end of the opening.
import { expect, it } from 'vitest'
import { DAY, isAck, pair } from './pair'
import { depositKey, shareTransport, type Transport, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { writableStore } from '../../src/port'

type Deposit = Parameters<Transport['submit']>[0][number] & { readonly resend?: number; readonly notAfter?: number }
const online = () => writableStore({ network: 'online' as const, carrier: 'connected' as const })
const handlers = (): TransportHandlers => ({ envelope: async () => 'taken', report() {} })

it('#426: a deposit identity tells a regular hand-over from a duplicate\'s answer', () => {
  expect(depositKey({ digest: 'd' })).toBe('d')
  expect(depositKey({ digest: 'd', resend: 0 })).toBe('d#0')
  expect(depositKey({ digest: 'd', resend: 3 })).toBe('d#3')
})

it('#426: 120 event orders of a regular deposit and a duplicate\'s answer of one digest agree with a two-deposit oracle', () => {
  type Op = 'endAnswer' | 'withdrawRegular' | 'failedRegular' | 'failedAnswer' | 'accepted'
  const permutations = (xs: readonly Op[]): Op[][] => (xs.length === 0 ? [[]] : xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map((tail) => [x, ...tail])))
  let cases = 0
  for (const order of permutations(['endAnswer', 'withdrawRegular', 'failedRegular', 'failedAnswer', 'accepted'])) {
    let registration!: TransportHandlers
    const regular = { digest: 'd' } as Deposit
    const answer = { digest: 'd', resend: 1 } as Deposit
    const name = (o: unknown) => (o === regular ? 'regular' : o === answer ? 'answer' : 'other')
    const withdrawn: string[][] = []
    const lease = shareTransport({ status: online(), start(h) { registration = h }, stop() {}, submit() {}, withdraw(out) { withdrawn.push(out.map(name)) } }).lease()
    lease.start(handlers()); lease.activate()
    lease.submit([regular]); lease.submit([answer])
    // The oracle (Delivery §6.1, TRANSPORT.md rule 6): each deposit is pending until the carrier takes the
    // digest (both end), a failure names it, or its own identity is withdrawn; the end of a duplicate's
    // answer keeps it pending; the shutdown withdraws whatever is still pending. It reads no adapter state.
    const pending = { regular: true, answer: true }
    const expected: string[][] = []
    for (const op of order) {
      if (op === 'endAnswer') lease.end([depositKey(answer)])
      else if (op === 'withdrawRegular') {
        if (pending.regular) expected.push(['regular'])
        pending.regular = false
        lease.withdraw([depositKey(regular)])
      } else if (op === 'failedRegular') {
        pending.regular = false
        registration.report({ digest: 'd', status: 'failed', reason: 'unroutable' }, regular)
      } else if (op === 'failedAnswer') {
        pending.answer = false
        registration.report({ digest: 'd', status: 'failed', reason: 'unroutable' }, answer)
      } else {
        pending.regular = pending.answer = false
        registration.report({ digest: 'd', status: 'accepted' }, regular)
      }
    }
    const rest = (['regular', 'answer'] as const).filter((k) => pending[k])
    if (rest.length > 0) expected.push([...rest])
    lease.stop()
    expect(withdrawn, order.join(',')).toEqual(expected)
    cases++
  }
  expect(cases).toBe(120)
})

/** A's carrier holds every acknowledgement it is given (no service answer yet); B's regular document is
 *  kept, so it can come again to A as a duplicate */
async function begunBeside() {
  let reg!: TransportHandlers
  let saved: Deposit | undefined
  const pending = new Set<Deposit>(), withdrawn: Deposit[] = []
  const p = await pair(
    (t) => ({ ...t, start(h) { reg = h; t.start(h) }, submit(out) { for (const o of out) { if (isAck(o)) pending.add(o); else t.submit([o]) } }, withdraw(out) { for (const o of out) if (pending.delete(o)) withdrawn.push(o); t.withdraw?.(out) } }),
    (t) => ({ ...t, submit(out) { for (const o of out) if (!isAck(o)) saved = o; t.submit(out) } }),
  )
  expect((await p.scanned()).ok).toBe(true)
  await p.settle()
  const original = saved!
  // one second before the regular retries end, the document comes again: its answer begins beside them
  p.clock.advance(7 * DAY - 1000); p.foreground(); await p.settle()
  expect(await reg.envelope(original.envelope)).toBe('taken')
  await p.settle()
  const answer = [...pending].find((o) => o.resend !== undefined)!
  const regular = [...pending].filter((o) => o.resend === undefined)
  expect(answer, 'the duplicate started a distinct deposit').toBeDefined()
  expect(regular.length, 'the regular acknowledgement is still pending beside it').toBeGreaterThan(0)
  return { p, reg: () => reg, pending, withdrawn, answer, regular }
}

it('#426: a failure naming a regular deposit leaves the begun answer pending across the regular retry end', async () => {
  const { p, reg, pending, withdrawn, answer, regular } = await begunBeside()
  try {
    for (const o of regular) { reg().report({ digest: o.digest, status: 'failed', reason: 'unroutable' }, o); pending.delete(o) }
    await p.settle()
    p.clock.advance(2000); p.foreground(); await p.settle()
    expect(answer.notAfter).toBeGreaterThan(p.clock.now())
    expect({ answerPending: pending.has(answer), answerWithdrawn: withdrawn.includes(answer) }).toEqual({ answerPending: true, answerWithdrawn: false })
    reg().report({ digest: answer.digest, status: 'accepted' }, answer); pending.delete(answer)
    await p.settle()
    const ack = Object.values((await p.state()).effects).find((e) => e.ack?.digest === answer.digest)?.ack
    expect(ack?.sent).toBe(true)
  } finally { await p.close() }
})

it('#426: the carrier taking the digest by its regular deposit ends the answer too; the retry end withdraws nothing of it', async () => {
  const { p, reg, withdrawn, answer, regular } = await begunBeside()
  try {
    reg().report({ digest: answer.digest, status: 'accepted' }, regular[0])
    await p.settle()
    p.clock.advance(2000); p.foreground(); await p.settle()
    expect(withdrawn.includes(answer), 'a deposit whose digest the carrier took is never withdrawn').toBe(false)
    const ack = Object.values((await p.state()).effects).find((e) => e.ack?.digest === answer.digest)?.ack
    expect(ack?.sent).toBe(true)
    expect(ack?.sentBy).not.toBe('horizon')
  } finally { await p.close() }
})

it('#426: a shutdown with both pending withdraws the regular deposits and the begun answer, nothing is handed over twice', async () => {
  const { p, pending, withdrawn, answer, regular } = await begunBeside()
  try {
    await p.reopen()
    expect(withdrawn).toContain(answer)
    for (const o of regular) expect(withdrawn).toContain(o)
    // the answer's entry ended by its begun hand-over: the next opening does not answer the duplicate again
    expect([...pending].filter((o) => o.resend !== undefined)).toEqual([])
    p.clock.advance(2000); p.foreground(); await p.settle()
    expect([...pending].filter((o) => o.resend !== undefined)).toEqual([])
  } finally { await p.close() }
})
