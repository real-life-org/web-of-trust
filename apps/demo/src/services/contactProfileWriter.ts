import type { Contact } from '@web_of_trust/core/types'
import { isRfc3339DateTime } from '@web_of_trust/core/protocol'

export interface ContactProfileStorage {
  getContact(did: string): Promise<Contact | null>
  updateContact(contact: Contact): Promise<void>
}

/** Ein vollständiges Profil eines Kontakts — aus der Inbox (profile-update) oder vom Profil-Dienst. */
export interface IncomingContactProfile {
  name: string
  bio?: string
  avatar?: string
  offers?: string[]
  needs?: string[]
  /** Zeitpunkt der Profiländerung beim Kontakt (RFC 3339 mit Zeitzone). */
  updatedAt?: string
}

/**
 * Prozessweite Kette je Kontakt-DID: ALLE Schreiber eines Kontaktprofils
 * (Inbox-Listener, Discovery-Abgleich) laufen hier hintereinander durch.
 */
const chains = new Map<string, Promise<unknown>>()

/**
 * Die einzige Stelle, die ein Kontaktprofil schreibt (Review #390).
 *
 * - Liest den Kontakt erst INNERHALB der Kette — nie ein Snapshot von vor
 *   einem Netzwerkabruf.
 * - Übernimmt nur Neueres: hat der Kontakt eine Zeitmarke, muss das Profil
 *   eine gültige, spätere tragen; ohne gültige Zeitmarke ersetzt nichts eine
 *   vorhandene.
 * - Volles Profil: fehlende Felder werden entfernt.
 *
 * Liefert `true`, wenn geschrieben wurde. Ein unbekannter Kontakt wird nicht angelegt.
 */
export function applyContactProfile(
  storage: ContactProfileStorage,
  did: string,
  profile: IncomingContactProfile,
  options: { now?: () => Date } = {},
): Promise<boolean> {
  const previous = chains.get(did) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => write(storage, did, profile, options.now ?? (() => new Date())))
  chains.set(did, current)
  void current.finally(() => {
    if (chains.get(did) === current) chains.delete(did)
  }).catch(() => {})
  return current
}

async function write(
  storage: ContactProfileStorage,
  did: string,
  profile: IncomingContactProfile,
  now: () => Date,
): Promise<boolean> {
  const contact = await storage.getContact(did)
  if (!contact) return false

  const updatedAt = isRfc3339DateTime(profile.updatedAt) ? profile.updatedAt : undefined
  if (contact.profileUpdatedAt) {
    if (!updatedAt || Date.parse(updatedAt) <= Date.parse(contact.profileUpdatedAt)) return false
  }

  const next: Contact = { ...contact }
  delete next.bio
  delete next.avatar
  delete next.offers
  delete next.needs
  delete next.profileUpdatedAt
  await storage.updateContact({
    ...next,
    name: profile.name,
    ...(profile.bio ? { bio: profile.bio } : {}),
    ...(profile.avatar ? { avatar: profile.avatar } : {}),
    ...(profile.offers?.length ? { offers: [...profile.offers] } : {}),
    ...(profile.needs?.length ? { needs: [...profile.needs] } : {}),
    ...(updatedAt ? { profileUpdatedAt: updatedAt } : {}),
    updatedAt: now().toISOString(),
  })
  return true
}
