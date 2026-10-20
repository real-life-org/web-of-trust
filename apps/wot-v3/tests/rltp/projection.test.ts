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
  profile: { commitSeq: '9', revision: '1', name: 'Al' } as never, encounters: EMPTY_ENCOUNTERS, lines, intents: [], reads: {}, ...over,
})

const items = (m: ReturnType<typeof project>) => (m.conversations.get('c:bea')?.items ?? []).filter((i): i is MessageItem => i.kind === 'message')

describe('rltp projection: messages', () => {
  it('orders by display time, then mid', () => {
    const m = project(input([msg('c', T + 2), msg('b', T + 1, { mid: 'mid-z' }), msg('a', T + 1, { mid: 'mid-a' })]))
    expect(items(m).map((i) => i.text)).toEqual(['a', 'b', 'c'])
  })

  it('replyTo: a quote only for an earlier message of this conversation', () => {
    const m = project(input([msg('first', T), msg('answer', T + 1, { replyTo: 'mid-first' }), msg('dangling', T + 2, { replyTo: 'mid-unknown' }), msg('future', T + 3, { replyTo: 'mid-later' }), msg('later', T + 4)]))
    const byText = new Map(items(m).map((i) => [i.text, i]))
    expect(byText.get('answer')?.replyTo).toMatchObject({ text: 'first', author: { kind: 'contact' } })
    expect(byText.get('dangling')?.replyTo).toBeUndefined()
    expect(byText.get('future')?.replyTo).toBeUndefined()
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
