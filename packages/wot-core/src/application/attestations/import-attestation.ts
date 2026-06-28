import type { Attestation } from '../../types/attestation'
import type { AttestationVcPayload, DidResolver, ProtocolCryptoAdapter } from '../../protocol'
import { isVerificationAttestation, verifyAttestationVcJws } from '../../protocol'

export interface ImportAttestationOptions {
  crypto: ProtocolCryptoAdapter
  didResolver?: DidResolver
  now?: Date
}

/**
 * Shared verify-and-derive path for a single compact VC-JWS attestation
 * (Trust 002 / #190 wire form).
 *
 * Single source of truth for `isJwsCompact → verifyAttestationVcJws →
 * attestationFromVcPayload`: both `AttestationWorkflow.importAttestation` and
 * `HttpDiscoveryAdapter` (Sync 004 `/a`+`/v` ListResource resolve, VE-1) consume
 * this so the derivation semantics never drift between the two call sites.
 *
 * Throws `Error('Invalid attestation format')` for non-compact input and
 * `Error('Invalid attestation signature')` for anything that fails verification,
 * mirroring the previous inline behaviour of `importAttestation`.
 */
export async function importAttestationFromVcJws(
  encoded: string,
  options: ImportAttestationOptions,
): Promise<Attestation> {
  return (await importVerifiedAttestationFromVcJws(encoded, options)).attestation
}

export interface VerifiedImportedAttestation {
  attestation: Attestation
  /** The verified VC payload, retained so callers can inspect `type` (VE-2 split). */
  payload: AttestationVcPayload
}

/**
 * Same verify-and-derive path as {@link importAttestationFromVcJws} but also
 * surfaces the verified VC payload. The HTTP discovery resolve path (VE-2)
 * needs the `type` array to enforce the disjoint `/v` ÷ `/a` split lesend,
 * which the derived `Attestation` no longer carries.
 */
export async function importVerifiedAttestationFromVcJws(
  encoded: string,
  options: ImportAttestationOptions,
): Promise<VerifiedImportedAttestation> {
  const trimmed = encoded.trim()
  if (!isJwsCompact(trimmed)) throw new Error('Invalid attestation format')

  let payload: AttestationVcPayload
  try {
    payload = await verifyAttestationVcJws(trimmed, {
      crypto: options.crypto,
      didResolver: options.didResolver,
      now: options.now,
    })
  } catch {
    throw new Error('Invalid attestation signature')
  }
  return { attestation: attestationFromVcPayload(payload, trimmed), payload }
}

export function attestationFromVcPayload(payload: AttestationVcPayload, vcJws: string): Attestation {
  const tags = payload.credentialSubject.tags
  const context = payload.credentialSubject.context
  const id = typeof payload.jti === 'string'
    ? payload.jti
    : typeof payload.id === 'string'
      ? payload.id
      : `wot:attestation:${payload.iss}:${payload.sub}:${payload.nbf}`

  return {
    id,
    from: payload.issuer,
    to: payload.credentialSubject.id,
    claim: payload.credentialSubject.claim,
    ...(typeof payload.inResponseTo === 'string' ? { inResponseTo: payload.inResponseTo } : {}),
    ...(Array.isArray(tags) && tags.every(tag => typeof tag === 'string') ? { tags } : {}),
    ...(typeof context === 'string' ? { context } : {}),
    createdAt: payload.validFrom,
    vcJws,
    // Type-borne marker (review MAJOR 2): derived from the verified VC `type`
    // array, never from the claim label.
    isVerification: isVerificationAttestation(payload),
  }
}

function isJwsCompact(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
}
