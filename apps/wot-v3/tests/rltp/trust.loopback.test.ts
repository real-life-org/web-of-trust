// @vitest-environment node
// Trust and the profile over the real adapter and the real library (Trust §2a, §6, §6b). Nothing on
// the wire says "trust": A's act sends A's anchor (anchor-mapping), and B's "trusts you" is what B
// derives from the verified anchor it holds. The profile travels only toward the contacts the profile
// class is on for, by default the trusted ones (2760, 6455): a changed name reaches B once A trusts B.
import { describe, expect, it } from 'vitest'
import type { ContactId, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice } from '../../harness/loopback'

const T0 = Date.parse('2026-10-30T09:00:00+01:00')
const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

async function met() {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'Europe/Berlin')
  const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 51 })
  const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 53 })
  // the class duties issue on the holder's resume, which the session schedules on its timers: each
  // round moves the phones' clock a second, as device time would
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      clock.advance(1000)
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
    }
  }
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw new Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done
  await settle()
  const bId = value(B.port.stores.contacts)[0]!.id
  await B.port.trust.counterVerify(bId).done
  await settle()
  const aId = value(A.port.stores.contacts)[0]!.id
  return { carrier, clock, A, B, aId, bId, settle }
}

const row = (d: LoopbackDevice) => value(d.port.stores.contacts)[0]!
const detail = (d: LoopbackDevice, id: ContactId) => value(d.port.stores.contact(id))!
const lines = (d: LoopbackDevice, id: ContactId) =>
  value(d.port.stores.conversation(`c:${id}`))
    .items.filter((i) => i.kind === 'system')
    .map((i) => (i as { readonly system: string }).system)

describe('trust over the real adapter (loopback)', () => {
  it('A trusts B: A sends its anchor; B derives "trusts you" from the verified anchor, nothing else arrives; back, both ways', async () => {
    const w = await met()
    expect(row(w.A).trust).toEqual({ given: false, received: false, paused: false, pending: false })
    expect(detail(w.A, w.aId).actions).toMatchObject({ giveTrust: { ok: true }, withdrawTrust: { ok: false }, pause: { ok: true } })

    const r = await w.A.port.trust.giveTrust(w.aId).done
    expect(r).toEqual({ ok: true })
    await w.settle()
    expect(row(w.A).trust).toMatchObject({ given: true, received: false, pending: false })
    expect(row(w.B).trust).toMatchObject({ given: false, received: true })
    expect(detail(w.A, w.aId).actions).toMatchObject({ giveTrust: { ok: false, reason: 'already-done' }, withdrawTrust: { ok: true } })
    // the conversation tells it once on each side, as an observed line
    expect(lines(w.A, w.aId)).toContain('trustOut')
    expect(lines(w.B, w.bId)).toContain('trustIn')
    // trust already given: the library refuses a second act (already-given), the app says already-done;
    // nothing is sent twice and the conversation keeps its one line
    expect(await w.A.port.trust.giveTrust(w.aId).done).toEqual({ ok: false, error: { kind: 'refused', code: 'already-done' } })
    await w.settle()
    expect(lines(w.A, w.aId).filter((t) => t === 'trustOut')).toHaveLength(1)

    expect((await w.B.port.trust.giveTrust(w.bId).done).ok).toBe(true)
    await w.settle()
    expect(row(w.A).trust).toMatchObject({ given: true, received: true })
    expect(row(w.B).trust).toMatchObject({ given: true, received: true })
    expect(value(w.A.port.stores.profile)).toMatchObject({})
  })

  it('withdrawing turns the class off on this side; the anchor B already holds stays, B still sees "trusts you" (2840)', async () => {
    const w = await met()
    await w.A.port.trust.giveTrust(w.aId).done
    await w.settle()
    expect((await w.A.port.trust.withdrawTrust(w.aId).done).ok).toBe(true)
    await w.settle()
    expect(row(w.A).trust).toMatchObject({ given: false })
    expect(detail(w.A, w.aId).actions).toMatchObject({ giveTrust: { ok: true }, withdrawTrust: { ok: false, reason: 'already-done' } })
    expect(lines(w.A, w.aId)).toContain('trustWithdrawn')
    expect(row(w.B).trust).toMatchObject({ received: true })
  })

  it('pausing is the star and the blinded group star off (2780): paused on this side, nothing the other side is told', async () => {
    const w = await met()
    expect((await w.A.port.trust.setPaused(w.aId, true).done).ok).toBe(true)
    await w.settle()
    expect(row(w.A).trust).toMatchObject({ paused: true })
    expect(row(w.B).trust).toMatchObject({ paused: false, received: false })
    expect((await w.A.port.trust.setPaused(w.aId, false).done).ok).toBe(true)
    await w.settle()
    expect(row(w.A).trust).toMatchObject({ paused: false })
  })

  it('the profile: a new name reaches a contact only once trusted (2760, 6455); the untrusted one keeps the card name', async () => {
    const w = await met()
    expect(row(w.B).name).toBe('Al')
    expect(value(w.A.port.stores.profile).name).toBe('Al')

    expect((await w.A.port.trust.setProfile({ name: 'Alfred' }).done).ok).toBe(true)
    await w.settle()
    expect(value(w.A.port.stores.profile).name).toBe('Alfred')
    // B is not trusted by A: the profile class is off toward B, B keeps the name from the card
    expect(row(w.B).name).toBe('Al')

    await w.A.port.trust.giveTrust(w.aId).done
    await w.settle()
    // the class turned on toward B: A's current profile goes out (2850), B shows it
    expect(row(w.B).name).toBe('Alfred')
    expect(detail(w.B, w.bId).name).toBe('Alfred')

    // a later change follows on its own
    w.clock.advance(60_000)
    expect((await w.A.port.trust.setProfile({ name: 'Alfred Ott' }).done).ok).toBe(true)
    await w.settle()
    expect(row(w.B).name).toBe('Alfred Ott')
    // B's own name is untouched, and A sees B under the card name until B trusts A
    expect(value(w.B.port.stores.profile).name).toBe('Bea')
    expect(row(w.A).name).toBe('Bea')
  })

  it('a class set individually (2780, 2810): the profile class off toward a trusted contact holds the name back; on again sends the current one (2850)', async () => {
    const w = await met()
    await w.A.port.trust.giveTrust(w.aId).done
    await w.settle()
    expect(detail(w.A, w.aId).classes.profile).toEqual({ setting: 'default', on: true })
    expect((await w.A.port.trust.setClass(w.aId, 'profile', 'off').done).ok).toBe(true)
    await w.settle()
    expect(detail(w.A, w.aId).classes.profile).toEqual({ setting: 'off', on: false })
    expect((await w.A.port.trust.setProfile({ name: 'Alfred' }).done).ok).toBe(true)
    await w.settle()
    expect(row(w.B).name).toBe('Al')
    expect((await w.A.port.trust.setClass(w.aId, 'profile', 'on').done).ok).toBe(true)
    await w.settle()
    expect(row(w.B).name).toBe('Alfred')
    // the trust itself is untouched by the class
    expect(row(w.A).trust.given).toBe(true)
  })
})
