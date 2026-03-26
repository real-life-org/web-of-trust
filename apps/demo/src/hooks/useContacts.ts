import { useCallback, useMemo } from 'react'
import { useAdapters } from '../context'
import { useSubscribable } from './useSubscribable'
import type { ContactStatus } from '@web.of.trust/core'

export function useContacts() {
  const { contactService, reactiveStorage } = useAdapters()

  const contactsSubscribable = useMemo(() => reactiveStorage.watchContacts(), [reactiveStorage])
  const contacts = useSubscribable(contactsSubscribable)

  const addContact = useCallback(
    async (did: string, publicKey: string, name?: string, status: ContactStatus = 'pending') => {
      return contactService.addContact(did, publicKey, name, status)
    },
    [contactService]
  )

  const activateContact = useCallback(
    async (did: string) => {
      await contactService.activateContact(did)
    },
    [contactService]
  )

  const updateContactName = useCallback(
    async (did: string, name: string) => {
      await contactService.updateContactName(did, name)
    },
    [contactService]
  )

  const removeContact = useCallback(
    async (did: string) => {
      await contactService.removeContact(did)
    },
    [contactService]
  )

  const activeContacts = useMemo(() => contacts.filter(c => c.status === 'active'), [contacts])
  const pendingContacts = useMemo(() => contacts.filter(c => c.status === 'pending'), [contacts])

  return {
    contacts,
    activeContacts,
    pendingContacts,
    isLoading: false,
    error: null,
    addContact,
    activateContact,
    updateContactName,
    removeContact,
    refresh: () => {},
  }
}
