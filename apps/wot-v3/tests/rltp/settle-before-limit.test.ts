// @vitest-environment node
// The library's journal is asked before an open record is given up at its age limit, on every path:
// a manual confirmation or retry past the app's limit, still within the library's retention, takes
// the committed result over with its writes, as the automatic recovery does. And an encounter card
// shown as expired stays expired after the device clock went back.
import { afterEach, describe, expect, it } from 'vitest'
import { ACTS, type ActSpec } from '../../src/adapters/rltp/acts'
import type { CommandName, Connection, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'
import { mediatorDouble, phoneNet } from '../../harness/mediator-double'

const DAY = 86_400_000
const T0 = Date.parse('2026-11-20T10:00:00Z')

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

/** a device clock that jumps without running any timer: the moment before the next timer pass */
function jumpingClock() {
  const base = virtualClock(T0, 'UTC')
  let skew = 0
  const clock = { ...base, now: () => base.now() + skew }
  return { clock: clock as unknown as ReturnType<typeof virtualClock>, jump: (ms: number) => void (skew += ms) }
}

const original = new Map<CommandName, ActSpec>()
/** the act of `command` commits in the library once and its answer never reaches the app */
function loseFirstAnswer(command: CommandName) {
  const spec = ACTS[command]!
  original.set(command, spec)
  let lost = true
  ACTS[command] = {
    ...spec,
    run: async (...a) => {
      const r = await spec.run(...a)
      if (!lost) return r
      lost = false
      throw new Error('the process died after the commit')
    },
  }
}
afterEach(() => {
  for (const [command, spec] of original) ACTS[command] = spec
  original.clear()
})

async function pair() {
  const med = mediatorDouble()
  const { clock, jump } = jumpingClock()
  const A = await loopbackDevice({ carrier: { mediator: { did: med.did, net: phoneNet(med.net).net } }, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 81, ceremony: 'shared-connect' })
  const B = await loopbackDevice({ carrier: { mediator: { did: med.did, net: phoneNet(med.net).net } }, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 83, ceremony: 'shared-connect' })
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await med.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return { A, B, jump, settle }
}

describe('an open record past the app\'s limit, committed in the library (review of #562)', () => {
  it('confirmed again by hand at 89.5 days: the committed proposal, its writes, the record done', async () => {
    const w = await pair()
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    await w.settle()
    loseFirstAnswer('confirmCard')
    const first = w.A.port.trust.confirmCard(shown.value.qr, 'camera')
    expect((await first.done).ok).toBe(false)
    w.jump(89.5 * DAY)
    const again = await w.A.port.intents.confirmIntent(first.actId).done
    expect(again).toMatchObject({ ok: true, value: { kind: 'proposed' } })
    await w.settle()
    expect(value(w.A.port.stores.connections) as readonly Connection[]).toMatchObject([{ role: 'responder' }])
    expect(w.A.port.stores.intents.get().find((x) => x.actId === first.actId)).toBeUndefined()
  })

  it('retried by hand at 89.5 days: the committed acceptance, the record done', async () => {
    const w = await pair()
    const shown = await w.B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    await w.settle()
    expect((await w.A.port.trust.confirmCard(shown.value.qr, 'camera').done).ok).toBe(true)
    await w.settle()
    const [d] = value(w.B.port.stores.decisions)
    loseFirstAnswer('decide')
    const first = w.B.port.trust.decide(d!.id, 'accept')
    expect((await first.done).ok).toBe(false)
    w.jump(89.5 * DAY)
    const again = await w.B.port.intents.retryIntent(first.actId).done
    expect(again).toMatchObject({ ok: true })
    expect(w.B.port.stores.intents.get().find((x) => x.actId === first.actId)).toBeUndefined()
  })
})

describe('an encounter card shown as expired, the clock set back (review of #562)', () => {
  it('six minutes old, a later act, back to minute four: still code-expired, no contact', async () => {
    const carrier = memoryCarrier()
    const clock = virtualClock(T0, 'UTC')
    const A = await loopbackDevice({ carrier, clock, id: 'A', name: 'A', words: LOOPBACK_PHRASES[0], seed: 91 })
    const B = await loopbackDevice({ carrier, clock, id: 'B', name: 'B', words: LOOPBACK_PHRASES[1], seed: 92 })
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    clock.set(T0 + 6 * 60_000)
    expect(await A.port.trust.previewCard(shown.value.qr)).toEqual({ ok: false, error: { kind: 'refused', code: 'code-expired' } })
    expect((await A.port.trust.setProfile({ name: 'A.' }).done).ok).toBe(true)
    clock.rewind(2 * 60_000)
    expect(await A.port.trust.previewCard(shown.value.qr)).toEqual({ ok: false, error: { kind: 'refused', code: 'code-expired' } })
    expect(value(A.port.stores.contacts)).toEqual([])
  })
})
