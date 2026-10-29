// @vitest-environment node
// Review 422 round 2 (gpt-6.1-sol): a newer block or unblock supersedes an older open one, whose late
// recovery never undoes it (R2-1); a block interrupted before its first library act is completed (R2-2);
// a blocked profile stays hidden without a ledger entry, under a new id, with or without an image.
import { afterEach, expect, it, vi } from 'vitest'
import { secret, type ContactId, type Loadable, type ReadStore } from '../../src/port'
import { ingest } from '../../src/adapters/rltp/ingest'
import { project, type ProjectionInput } from '../../src/adapters/rltp/projection'
import { EMPTY_ENCOUNTERS, EMPTY_LEDGER } from '../../src/adapters/rltp/app-data'
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

it('R2-1a: older block recovery does not pause after a newer successful unblock', async () => {
  const w = await world()
  capture.failPause = true
  const old = w.block()
  expect(await old.done).toMatchObject({ ok: false })
  expect((await w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId }).done).ok).toBe(true)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: false } })
  await w.B.port.session()!.retryIntent(old.actId).done
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: false } })
})

it('R2-1b: older unblock recovery does not resume after a newer successful block', async () => {
  const w = await world()
  expect((await w.block().done).ok).toBe(true)
  capture.failPause = true
  const old = w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId })
  expect(await old.done).toMatchObject({ ok: false })
  expect((await w.block().done).ok).toBe(true)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
  await w.reopen()
  w.clock.advance(60_000)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
})

it('R2-2: block interrupted before first library call recovers the journaled user intent', async () => {
  const w = await world()
  w.B.faults.killAt = 'after-journal'
  const old = w.block()
  expect(await old.done).toMatchObject({ ok: false })
  await w.reopen()
  w.clock.advance(60_000)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
})

it('R1-1: missing ledger, new IDs and null images do not expose a blocked profile', () => {
  const raw = { commitSeq: '9', id: 'blocked-new-id', aliases: ['old-id'], relationships: [],
    provenance: 'introduced', via: 'third-party', verification: 'mutual',
    displayName: 'HIDDEN-BLOCKED-NAME', profile: { revision: '2', name: 'HIDDEN-BLOCKED-NAME', image: 'HIDDEN-BLOCKED-IMAGE' },
    trust: { given: false, received: false, paused: true, pending: false }, classes: {}, blocked: true, canMessage: false } as never
  for (const shown of [undefined, { name: 'Before', image: null }, { name: 'Before', image: 'before-image' }]) {
    const ledger = shown ? { contacts: { 'blocked-new-id': { verification: 'mutual', given: false, received: false, blocked: true, ...shown } }, prompts: {} } : EMPTY_LEDGER
    const out = ingest({ commitSeq: '9', now: 1_000, events: [], contacts: [raw], prompts: [], encounters: EMPTY_ENCOUNTERS, ledger, inbox: [], statuses: [] })
    const input: ProjectionInput = { revision: '1:9:1' as never, now: 1_000, timeZone: 'UTC', anchorShort: 'self', contacts: [raw], prompts: [],
      profile: { commitSeq: '9', revision: '1', name: 'Self' } as never,
      encounters: EMPTY_ENCOUNTERS, displayed: {}, lines: out.lines, intents: [], reads: {}, shown: out.ledger.contacts }
    const m = project(input)
    expect(m.contacts[0]).toMatchObject({ name: shown?.name ?? null, image: shown?.image ?? null })
    expect(m.conversations.get('c:blocked-new-id')?.title).toBe(shown?.name ?? null)
    expect(m.blocked[0]?.label).toBe(shown?.name ?? '')
    expect(JSON.stringify([m.contacts, [...m.contactDetails], [...m.conversations], m.blocked, m.visibility])).not.toContain('HIDDEN-BLOCKED')
  }
})
