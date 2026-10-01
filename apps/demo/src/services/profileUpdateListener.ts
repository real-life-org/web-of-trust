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
  // Lesen, Vergleichen und Schreiben laufen je Absender hintereinander: der
  // Transport startet Callbacks parallel, und zwei Updates desselben Kontakts
  // dürfen nicht denselben alten Stand lesen (sonst überschreibt das ältere,
  // wenn es zuletzt schreibt, das neuere — Review #390).
  const chains = new Map<string, Promise<void>>()
  return (update) => {
    const previous = chains.get(update.senderDid) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => apply(update))
    chains.set(update.senderDid, current)
    void current.finally(() => {
      if (chains.get(update.senderDid) === current) chains.delete(update.senderDid)
    }).catch(() => {})
    return current
  }

  async function apply({ profile, senderDid }: Parameters<ProfileUpdateListener>[0]): Promise<void> {
    const contact = await deps.storage.getContact(senderDid)
    if (!contact) return
    if (contact.profileUpdatedAt && Date.parse(profile.updatedAt) <= Date.parse(contact.profileUpdatedAt)) return

    const next: Contact = { ...contact }
    delete next.bio
    delete next.avatar
    delete next.offers
    delete next.needs
    await deps.storage.updateContact({
      ...next,
      name: profile.name,
      ...(profile.bio ? { bio: profile.bio } : {}),
      ...(profile.avatar ? { avatar: profile.avatar } : {}),
      ...(profile.offers?.length ? { offers: [...profile.offers] } : {}),
      ...(profile.needs?.length ? { needs: [...profile.needs] } : {}),
      profileUpdatedAt: profile.updatedAt,
      updatedAt: now().toISOString(),
    })
  }
}
