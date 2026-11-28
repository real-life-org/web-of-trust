// The projection reads every contact id it holds from elsewhere as the entry it stands for now (Trust
// 2140): an alias of an entry (the fresh contact of a second meeting once the continuity mapping chained
// it, 6a.4) leads to the entry everywhere: the ceremony's contact, the conversation (with the lines booked
// under the alias), the details and reportable messages read by the alias, the decisions that name it, and
// acts running on it.
import { describe, expect, it } from 'vitest'
import { project, type ProjectionInput } from '../../src/adapters/rltp/projection'
import type { LogLine, MessageLine } from '../../src/adapters/rltp/app-data'
import { EMPTY_ENCOUNTERS } from '../../src/adapters/rltp/app-data'
import type { MessageItem, Revision } from '../../src/port'

const T = Date.parse('2026-10-15T13:30:00-07:00')

const contact = (id: string, over: Record<string, unknown> = {}) =>
  ({
    commitSeq: '9', id, aliases: [], relationships: [], displayName: 'Bea', provenance: 'ceremony', verification: 'mutual',
    trust: { given: false, received: false, paused: false, pending: false }, classes: {}, blocked: false, canMessage: true, ...over,
  }) as never

const msg = (id: string, at: number, contactId: string): MessageLine => ({
  kind: 'message', id: `msg:in:${id}`, key: `c:${contactId}`, at, dir: 'in', contactId, text: id, mid: `mid-${id}`, replyTo: null,
  sentAt: at, receivedAt: at, digest: null, draftKey: null, held: null, status: null,
})

const connection = (id: string, contactId: string | null) =>
  ({
    id, role: 'responder', status: 'complete', link: { from: 'did:peer:2.x', id, exp: 1, label: 'Bea' }, did: 'did:peer:2.me', theirDid: 'did:peer:2.x', theirPair: 'did:key:z6Mkx',
    name: 'Bea', channel: 'scan', theirChannel: 'displayed', met: true, promptId: null, contactId, theirCredential: {}, myCredential: {}, outbox: [], openedAt: T - 5000, closedAt: T - 1000, carrierNonce: null,
  }) as never

// `bea` is the entry; `bea2` the fresh contact of the second meeting, chained into it
const input = (lines: LogLine[], over: Partial<ProjectionInput> = {}): ProjectionInput => ({
  revision: '1:9:1' as Revision, now: T, timeZone: 'America/Los_Angeles', anchorShort: 'id…', contacts: [contact('bea', { aliases: ['bea2'], sharedConnect: { enactmentId: 'e-1', channel: 'scan', theirChannel: 'displayed', met: true } })], prompts: [],
  profile: { commitSeq: '9', revision: '1', name: 'Al' } as never, encounters: EMPTY_ENCOUNTERS, displayed: {}, lines, intents: [], reads: {}, shown: {},
  connections: [connection('e-1', 'bea'), connection('e-2', 'bea2')], ...over,
})

const texts = (items: readonly unknown[] | undefined) => (items ?? []).filter((i): i is MessageItem => (i as MessageItem).kind === 'message').map((i) => i.text)

describe('rltp projection: an alias reads as its entry', () => {
  it('the ceremony of the second meeting names the entry, recognized; the first is not', () => {
    const m = project(input([]))
    expect(m.connections.map((c) => [c.id, c.contactId, c.recognized])).toEqual([
      ['e-1', 'bea', false],
      ['e-2', 'bea', true],
    ])
  })

  it('one conversation: the lines booked under the alias are in the entry’s, and the alias reads it', () => {
    const m = project(input([msg('first', T, 'bea'), msg('second', T + 1, 'bea2')]))
    expect([...m.conversations.keys()].filter((k) => k.startsWith('c:'))).toEqual(['c:bea', 'c:bea2'])
    const own = m.conversations.get('c:bea')
    expect(texts(own?.items)).toEqual(['first', 'second'])
    expect(m.conversations.get('c:bea2')).toBe(own)
    expect(own).toMatchObject({ key: 'c:bea', title: 'Bea', composer: { ok: true } })
    expect(m.contacts.map((c) => [c.id, c.conversation.unread])).toEqual([['bea', 2]])
    // the author of a line booked under the alias is the entry
    expect(own?.items.find((i) => i.kind === 'message' && i.text === 'second')).toMatchObject({ author: { kind: 'contact', contactId: 'bea' } })
  })

  it('a read mark set in the alias’s conversation counts for the entry’s; the later of two marks holds', () => {
    const lines = [msg('first', T, 'bea'), msg('second', T + 1, 'bea2'), msg('third', T + 2, 'bea')]
    const unread = (reads: ProjectionInput['reads']) => project(input(lines, { reads })).contacts[0]?.conversation.unread
    expect(unread({ 'c:bea2': { at: T + 1, rank: 2, tie: 'mid-second' } })).toBe(1)
    expect(unread({ 'c:bea': { at: T, rank: 2, tie: 'mid-first' }, 'c:bea2': { at: T + 2, rank: 2, tie: 'mid-third' } })).toBe(0)
    expect(unread({ 'c:bea': { at: T + 2, rank: 2, tie: 'mid-third' }, 'c:bea2': { at: T, rank: 2, tie: 'mid-first' } })).toBe(0)
  })

  it('the details and the reportable messages read by the alias are the entry’s', () => {
    const m = project(input([msg('second', T + 1, 'bea2')]))
    expect(m.contactDetails.get('bea2')).toBe(m.contactDetails.get('bea'))
    expect(m.contactDetails.get('bea2')).toMatchObject({ id: 'bea', name: 'Bea' })
    expect(texts(m.reportable.get('bea2'))).toEqual(['second'])
    expect(m.reportable.get('bea2')).toBe(m.reportable.get('bea'))
  })

  it('an act running on the alias runs on the entry: trust in flight, a message being sent in its conversation', () => {
    const intents = [
      { actId: 'a1', command: 'giveTrust', target: 'c:bea2', policy: 'replay', state: 'running', input: { contactId: 'bea2' }, when: T, createdAt: T, attempts: 1 },
      { actId: 'a2', command: 'send', target: 'c:bea2', policy: 'replay', state: 'running', input: { contactId: 'bea2', text: 'typing', draftKey: 'k1' }, when: T + 1, createdAt: T + 1, attempts: 1 },
    ] as never
    const m = project(input([], { intents }))
    expect(m.contactDetails.get('bea')?.actions.giveTrust).toEqual({ ok: false, reason: 'in-flight' })
    expect(texts(m.conversations.get('c:bea')?.items)).toEqual(['typing'])
  })

  // ── review of #571 ──

  it('a counter-step that names its request puts only that one in flight: another request of the person stays open', () => {
    const prompts = [
      { id: 'p-1', kind: 'encounter-confirm', contactId: 'bea', openedAt: T, expiresAt: T + 60_000 },
      { id: 'p-2', kind: 'group-invite', contactId: 'bea', groupName: 'Garten', openedAt: T, expiresAt: T + 60_000 },
    ] as never
    const intents = [{ actId: 'a1', command: 'counterVerify', target: 'c:bea2', policy: 'replay', state: 'running', input: { contactId: 'bea2', promptId: 'p-1' }, when: T, createdAt: T, attempts: 1 }] as never
    const m = project(input([], { prompts, intents }))
    expect(m.decisions.map((d) => [d.id, d.state])).toEqual([
      ['p-1', 'in-flight'],
      ['p-2', 'open'],
    ])
  })

  it('a counter-step without a request, taken for one contact: the requests of another contact stay open (the id is not read as the person)', () => {
    const prompts = [
      { id: 'p-a', kind: 'encounter-confirm', contactId: 'bea', openedAt: T, expiresAt: T + 60_000 },
      { id: 'p-b', kind: 'encounter-confirm', contactId: 'bea2', openedAt: T, expiresAt: T + 60_000 },
    ] as never
    const intents = [{ actId: 'a1', command: 'counterVerify', target: 'c:bea2', policy: 'replay', state: 'running', input: { contactId: 'bea2' }, when: T, createdAt: T, attempts: 1 }] as never
    const m = project(input([], { prompts, intents }))
    expect(m.decisions.map((d) => [d.id, d.state])).toEqual([
      ['p-a', 'open'],
      ['p-b', 'in-flight'],
    ])
  })

  it('an encounter record goes before the ceremony’s end, per contact, as without an alias', () => {
    const encounters = { ...EMPTY_ENCOUNTERS, met: { bea: { metAt: T - 9000, lastMetAt: T - 8000 } } }
    const m = project(input([], { encounters, contacts: [contact('bea', { sharedConnect: { enactmentId: 'e-1', channel: 'scan', theirChannel: 'displayed', met: true } })], connections: [connection('e-1', 'bea')] }))
    expect([m.contactDetails.get('bea')?.metAt, m.contactDetails.get('bea')?.lastMetAt]).toEqual([T - 9000, T - 8000])
  })

  it('a quote stays within its relationship: a mid held only under the other contact gives none', () => {
    const first = msg('first', T, 'bea')
    const answer: MessageLine = { ...msg('answer', T + 1, 'bea2'), replyTo: 'mid-first' }
    const within: MessageLine = { ...msg('within', T + 2, 'bea2'), replyTo: 'mid-answer' }
    const items = (project(input([first, answer, within])).conversations.get('c:bea')?.items ?? []).filter((i): i is MessageItem => i.kind === 'message')
    expect(items.map((i) => [i.text, i.replyTo?.text ?? null])).toEqual([
      ['first', null],
      ['answer', null],
      ['within', 'answer'],
    ])
  })

  it('the ceremonies’ ends are read a bounded number of times, not once per contact and ceremony', () => {
    let reads = 0
    const n = 64
    const connections = Array.from({ length: n }, (_, i) => {
      const v = { ...(connection(`e-${i}`, `c${i}`) as object) }
      Object.defineProperty(v, 'closedAt', { enumerable: true, get: () => (reads++, T - 1000 - i) })
      return v
    }) as never
    const contacts = Array.from({ length: n }, (_, i) => contact(`c${i}`, { sharedConnect: { enactmentId: `e-${i}`, channel: 'scan', theirChannel: 'displayed', met: true } }))
    const m = project(input([], { contacts, connections }))
    expect(m.contactDetails.get('c7')?.metAt).toBe(T - 1007)
    expect(reads).toBeLessThan(n * 8)
  })

  it('a ceremony that failed and whose contact was kept, no encounter record: met at the ceremony’s end, as without any alias', () => {
    const failed = { ...(connection('e-9', null) as object), status: 'failed', closedAt: T - 700 } as never
    const m = project(input([], { contacts: [contact('cem', { sharedConnect: { enactmentId: 'e-9', channel: 'scan', theirChannel: 'displayed', met: true } })], connections: [failed] }))
    expect(m.contactDetails.get('cem')?.metAt).toBe(T - 700)
  })
})
