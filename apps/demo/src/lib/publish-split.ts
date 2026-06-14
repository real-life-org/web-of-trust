import type { Attestation } from '@web_of_trust/core/types'
import type { DidResolver, ProtocolCryptoAdapter } from '@web_of_trust/core/protocol'
import { isVerificationAttestation as isVerificationAttestationPayload } from '@web_of_trust/core/protocol'
import { importVerifiedAttestationFromVcJws } from '@web_of_trust/core/application'

/**
 * Disjoint publish-split of accepted attestations into the `/v` and `/a`
 * resources (Sync 004 Z.24-32, VE-2/VE-7).
 *
 * The split discriminator is the canonical `WotVerification` `type` marker on
 * the VERIFIED VC payload — NOT the human-readable `claim` label
 * (`'in-person verifiziert'`). For each accepted attestation we re-verify its
 * `attestation.vcJws` and ask the protocol's type-based predicate
 * `isVerificationAttestation(payload)`. This makes the demo's publish-split
 * match the HttpDiscoveryAdapter's disjoint resolve filter exactly: a
 * verification published to `/v` resolves back from `/v` and never appears in
 * `/a` (and vice versa).
 *
 * An attestation whose `vcJws` does not verify (e.g. legacy unsigned data) is
 * dropped from BOTH lists — only verifiable VCs are republished, which is what
 * the resolve path will accept anyway.
 */
export interface SplitAcceptedAttestationsOptions {
  crypto: ProtocolCryptoAdapter
  didResolver?: DidResolver
  now?: Date
}

export interface SplitAcceptedAttestationsResult {
  /** Accepted attestations whose VC payload carries the `WotVerification` type. */
  verifications: Attestation[]
  /** Accepted attestations whose VC payload does NOT carry it. */
  attestations: Attestation[]
}

export async function splitAcceptedAttestations(
  accepted: readonly Attestation[],
  options: SplitAcceptedAttestationsOptions,
): Promise<SplitAcceptedAttestationsResult> {
  const verifications: Attestation[] = []
  const attestations: Attestation[] = []

  for (const attestation of accepted) {
    if (!attestation.vcJws) continue
    let isVerification: boolean
    try {
      const { payload } = await importVerifiedAttestationFromVcJws(attestation.vcJws, {
        crypto: options.crypto,
        ...(options.didResolver ? { didResolver: options.didResolver } : {}),
        ...(options.now ? { now: options.now } : {}),
      })
      isVerification = isVerificationAttestationPayload(payload)
    } catch {
      // Unverifiable VC — drop from both lists (the resolve path would reject it
      // anyway). Never re-publish something a consumer cannot re-derive.
      continue
    }
    if (isVerification) verifications.push(attestation)
    else attestations.push(attestation)
  }

  return { verifications, attestations }
}
