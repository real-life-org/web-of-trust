 
// Regressions of Astra's second review of #421 (rltp/design/store-launch-v3/app-review-421-2-2026-10-20.md),
// the probes of the review; where the fix chose the reviewer's alternative, the expectation says so.
// Pure projection of the real adapter: message order by display time, replyTo shown only when the
// earlier message is in the same conversation, nothing of a blocked contact's messages, unread
// counts against the read mark, the composer's availability.
import { expect, it } from 'vitest'
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
  profile: { commitSeq: '9', revision: '1', name: 'Al' } as never, encounters: EMPTY_ENCOUNTERS, lines, intents: [], reads: {}, shown: {}, ...over,
})

const items = (m: ReturnType<typeof project>) => (m.conversations.get('c:bea')?.items ?? []).filter((i): i is MessageItem => i.kind === 'message')


it('R2 probe: a valid reply in the same second survives reverse random mid order',()=>{
 const first=msg('first',T,{mid:'f0000000-0000-4000-8000-000000000000',receivedAt:T})
 const reply=msg('reply',T,{mid:'00000000-0000-4000-8000-000000000000',replyTo:first.mid,receivedAt:T+100})
 const model=project(input([first,reply]))
 expect(items(model).find(m=>m.text==='reply')?.replyTo?.text).toBe('first')
})
