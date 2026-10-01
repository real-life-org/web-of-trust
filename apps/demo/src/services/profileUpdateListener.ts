import type { Contact } from '@web_of_trust/core/types'
import type { ProfileUpdateListener } from './InboxReceptionHost'

export interface ProfileUpdateListenerDeps {
  storage: {
    getContact(did: string): Promise<Contact | null>
    updateContact(contact: Contact): Promise<void>
  }
  now?: () => Date
}

/**
 * Übernimmt die Profiländerung eines Kontakts (wot#386, `inbox/1.0`-Body
 * `{ kind:'profile-update', profile }`).
 *
 * - Nur von bekannten Kontakten: ein Fremder kann sich so keinen Eintrag anlegen.
 * - Nur Neueres: `profile.updatedAt` muss nach dem zuletzt übernommenen Stand
 *   liegen; ältere oder wiederholte Zustellungen ändern nichts.
 * - Die Nachricht trägt das ganze Profil: fehlt ein Feld, hat der Absender es
 *   entfernt, also wird es auch hier entfernt.
 *
 * Alle Ausgänge sind deterministisch und lösen auf (Host: applied → ack);
 * nur ein Speicherfehler wirft (Host: kein ack, Redelivery).
 */
export function createProfileUpdateListener(deps: ProfileUpdateListenerDeps): ProfileUpdateListener {
  const now = deps.now ?? (() => new Date())
  return async ({ profile, senderDid }) => {
    const contact = await deps.storage.getContact(senderDid)
    if (!contact) return
    if (contact.profileUpdatedAt && Date.parse(profile.updatedAt) <= Date.parse(contact.profileUpdatedAt)) return

    const next: Contact = { ...contact }
    delete next.bio
    delete next.avatar
    await deps.storage.updateContact({
      ...next,
      name: profile.name,
      ...(profile.bio ? { bio: profile.bio } : {}),
      ...(profile.avatar ? { avatar: profile.avatar } : {}),
      profileUpdatedAt: profile.updatedAt,
      updatedAt: now().toISOString(),
    })
  }
}
