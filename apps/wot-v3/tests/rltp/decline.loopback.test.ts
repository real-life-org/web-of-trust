// @vitest-environment node
// "Decline" on the decision card in the conversation (handshake UX, Anton 29.10., A2): the port's
// decide(id, 'decline') on an open encounter-confirm, on the real adapter and the real library. The
// library only closes the prompt (encounter/ceremony confirmDecision: no issuance, no outbound): the
// edge stays one-sided, the scanner keeps seeing "outgoing", and the counter-step stays possible
// (RLTP-ENC-5750; the library's counter finds the displayer's record without a prompt).
import { expect, it } from 'vitest'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'
import { virtualClock } from '../../src/platform/fake'
import type { ContactId, Loadable, ReadStore } from '../../src/port'
import type { Transport } from '../../src/adapters/rltp/transport'

const T0 = Date.parse('2026-10-29T10:00:00Z')

const val = <T>(s: ReadStore<Loadable<T>>): T => {
  const r = s.get()
  if (r.status !== 'ready') throw Error('not ready')
  return r.value
}

async function pair() {
  const clock = virtualClock(T0, 'UTC')
  const carrier = memoryCarrier(clock)
  /** what each device hands its carrier: the wire, as far as the app can put anything on it */
  const submitted: Record<string, number> = { A: 0, B: 0 }
  const counting = (id: string) => (t: Transport): Transport => ({
    ...t,
    submit(out) {
      submitted[id] = (submitted[id] ?? 0) + out.length
      t.submit(out)
    },
  })
  const A = await loopbackDevice({ carrier, clock, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], seed: 91, wrap: counting('A') as never })
  const B = await loopbackDevice({ carrier, clock, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], seed: 93, wrap: counting('B') as never })
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
    }
  }
  return { A, B, submitted, settle }
}

it('A2: decline closes the confirmation on this device only; nothing goes out; the scanner stays outgoing; confirming later still makes both mutual', async () => {
  const { A, B, submitted, settle } = await pair()
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw Error('show')
  const scan = await A.port.trust.confirmCard(shown.value.qr).done
  if (!scan.ok || scan.value.kind !== 'scanned') throw Error('scan')
  await settle()
  const [d] = val(B.port.stores.decisions)
  if (!d || d.kind !== 'encounter-confirm' || d.state !== 'open') throw Error('decision')
  const bSide = d.contactId
  const aSide = scan.value.contactId
  const row = () => val(B.port.stores.contacts).find((c) => c.id === bSide)
  expect(row()).toMatchObject({ verification: 'incoming', conversation: { openDecisions: 1, preview: { kind: 'decision' } } })
  const before = { ...submitted }
  // the count sees the wire: the scanner's bundle went out through it
  expect(before.A).toBeGreaterThan(0)

  expect((await B.port.trust.decide(d.id, 'decline').done).ok).toBe(true)
  await settle()

  // gone from the queue, the list (dot and preview) and the conversation's open card
  expect(val(B.port.stores.decisions)).toEqual([])
  expect(row()?.conversation.openDecisions).toBe(0)
  expect(row()?.conversation.preview?.kind).not.toBe('decision')
  const item = val(B.port.stores.conversation(`c:${bSide}`)).items.find((i) => i.kind === 'decision')
  expect(item).toMatchObject({ resolution: { choice: 'decline', basis: 'own-act', by: 'this-device' } })
  // silent: nothing on the wire, the other side learns nothing and stays outgoing
  expect(submitted).toEqual(before)
  expect(val(A.port.stores.contacts).find((c) => c.id === aSide)?.verification).toBe('outgoing')
  // the edge stays one-sided here as well, and the counter-step stays offered (contact detail)
  const detail = val(B.port.stores.contact(bSide))
  expect(detail).toMatchObject({ verification: 'incoming', actions: { counterVerify: { ok: true } } })

  // later: confirming from the contact detail still works (RLTP-ENC-5750)
  expect((await B.port.trust.counterVerify(bSide as ContactId).done).ok).toBe(true)
  await settle()
  expect(val(B.port.stores.contacts).find((c) => c.id === bSide)?.verification).toBe('mutual')
  expect(val(A.port.stores.contacts).find((c) => c.id === aSide)?.verification).toBe('mutual')
})
