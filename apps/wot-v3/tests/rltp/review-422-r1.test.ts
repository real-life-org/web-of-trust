// @vitest-environment node
// Review 422 round 1 (gpt-6.1-sol): a profile update under a block is not shown (Message Tasks 6230,
// `profile/0.1` process, do not show); a failure between the two parts of block / unblock is completed
// by recovery (paper §7.1, §7.6; architecture §2.7 rule 2); report is not offered for a blocked contact.
import { afterEach, expect, it, vi } from 'vitest'
import { secret, type ContactId, type Loadable, type ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'

type Res = { ok: boolean }
interface HolderLike {
  setClass(contactId: string, cls: string, v: string, o: { when: number; actId: string }): Promise<Res>
  setProfile(p: { name: string }, o: { when: number; actId: string }): Promise<Res>
  resume(when: number): Promise<unknown>
  pauseTrust(...a: unknown[]): Promise<Res>
}
const capture = vi.hoisted(() => ({ holders: [] as HolderLike[], failPause: false }))
vi.mock('@real-life/trust-protocol', async (original) => {
  const lib = await original<{ createHolder: (...args: unknown[]) => Promise<HolderLike> }>()
  return {
    ...lib,
    createHolder: async (...args: unknown[]) => {
      const h = await lib.createHolder(...args)
      capture.holders.push(h)
      return {
        ...h,
        pauseTrust: (...a: unknown[]) => {
          if (capture.failPause) {
            capture.failPause = false
            throw new Error('injected storage failure between block and pause')
          }
          return h.pauseTrust(...a)
        },
      }
    },
  }
})
afterEach(() => { capture.holders.length = 0; capture.failPause = false })
const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get(); if (v.status !== 'ready') throw Error(v.status); return v.value
}
async function world() {
  const carrier = memoryCarrier(), clock = virtualClock(Date.parse('2026-10-15T20:30:00Z'), 'UTC')
  const A = await loopbackDevice({ carrier, clock, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], seed: 141 })
  const ah = capture.holders.at(-1)!
  const B = await loopbackDevice({ carrier, clock, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], seed: 143 })
  const settle = async () => { for (let i = 0; i < 8; i++) { await carrier.settled(); await A.port.session()?.idle(); await B.port.session()?.idle(); await new Promise(r => setTimeout(r, 0)) } }
  const shown = await B.port.trust.showCard().done; if (!shown.ok) throw Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done; await settle()
  const bId = value(B.port.stores.contacts)[0]!.id
  await B.port.trust.counterVerify(bId).done; await settle()
  const aId = value(A.port.stores.contacts)[0]!.id
  const block = () => B.port.trust.block({ kind: 'contact', contactId: bId })
  const reopen = async () => { await B.port.runtime.lock('user'); await B.port.runtime.unlock.passphrase(secret('harness passphrase')); await B.port.runtime.unlock.open(); await settle() }
  const messages = (id: ContactId = bId) => value(B.port.stores.conversation(`c:${id}`)).items.filter(x => x.kind === 'message')
  return { A, B, ah, clock, settle, aId, bId, block, reopen, messages }
}

it('R1-1: a profile update from the blocked sender is not shown; the name from before the block stays', async () => {
  const w = await world()
  expect((await w.ah.setClass(w.aId, 'profile', 'on', { when: w.clock.now(), actId: 'enable-profile' })).ok).toBe(true)
  expect((await w.ah.setProfile({ name: 'Al Before' }, { when: w.clock.now(), actId: 'profile-before' })).ok).toBe(true)
  await w.ah.resume(w.clock.now())
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, name: 'Al Before' })
  expect((await w.block().done).ok).toBe(true)
  await w.settle()
  expect((await w.ah.setProfile({ name: 'BLOCKED PROFILE CONTENT' }, { when: w.clock.now(), actId: 'profile-under-block' })).ok).toBe(true)
  await w.ah.resume(w.clock.now())
  await w.settle()
  await w.reopen()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, name: 'Al Before' })
  expect(value(w.B.port.stores.contact(w.bId))).toMatchObject({ name: 'Al Before' })
  expect(value(w.B.port.stores.conversation(`c:${w.bId}`)).title).toBe('Al Before')
  // unblocked, the current profile shows again
  expect((await w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId }).done).ok).toBe(true)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, name: 'BLOCKED PROFILE CONTENT' })
})

it('R1-2: a failure between block and pause is completed by recovery', async () => {
  const w = await world()
  capture.failPause = true
  const h = w.block()
  expect(await h.done).toMatchObject({ ok: false })
  await w.settle()
  await w.reopen()
  w.clock.advance(60_000)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
  expect(w.B.port.stores.intents.get().find((x) => x.actId === h.actId)).toBeUndefined()
})

it('R1-2: a failure between unblock and resume is completed by recovery', async () => {
  const w = await world()
  expect((await w.block().done).ok).toBe(true)
  await w.settle()
  capture.failPause = true
  const h = w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId })
  expect(await h.done).toMatchObject({ ok: false })
  await w.reopen()
  w.clock.advance(60_000)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: false } })
})

it('CodeRabbit a: report is not offered for a blocked contact, whose messages are not shown', async () => {
  const w = await world()
  await w.A.port.trust.send(`c:${w.aId}`, 'REPORT THIS INCOMING TEXT', 'report-me').done
  await w.settle()
  expect(value(w.B.port.stores.contact(w.bId))?.actions.report).toEqual({ ok: true })
  expect((await w.block().done).ok).toBe(true)
  await w.settle()
  await w.reopen()
  expect(value(w.B.port.stores.contact(w.bId))?.actions.report).toMatchObject({ ok: false, reason: 'blocked' })
  expect(w.messages()).toEqual([])
})

it('duplicate block gestures share one intent; the later of block and unblock wins (R2-1)', async () => {
  const w = await world()
  const a = w.block()
  const b = w.block()
  expect(a.actId).toBe(b.actId)
  expect((await a.done).ok).toBe(true)
  await w.settle()
  expect((await w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId }).done).ok).toBe(true)
  const blocking = w.block()
  const unblocking = w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId })
  // the earlier gesture either ran before or was superseded by the later one, never after it
  const early = await blocking.done
  expect(early.ok || (!early.ok && early.error.kind === 'refused' && early.error.code === 'superseded')).toBe(true)
  expect((await unblocking.done).ok).toBe(true)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: false } })
})
