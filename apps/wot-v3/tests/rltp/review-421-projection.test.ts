// Regressions of Astra's first review of #421 (rltp/design/store-launch-v3/app-review-421-1-2026-10-20.md),
// the reproductions of the review kept as written.
// Pure projection of the real adapter: message order by display time, replyTo shown only when the
// earlier message is in the same conversation, nothing of a blocked contact's messages, unread
// counts against the read mark, the composer's availability.
import { expect, it } from 'vitest'
import { project, type ProjectionInput } from '../../src/adapters/rltp/projection'
import { orderKey, type MessageLine } from '../../src/adapters/rltp/app-data'
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


it('read through last displayed message leaves no unread at equal display time', () => {
 const first = msg('z-digest', T, { mid: 'mid-a' })
 const last = msg('a-digest', T, { mid: 'mid-z' })
 const model = project(input([first,last], { reads: { 'c:bea': orderKey(last) } }))
 expect(items(model).map(i=>i.id)).toEqual([first.id,last.id])
 expect(model.contacts[0]?.conversation.unread).toBe(0)
})

import { ingest } from '../../src/adapters/rltp/ingest'
import { EMPTY_LEDGER } from '../../src/adapters/rltp/app-data'
it('an accepted inbox message blocked after acceptance is durably kept before taking it', () => {
 const out = ingest({commitSeq:'9', now:T, events:[], contacts:[contact('bea',{blocked:true,canMessage:false})], prompts:[], encounters:EMPTY_ENCOUNTERS, ledger:EMPTY_LEDGER,
 inbox:[{commitSeq:'9',id:'accepted-before-block', contactId:'bea', blocked:true, mid:'mid-a',text:'already accepted',sentAt:T,receivedAt:T,displayAt:T}],statuses:[]})
 expect(out.take).toEqual(['accepted-before-block'])
 expect(out.lines.filter(l=>l.kind==='message')).toHaveLength(1)
})
