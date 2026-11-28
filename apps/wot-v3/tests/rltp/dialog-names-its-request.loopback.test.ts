// @vitest-environment node
// A dialog that shows a confirmation request accepts exactly that request, by its id (#568). After two
// meetings whose contacts the library joined (Trust 6a.4), two requests of one person can be open; the
// contact no longer says which one the person tapped. The incoming sheet and the verify flow hand the
// request's id on to the act; a request gone between showing and tapping leaves the other one untouched.
import { describe, expect, it } from 'vitest'
import type { DecisionId, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { incoming, incomingStart, type IncomingEntry } from '../../src/flows/incoming'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import { incomingExecutor } from '../../src/hooks/incoming'
import { verifyExecutor } from '../../src/hooks/verify'
import { memoryCarrier } from '../../src/adapters/rltp'
import { LOOPBACK_PHRASES, loopbackDevice } from '../../harness/loopback'

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

/** Bea showed two cards a minute apart, Al scanned both; the two contacts Bea holds of Al are joined, both
 *  requests are open and name the one person */
async function twoRequests() {
  const carrier = memoryCarrier()
  const clock = virtualClock(Date.now(), 'UTC')
  const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 81, ceremony: 'card' })
  const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 83, ceremony: 'card' })
  const rest = async () => {
    for (let i = 0; i < 8; i++) {
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  const pass = async (ms: number) => {
    for (let t = 0; t < ms; t += 2000) {
      clock.advance(2000)
      await rest()
    }
  }
  const open = () => value(B.port.stores.decisions).flatMap((d) => (d.kind === 'encounter-confirm' && d.state === 'open' ? [d] : []))
  const scan = async (seen: ReadonlySet<string>) => {
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    expect((await A.port.trust.confirmCard(shown.value.qr).done).ok).toBe(true)
    await rest()
    const d = open().find((x) => !seen.has(x.id))
    if (!d) throw new Error('no request at B')
    return d.id
  }
  const first = await scan(new Set())
  await pass(60_000)
  const second = await scan(new Set([first]))
  await pass(3 * 60_000)
  const contacts = value(B.port.stores.contacts)
  expect(contacts).toHaveLength(1)
  expect(contacts[0]!.aliases.length).toBeGreaterThan(0)
  expect(open().map((d) => d.id).sort()).toEqual([first, second].sort())
  // both name the person now: the contact does not tell them apart
  expect(new Set(open().map((d) => d.contactId)).size).toBe(1)
  const entry = (id: DecisionId): IncomingEntry => {
    const d = open().find((x) => x.id === id)!
    return { id, contactId: d.contactId, name: 'Al', openedAt: d.openedAt, validUntil: clock.now() + 60_000 }
  }
  return { B, clock, rest, open: () => open().map((d) => d.id), first, second, entry, contactId: contacts[0]!.id }
}

const turns = async (ok: () => boolean) => {
  for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 0))
  if (!ok()) throw new Error('never reached')
}

describe('a dialog accepts the request it shows (#568)', () => {
  it('the incoming sheet shows the second request, confirmed: exactly it closes, the first stays open', async () => {
    const w = await twoRequests()
    const r = createFlowRunner(incoming, incomingStart(w.clock.now()), incomingExecutor(w.B.port, w.B.platform))
    r.send({ type: 'decisions', entries: [w.entry(w.second)], now: w.clock.now() })
    expect(r.get()).toMatchObject({ name: 'asking', head: { id: w.second } })
    r.send({ type: 'confirm' })
    await turns(() => (r.get() as { busy?: boolean }).busy !== true)
    await w.rest()
    expect(w.open()).toEqual([w.first])
    r.dispose()
  }, 120_000)

  it('the shown request is answered elsewhere between showing and confirming: the confirmation fails, the other request stays open', async () => {
    const w = await twoRequests()
    const r = createFlowRunner(incoming, incomingStart(w.clock.now()), incomingExecutor(w.B.port, w.B.platform))
    r.send({ type: 'decisions', entries: [w.entry(w.second)], now: w.clock.now() })
    expect((await w.B.port.trust.decide(w.second, 'decline').done).ok).toBe(true)
    await w.rest()
    r.send({ type: 'confirm' })
    await turns(() => (r.get() as { busy?: boolean }).busy !== true)
    await w.rest()
    expect(r.rows).toContain('asking.result.failed')
    expect(w.open()).toEqual([w.first])
    r.dispose()
  }, 120_000)

  it('the verify flow’s counter-step with the request it shows: exactly it closes; without one, the contact’s counter-step', async () => {
    const w = await twoRequests()
    const exec = verifyExecutor(w.B.port, w.B.platform, { current: null })
    const done = await exec({ id: 'ver.counter', run: 1, contactId: w.contactId, decision: w.second })
    expect(done.ok).toBe(true)
    await w.rest()
    expect(w.open()).toEqual([w.first])
  }, 120_000)
})
