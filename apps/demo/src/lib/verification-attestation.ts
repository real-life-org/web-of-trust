import type { Attestation } from '@web_of_trust/core/types'

/**
 * Display label of a live verification-attestation. Single source of truth for
 * the demo's UI-facing string (VE-7: the literal is an ANZEIGE-Label only,
 * never a discriminator).
 */
export const VERIFICATION_ATTESTATION_CLAIM = 'in-person verifiziert'

/**
 * Derived-form predicate (VE-7, review MAJOR 2). The derived `Attestation` now
 * carries the type-borne `isVerification` marker, set at every construction path
 * from the verified VC `type` array (`WotVerification` per Trust 002 /
 * wot-spec #101) — NOT from the spoofable `claim` text. A forged attestation
 * whose `claim` is exactly the display label but whose VC `type` lacks
 * WotVerification can never set this flag, so it is correctly classified as a
 * non-verification (no fake trust badge).
 *
 * The `claim` literal is now display-only (Gate-f): it is never a discriminator.
 *
 * Dependency-free on purpose (no React hooks) so composition-root code like
 * AdapterContext can reuse it without importing a hook module.
 */
export function isVerificationAttestation(attestation: Attestation): boolean {
  return attestation.isVerification === true
}
