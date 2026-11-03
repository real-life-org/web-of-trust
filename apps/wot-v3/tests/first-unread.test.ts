// The first unread message of a thread (screens/chat/first-unread.ts): both adapters count unread as
// the incoming messages after the read mark (sim unreadOf, rltp projection), so the first unread is the
// n-th incoming message counted from the end.
import { describe, expect, it } from 'vitest'
import type { ConversationItem } from '../src/port'
import { firstUnreadId } from '../src/screens/chat/first-unread'

const msg = (id: string, self: boolean): ConversationItem =>
  ({ kind: 'message', id, text: id, at: 0, author: self ? { kind: 'self' } : { kind: 'contact', contactId: 'x', name: 'X' }, delivery: null, replyTo: null }) as unknown as ConversationItem
const day = (id: string): ConversationItem => ({ kind: 'day', id, day: '2026-10-15' }) as ConversationItem
const sys = (id: string): ConversationItem => ({ kind: 'system', id, system: 'mutual', at: 0, basis: 'own-act' }) as unknown as ConversationItem

describe('firstUnreadId', () => {
  const items = [day('d1'), sys('s1'), msg('a', false), msg('b', true), msg('c', false), day('d2'), msg('d', true), msg('e', false), msg('f', false)]

  it('is the n-th incoming message from the end, own messages and other items between them do not count', () => {
    expect(firstUnreadId(items, 1)).toBe('f')
    expect(firstUnreadId(items, 2)).toBe('e')
    expect(firstUnreadId(items, 3)).toBe('c')
    expect(firstUnreadId(items, 4)).toBe('a')
  })

  it('is null without unread messages, or when the count exceeds the incoming messages shown', () => {
    expect(firstUnreadId(items, 0)).toBeNull()
    expect(firstUnreadId(items, 5)).toBeNull()
    expect(firstUnreadId([], 1)).toBeNull()
  })
})
