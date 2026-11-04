// The in-memory carrier can be watched (architecture §7.4, the workbench's wire): one event when a
// device submits a document, one per endpoint the carrier offers it to, with that endpoint's answer.
// Watching changes nothing about delivery; a watcher that throws is dropped, not the delivery.
import { describe, expect, it } from 'vitest'
import { memoryCarrier, type CarrierEvent, type Transport, type TransportHandlers } from '../../src/adapters/rltp/transport'

type Outbound = Parameters<Transport['submit']>[0][number]

const doc = (digest: string, type = 'https://real-life.org/trust-tasks/spec/message/0.1'): Outbound =>
  ({ digest, envelope: { v: 'x', body: digest } as unknown as Outbound['envelope'], type, threadId: 't-' + digest, recipient: { rkid: 'r' } as unknown as Outbound['recipient'], attempt: 1 })

const handlers = (answer: 'taken' | 'not-mine' | 'later'): TransportHandlers & { seen: unknown[]; reports: string[] } => {
  const h = {
    seen: [] as unknown[],
    reports: [] as string[],
    async envelope(env: unknown) {
      h.seen.push(env)
      return answer
    },
    report(r: { digest: string; status: string }) {
      h.reports.push(`${r.digest}:${r.status}`)
    },
  }
  return h
}

describe('memoryCarrier.tap', () => {
  it('a submission and each offer are reported, with the receiver’s answer', async () => {
    const c = memoryCarrier()
    const events: CarrierEvent[] = []
    c.tap((e) => events.push(e))
    const a = c.endpoint('a'), b = c.endpoint('b'), x = c.endpoint('x')
    a.start(handlers('not-mine'))
    b.start(handlers('taken'))
    x.start(handlers('not-mine'))
    a.submit([doc('d1')])
    await c.settled()
    expect(events).toEqual([
      { kind: 'submitted', from: 'a', digest: 'd1', type: 'https://real-life.org/trust-tasks/spec/message/0.1', threadId: 't-d1', attempt: 1 },
      { kind: 'offered', to: 'b', digest: 'd1', answer: 'taken' },
      { kind: 'offered', to: 'x', digest: 'd1', answer: 'not-mine' },
    ])
  })

  it('an endpoint that is offline is not offered the document until it comes back: the offer comes then', async () => {
    const c = memoryCarrier()
    const events: CarrierEvent[] = []
    c.tap((e) => events.push(e))
    const a = c.endpoint('a'), b = c.endpoint('b')
    a.start(handlers('not-mine'))
    b.start(handlers('taken'))
    c.setOnline('b', false)
    a.submit([doc('d2')])
    await c.settled()
    expect(events.filter((e) => e.kind === 'offered')).toEqual([])
    c.setOnline('b', true)
    await c.settled()
    expect(events.filter((e) => e.kind === 'offered')).toEqual([{ kind: 'offered', to: 'b', digest: 'd2', answer: 'taken' }])
  })

  it('a transient refusal is reported as such, and the redelivery as another offer', async () => {
    const c = memoryCarrier()
    const events: CarrierEvent[] = []
    c.tap((e) => events.push(e))
    const a = c.endpoint('a'), b = c.endpoint('b')
    a.start(handlers('not-mine'))
    let n = 0
    b.start({ ...handlers('later'), envelope: async () => (n++ === 0 ? 'later' : 'taken') })
    a.submit([doc('d3')])
    await c.settled()
    expect(events.filter((e) => e.kind === 'offered')).toEqual([{ kind: 'offered', to: 'b', digest: 'd3', answer: 'later' }])
    // without a clock the carrier offers it again at the next start of the endpoint
    b.start({ ...handlers('taken'), envelope: async () => 'taken' })
    await c.settled()
    expect(events.filter((e) => e.kind === 'offered').map((e) => e.kind === 'offered' && e.answer)).toEqual(['later', 'taken'])
  })

  it('untap stops the events; a watcher that throws does not touch the delivery', async () => {
    const c = memoryCarrier()
    const events: CarrierEvent[] = []
    const off = c.tap((e) => events.push(e))
    c.tap(() => {
      throw new Error('watcher broke')
    })
    const a = c.endpoint('a'), b = c.endpoint('b')
    a.start(handlers('not-mine'))
    const hb = handlers('taken')
    b.start(hb)
    a.submit([doc('d4')])
    await c.settled()
    expect(hb.seen).toHaveLength(1)
    expect(events).toHaveLength(2)
    off()
    a.submit([doc('d5')])
    await c.settled()
    expect(hb.seen).toHaveLength(2)
    expect(events).toHaveLength(2)
  })
})
