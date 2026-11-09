// Pure projection of the real adapter: message order by display time, replyTo shown only when the
// earlier message is in the same conversation, nothing of a blocked contact's messages, unread
// counts against the read mark, the composer's availability.
import { describe, expect, it } from 'vitest'
import { project, type ProjectionInput } from '../../src/adapters/rltp/projection'
import type { MessageLine } from '../../src/adapters/rltp/app-data'
import { EMPTY_ENCOUNTERS } from '../../src/adapters/rltp/app-data'
import type { MessageItem, Revision } from '../../src/port'

const T = Date.parse('2026-10-15T13:30:00-07:00')

const contact = (id: string, over: Record<string, unknown> = {}) =>
  ({
    commitSeq: '9', id, aliases: [], relationships: [], displayName: id.toUpperCase(), provenance: 'ceremony', verification: 'mutual',
    trust: { given: false, received: false, paused: false, pending: false }, classes: {}, blocked: false, canMessage: true, ...over,
  }) as never

const msg = (id: string, at: number, over: Partial<MessageLine> = {}): MessageLine => ({
  kind: 'message', id: `msg:in:${id}`, key: 'c:bea', at, dir: 'in', contactId: 'bea', text: id, mid: `mid-${id}`, replyTo: null,
  sentAt: at, receivedAt: at, digest: null, draftKey: null, held: null, status: null, ...over,
})

const input = (lines: MessageLine[], over: Partial<ProjectionInput> = {}): ProjectionInput => ({
  revision: '1:9:1' as Revision, now: T, timeZone: 'America/Los_Angeles', anchorShort: 'id…', contacts: [contact('bea')], prompts: [],
  profile: { commitSeq: '9', revision: '1', name: 'Al' } as never, encounters: EMPTY_ENCOUNTERS, displayed: {}, lines, intents: [], reads: {}, shown: {}, ...over,
})

const items = (m: ReturnType<typeof project>) => (m.conversations.get('c:bea')?.items ?? []).filter((i): i is MessageItem => i.kind === 'message')

describe('rltp projection: messages', () => {
  it('orders by display time, then mid', () => {
    const m = project(input([msg('c', T + 2), msg('b', T + 1, { mid: 'mid-z' }), msg('a', T + 1, { mid: 'mid-a' })]))
    expect(items(m).map((i) => i.text)).toEqual(['a', 'b', 'c'])
  })

  it('replyTo: a quote only for a message of this conversation the app holds (any display order)', () => {
    const m = project(input([msg('first', T), msg('answer', T + 1, { replyTo: 'mid-first' }), msg('dangling', T + 2, { replyTo: 'mid-unknown' }), msg('future', T + 3, { replyTo: 'mid-later' }), msg('later', T + 4)]))
    const byText = new Map(items(m).map((i) => [i.text, i]))
    expect(byText.get('answer')?.replyTo).toMatchObject({ text: 'first', author: { kind: 'contact' } })
    expect(byText.get('dangling')?.replyTo).toBeUndefined()
    // display order is not causality: a same-relationship reference shows even if it sorts later
    expect(byText.get('future')?.replyTo).toMatchObject({ text: 'later' })
  })

  it('unread counts received messages after the read mark', () => {
    const lines = [msg('a', T), msg('b', T + 1), msg('own', T + 2, { dir: 'out', id: 'msg:out:d1', mid: 'm-own', digest: 'x' })]
    expect(project(input(lines)).contacts[0]?.conversation.unread).toBe(2)
    expect(project(input(lines, { reads: { 'c:bea': { at: T, rank: 2, tie: 'mid-a' } } })).contacts[0]?.conversation.unread).toBe(1)
  })

  it('a blocked contact: its messages are not shown, the composer is closed', () => {
    const m = project(input([msg('a', T), msg('own', T + 1, { dir: 'out', id: 'msg:out:d1', mid: 'm-own', digest: 'x' })], { contacts: [contact('bea', { blocked: true, canMessage: false })] }))
    expect(items(m).map((i) => i.text)).toEqual(['own'])
    expect(m.conversations.get('c:bea')?.composer).toEqual({ ok: false, reason: 'blocked' })
  })

  it('an own message held unsent shows held; a running send shows committing from the journal', () => {
    const held = msg('h', T, { dir: 'out', id: 'msg:out:h', mid: null, held: 'not-ready', status: { phase: 'held', reason: 'not-ready' } })
    const intent = { actId: 'a1', command: 'send', target: 'c:bea', policy: 'replay', state: 'running', input: { contactId: 'bea', text: 'typing', draftKey: 'k2' }, when: T + 1, createdAt: T + 1, attempts: 1 } as never
    const m = project(input([held], { intents: [intent] }))
    expect(items(m).map((i) => [i.text, i.delivery])).toEqual([
      ['h', { phase: 'held', reason: 'not-ready' }],
      ['typing', { phase: 'committing' }],
    ])
  })
})

describe('rltp projection: contacts of the connection ceremony', () => {
  const connection = (id: string, over: Record<string, unknown> = {}) =>
    ({
      id, role: 'inviter', status: 'complete', link: { from: 'did:peer:2.x', id, exp: 1, label: null }, did: 'did:peer:2.me', theirDid: 'did:peer:2.x', theirPair: 'did:key:z6Mkx',
      name: 'Day', channel: 'displayed', theirChannel: 'scan', met: true, promptId: null, contactId: null, theirCredential: {}, myCredential: {}, outbox: [], openedAt: T - 5000, closedAt: T - 1000, carrierNonce: null, ...over,
    }) as never

  it('a contact connected over a link reads as link and gets no trust; one that met reads as the core says, with the ceremony’s end as the meeting', () => {
    const m = project(input([], {
      contacts: [contact('bea', { sharedConnect: { enactmentId: 'e-1', channel: 'displayed', theirChannel: 'link', met: false } }), contact('cem', { sharedConnect: { enactmentId: 'e-2', channel: 'displayed', theirChannel: 'scan', met: true } })],
      connections: [connection('e-1', { contactId: 'bea', met: false, theirChannel: 'link' }), connection('e-2', { contactId: 'cem', closedAt: T - 42 })],
    }))
    const bea = m.contactDetails.get('bea')
    expect(bea).toMatchObject({ verification: 'link', channel: true, actions: { giveTrust: { ok: false, reason: 'not-verified' } } })
    // without a profile the contact bears the name its code or proposal stated
    const m2 = project(input([], {
      contacts: [contact('dan', { displayName: undefined, sharedConnect: { enactmentId: 'e-9', channel: 'scan', theirChannel: 'displayed', met: true } })],
      connections: [connection('e-9', { contactId: 'dan', name: 'Dan Stated' })],
    }))
    expect(m2.contacts.find((c) => c.id === 'dan')?.name).toBe('Dan Stated')
    expect(m2.conversations.get('c:dan')?.title).toBe('Dan Stated')
    const cem = m.contactDetails.get('cem')
    expect(cem).toMatchObject({ verification: 'mutual', channel: true, metAt: T - 42, actions: { giveTrust: { ok: true } } })
  })

  it('a complete ceremony whose counterpart gave no card (another app) is a contact without a channel: listed with its class, no conversation, no trust', () => {
    const m = project(input([], { connections: [connection('e-3'), connection('e-4', { met: false, theirChannel: null, name: 'Kay', status: 'complete' }), connection('e-5', { status: 'declined' })] }))
    const ids = m.contacts.map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['connect:e-3', 'connect:e-4']))
    expect(ids).not.toContain('connect:e-5')
    expect(m.contacts.find((c) => c.id === 'connect:e-3')).toMatchObject({ name: 'Day', verification: 'mutual', channel: false, conversation: { lastActivityAt: T - 1000 } })
    expect(m.contactDetails.get('connect:e-4')).toMatchObject({ name: 'Kay', verification: 'link', channel: false, metAt: T - 1000, actions: { giveTrust: { ok: false, reason: 'not-verified' }, block: { ok: false, reason: 'not-supported' } } })
    expect(m.contactDetails.get('connect:e-3')?.actions.giveTrust).toEqual({ ok: false, reason: 'not-supported' })
    expect(m.conversations.has('c:connect:e-3')).toBe(false)
    // the ceremony names the contact it stands for
    expect(m.connections.find((c) => c.id === 'e-3')?.contactId).toBe('connect:e-3')
    expect(m.connections.find((c) => c.id === 'e-5')?.contactId).toBeNull()
  })
})
