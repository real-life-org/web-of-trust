/**
 * Contact status
 * - pending: One-sided verification, waiting for mutual
 * - active: Mutual verification complete
 *
 * Note: "Hidden" contacts are handled via excludedMembers in AutoGroup,
 * not via contact status.
 */
export type ContactStatus = 'pending' | 'active'

/**
 * A contact is a local record of someone you've verified.
 * Stores their public key for E2E encryption.
 */
export interface Contact {
  did: string
  publicKey: string
  name?: string
  avatar?: string
  bio?: string
  status: ContactStatus
  verifiedAt?: string
  /**
   * `updatedAt` des zuletzt übernommenen Profils dieses Kontakts (profile-update
   * per inbox/1.0, wot#386) — ältere oder wiederholte Profile werden verworfen.
   */
  profileUpdatedAt?: string
  createdAt: string
  updatedAt: string
}
