import type { ConversationItem } from '../../port'

/** The first unread message of a thread. Both adapters count unread as the incoming messages after the
 *  read mark (sim unreadOf, rltp projection), so it is the `unread`-th incoming message from the end;
 *  null without unread messages, or when the count exceeds the incoming messages shown (then the thread
 *  opens at the bottom). */
export function firstUnreadId(items: readonly ConversationItem[], unread: number): string | null {
  if (unread <= 0) return null
  let seen = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind === 'message' && item.author.kind !== 'self' && ++seen === unread) return item.id
  }
  return null
}
