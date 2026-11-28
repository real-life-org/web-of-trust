import type { ContactDetail, Loadable } from '../../port'

/** What the success of a mutual verification offers (the flow's success and the shell's sheet), from the
 *  contact's details as the port gives them, by the availability the projection computed and nothing of
 *  its own: `close` for a contact of another app (no conversation, no trust yet), `trust` while giving
 *  trust is available, `chat` otherwise (trust given, a blocked contact, …). While the details load, trust
 *  is offered as before. */
export function successOffer(contact: Loadable<ContactDetail | null>): 'close' | 'chat' | 'trust' {
  if (contact.status !== 'ready' || !contact.value) return 'trust'
  if (!contact.value.channel) return 'close'
  return contact.value.actions.giveTrust.ok ? 'trust' : 'chat'
}
