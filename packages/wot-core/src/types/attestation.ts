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
  inResponseTo?: string
  tags?: string[]
  context?: string
  createdAt: string
  /** Canonical wire/storage representation for spec-vNext attestations. */
  vcJws: string
  /**
   * Type-borne live-verification marker (review MAJOR 2 / VE-7). Derived from the
   * verified VC `type` array (`WotVerification` present per Trust 002 / wot-spec
   * #101), NEVER from the human `claim` label. Set wherever the derived
   * `Attestation` is constructed; consumers MUST discriminate on this field, not
   * on the spoofable claim text. Optional for backward compatibility with already
   * stored/derived forms — absent is treated as a non-verification (safe default;
   * a forged claim can never set this to `true`).
   */
  isVerification?: boolean
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
