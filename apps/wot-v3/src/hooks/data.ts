// Read-model hooks (architecture §4.1). Each reads exactly one store of the port.
import { useEffect } from 'react'
import type {
  ContactDetail,
  ContactId,
  ContactListItem,
  Conversation,
  ConversationKey,
  Decision,
  GroupListItem,
  Loadable,
} from '../port'
import { usePort } from './context'
import { useStore } from './useStore'

export function useContacts(): Loadable<readonly ContactListItem[]> {
  return useStore(usePort().stores.contacts)
}

export function useContact(id: ContactId): Loadable<ContactDetail | null> {
  return useStore(usePort().stores.contact(id))
}

export function useGroups(): Loadable<readonly GroupListItem[]> {
  return useStore(usePort().stores.groups)
}

export function useDecisions(): Loadable<readonly Decision[]> {
  return useStore(usePort().stores.decisions)
}

/** The conversation, marked read up to the last item it shows. The effect follows the id of that
 *  item: a new item (even with the same timestamp) runs it again, a republish that only changes
 *  read marks does not (no loop). */
export function useConversation(key: ConversationKey): Loadable<Conversation> {
  const port = usePort()
  const value = useStore(port.stores.conversation(key))
  const lastId = value.status === 'ready' ? lastItemId(value.value) : null
  useEffect(() => {
    if (lastId !== null) port.trust.markRead(key, lastId)
  }, [port, key, lastId])
  return value
}

function lastItemId(c: Conversation): string | null {
  for (let i = c.items.length - 1; i >= 0; i--) {
    const item = c.items[i]
    if (item && item.kind !== 'day') return item.id
  }
  return null
}
