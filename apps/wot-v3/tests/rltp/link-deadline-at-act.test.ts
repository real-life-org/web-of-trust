// @vitest-environment node
// The end of a link is read by the act that answers it, at the device time of the act (#556): an
// acceptance or a proposal whose act runs after the link ended issues nothing, even though the intent
// was journaled before the end. An act that committed before the end is settled from the library's
// journal, whenever it is settled.
import { afterEach, describe, expect, it } from 'vitest'
import { ACTS, type ActSpec } from '../../src/adapters/rltp/acts'
import type { CommandName, Connection, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, type LoopbackDevice } from '../../harness/loopback'
import { mediatorDouble, phoneNet } from '../../harness/mediator-double'

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}
const ceremonies = (d: LoopbackDevice): readonly Connection[] => value(d.port.stores.connections)

async function world() {
  const med = mediatorDouble()
  const clock = virtualClock(Date.parse('2026-11-20T10:00:00Z'), 'UTC')
  const A = await loopbackDevice({ carrier: { mediator: { did: med.did, net: phoneNet(med.net).net } }, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 51, ceremony: 'shared-connect' })
  const B = await loopbackDevice({ carrier: { mediator: { did: med.did, net: phoneNet(med.net).net } }, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 53, ceremony: 'shared-connect' })
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await med.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return { clock, A, B, settle }
}

/** the act of `command` runs `before` first, then itself: the time between the journal and the act */
const original = new Map<CommandName, ActSpec>()
function delay(command: CommandName, before: () => void) {
  const spec = ACTS[command]!
  original.set(command, spec)
  ACTS[command] = { ...spec, run: async (...a) => (before(), spec.run(...a)) }
}
afterEach(() => {
  for (const [command, spec] of original) ACTS[command] = spec
  original.clear()
})

describe('the end of a link at the act (#556)', () => {
  it('an acceptance journaled before the end and run after it issues nothing: code-expired, both ceremonies stay unaccepted', async () => {
    const w = await world()
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    await w.settle()
    expect((await w.A.port.trust.confirmCard(shown.value.qr, 'camera').done).ok).toBe(true)
    await w.settle()
    const [d] = value(w.B.port.stores.decisions)
    if (!d || d.kind !== 'connect-confirm') throw new Error('decision')
    const [atB] = ceremonies(w.B)
    // journaled now, run one second after the code's last valid moment
    delay('decide', () => w.clock.set(atB!.validUntil + 1000))
    const r = await w.B.port.trust.decide(d.id, 'accept').done
    expect(r).toEqual({ ok: false, error: { kind: 'refused', code: 'code-expired' } })
    await w.settle()
    expect(ceremonies(w.B)).toMatchObject([{ status: 'open', accepted: false }])
    expect(ceremonies(w.A)).toMatchObject([{ status: 'open', accepted: false }])
    expect(value(w.A.port.stores.contacts)).toEqual([])
  })

  it('a decline after the end still goes out: only an acceptance is bound to the code', async () => {
    const w = await world()
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    await w.settle()
    expect((await w.A.port.trust.confirmCard(shown.value.qr, 'camera').done).ok).toBe(true)
    await w.settle()
    const [d] = value(w.B.port.stores.decisions)
    const [atB] = ceremonies(w.B)
    delay('decide', () => w.clock.set(atB!.validUntil + 1000))
    expect((await w.B.port.trust.decide(d!.id, 'decline').done).ok).toBe(true)
    await w.settle()
    expect(ceremonies(w.B)).toMatchObject([{ status: 'declined' }])
  })

  it('an answer journaled before the end of its prompt and run after it is refused: decision-expired', async () => {
    const w = await world()
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    await w.settle()
    expect((await w.A.port.trust.confirmCard(shown.value.qr, 'camera').done).ok).toBe(true)
    await w.settle()
    const [d] = value(w.B.port.stores.decisions)
    if (!d || d.expiresAt === null) throw new Error('a prompt with an end')
    const end = d.expiresAt
    // the act reads the device time at the prompt's end before any timer of the session ran (its resume
    // would drop the prompt first)
    const spec = ACTS.decide!
    original.set('decide', spec)
    ACTS.decide = { ...spec, run: (h, i, o, ctx) => spec.run(h, i, o, { ...ctx, now: () => end }) }
    const r = await w.B.port.trust.decide(d.id, 'decline').done
    expect(r).toEqual({ ok: false, error: { kind: 'refused', code: 'decision-expired' } })
  })

  it('a proposal journaled before the end of the link and run after it proposes nothing: code-expired, no ceremony', async () => {
    const w = await world()
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    await w.settle()
    delay('confirmCard', () => w.clock.set(shown.value.expiresAt))
    const r = await w.A.port.trust.confirmCard(shown.value.qr, 'camera').done
    expect(r).toEqual({ ok: false, error: { kind: 'refused', code: 'code-expired' } })
    await w.settle()
    expect(ceremonies(w.A)).toEqual([])
    expect(value(w.B.port.stores.decisions)).toEqual([])
  })

  it('a proposal committed before the end whose result was lost is taken from the journal when confirmed again after the end', async () => {
    const w = await world()
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    await w.settle()
    // the act commits in the library, its answer never reaches the app
    const spec = ACTS.confirmCard!
    original.set('confirmCard', spec)
    let lost = true
    ACTS.confirmCard = {
      ...spec,
      run: async (...a) => {
        const r = await spec.run(...a)
        if (!lost) return r
        lost = false
        throw new Error('the process died after the commit')
      },
    }
    const first = w.A.port.trust.confirmCard(shown.value.qr, 'camera')
    expect((await first.done).ok).toBe(false)
    // the person confirms again after the link ended: the act is in the library's journal
    w.clock.set(shown.value.expiresAt + 1000)
    const again = await w.A.port.intents.confirmIntent(first.actId).done
    expect(again).toMatchObject({ ok: true, value: { kind: 'proposed' } })
    await w.settle()
    expect(ceremonies(w.A)).toMatchObject([{ role: 'responder', status: 'open' }])
  })
})
