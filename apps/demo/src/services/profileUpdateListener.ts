import { applyContactProfile, type ContactProfileStorage, type ProfileUpdateListener } from '@web_of_trust/core/application'

export interface ProfileUpdateListenerDeps {
  storage: ContactProfileStorage
  now?: () => Date
}

/**
 * Übernimmt die Profiländerung eines Kontakts (wot#386, `inbox/1.0`-Body
 * `{ kind:'profile-update', profile }`).
 *
 * Geschrieben wird über {@link applyContactProfile} — dieselbe je Kontakt
 * serialisierte Stelle wie der Discovery-Abgleich (Review #390): nur bekannte
 * Kontakte, nur Neueres, volles Profil (fehlende Felder werden entfernt).
 *
 * Alle Ausgänge sind deterministisch und lösen auf (Host: applied → ack);
 * nur ein Speicherfehler wirft (Host: kein ack, Redelivery).
 */
export function createProfileUpdateListener(deps: ProfileUpdateListenerDeps): ProfileUpdateListener {
  return async ({ profile, senderDid }) => {
    await applyContactProfile(deps.storage, senderDid, profile, deps.now ? { now: deps.now } : {})
  }
}
