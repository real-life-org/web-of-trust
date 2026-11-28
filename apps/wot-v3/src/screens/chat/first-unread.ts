import type { ContactListItem, ConversationItem, ConversationSummary } from '../../port'

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

/** The list's summary of the conversation `key`: its contact's, found by the contact's id or by one of its
 *  aliases (a conversation opened under an id that was joined into the contact since). */
export function summaryOfKey(contacts: readonly ContactListItem[], key: string): ConversationSummary | undefined {
  return contacts.find((c) => `c:${c.id}` === key || c.aliases.some((a) => `c:${a}` === key))?.conversation
}
