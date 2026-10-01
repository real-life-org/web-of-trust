import type { Proof } from './proof'

/**
 * A verification is a signed statement: "I have verified this person"
 *
 * Empfänger-Prinzip: Stored at the recipient (to).
 * Each direction is a separate Verification document.
 *
 * Example: Anna verifies Ben
 * - Anna creates: { from: anna, to: ben, proof: anna_sig }
 * - Stored at: Ben
 */
export interface Verification {
  id: string
  from: string
  to: string
  timestamp: string
  location?: GeoLocation
  proof: Proof
}

export interface GeoLocation {
  latitude: number
  longitude: number
  accuracy?: number
}
