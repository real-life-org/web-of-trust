/**
 * An attestation is a VC-JWS signed statement about someone.
 * Like a gift: the issuer gives, the subject decides to accept/publish.
 *
 * Empfänger-Prinzip: Stored at the recipient (to).
 * Only the issuer (from) signs. The recipient controls visibility via metadata.
 *
 * Example: Anna attests "Ben helped in the garden"
 * - Anna creates a VC-JWS with issuer=anna and subject=ben
 * - Stored at: Ben
 * - Ben decides: accepted = true/false (via AttestationMetadata)
 */
export interface Attestation {
  id: string
  from: string
  to: string
  claim: string
  tags?: string[]
  context?: string
  createdAt: string
  /** Canonical wire/storage representation for spec-vNext attestations. */
  vcJws: string
}

/**
 * Local metadata for attestations (not signed, not synced)
 * Controlled entirely by the recipient
 */
export interface AttestationMetadata {
  attestationId: string
  accepted: boolean
  acceptedAt?: string
}
