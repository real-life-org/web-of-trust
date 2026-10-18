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

/** The conversation, marked read while it is shown. */
export function useConversation(key: ConversationKey): Loadable<Conversation> {
  const port = usePort()
  const value = useStore(port.stores.conversation(key))
  const lastAt = value.status === 'ready' ? lastItemAt(value.value) : null
  useEffect(() => {
    if (lastAt !== null) port.trust.markRead(key, lastAt)
  }, [port, key, lastAt])
  return value
}

function lastItemAt(c: Conversation): number | null {
  for (let i = c.items.length - 1; i >= 0; i--) {
    const item = c.items[i]
    if (item && item.kind !== 'day') return item.at
  }
  return null
}
