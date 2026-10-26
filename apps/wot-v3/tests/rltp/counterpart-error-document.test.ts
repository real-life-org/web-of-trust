// @vitest-environment node
// What a counterpart's error document (trust-task-error/0.5, VTI Mediator Adapter Profile 0.27 §5)
// does when it reaches this side today: the carrier hands every payload to the holder, which reads no
// error document. The holder judges it for good (answered 'taken': the carrier concludes and
// acknowledges it), and it changes no own document. The profile leaves validating it (proof, parties, that it answers a document of this
// side) to the delivery layer; the app cannot do that without the library (TRANSPORT.md "Counterpart
// error documents"), so the verdict is applied nowhere yet. This test pins that limit.
import { expect, it } from 'vitest'
import { memoryCarrier, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { virtualClock } from '../../src/platform/fake'
import { loopbackDevice, LOOPBACK_PHRASES } from '../../harness/loopback'

it('an error document of the counterpart is judged for good by the holder and changes no own document', async () => {
  const clock = virtualClock(Date.parse('2026-10-26T10:00:00Z'), 'UTC')
  const carrier = memoryCarrier()
  const handlers: TransportHandlers[] = []
  const A = await loopbackDevice({
    carrier: { ...carrier, endpoint(id) {
      const t = carrier.endpoint(id)
      return { ...t, start(h) { handlers.push(h); t.start(h) } }
    } },
    clock, id: 'A', name: 'A', words: LOOPBACK_PHRASES[0], seed: 26091,
  })
  try {
    // a terminal refusal as the registry writes it (the library's readTrustTaskError reads it as refused)
    const doc = { type: 'https://trusttasks.org/spec/trust-task-error/0.5', payload: { code: 'permissionDenied', retryable: false } }
    const before = A.port.session()?.models()
    const h = handlers.at(-1)
    if (!h) throw new Error('no transport start')
    expect(await h.envelope(doc)).toBe('taken')
    expect(A.port.session()?.models()).toEqual(before)
  } finally {
    await A.port.runtime.lock('user')
  }
})
