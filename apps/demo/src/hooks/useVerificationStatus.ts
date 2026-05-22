import { useMemo } from 'react'
import type { Attestation } from '@web_of_trust/core/types'
import { useAdapters } from '../context'
import { useIdentity } from '../context'
import { useSubscribable } from './useSubscribable'

export type VerificationDirection = 'mutual' | 'incoming' | 'outgoing' | 'none'

const VERIFICATION_ATTESTATION_CLAIM = 'in-person verifiziert'

type AttestationVerificationCandidate = Omit<Attestation, 'vcJws'> & { vcJws?: string }

export function isVerificationAttestation(attestation: AttestationVerificationCandidate): boolean {
  return attestation.claim === VERIFICATION_ATTESTATION_CLAIM && Boolean(attestation.vcJws)
}

/**
 * Compute verification status for a specific contact.
 *
 * - mutual:   I verified them AND they verified me
 * - incoming: They verified me (from=them, to=me)
 * - outgoing: I verified them (from=me, to=them)
 * - none:     No verification exists
 */
export function getVerificationStatus(
  myDid: string,
  contactDid: string,
  attestations: readonly AttestationVerificationCandidate[],
): VerificationDirection {
  let incoming = false
  let outgoing = false

  for (const attestation of attestations) {
    if (!isVerificationAttestation(attestation)) continue
    if (attestation.from === contactDid && attestation.to === myDid) incoming = true
    if (attestation.from === myDid && attestation.to === contactDid) outgoing = true
    if (incoming && outgoing) return 'mutual'
  }

  if (incoming) return 'incoming'
  if (outgoing) return 'outgoing'
  return 'none'
}

/**
 * Hook: reactive verification status for all contacts.
 * Returns a lookup function contactDid → VerificationDirection.
 */
export function useVerificationStatus() {
  const { reactiveStorage } = useAdapters()
  const { did } = useIdentity()

  const allAttestationsSubscribable = useMemo(
    () => reactiveStorage.watchAllAttestations(),
    [reactiveStorage],
  )
  const allAttestations = useSubscribable(allAttestationsSubscribable)

  const getStatus = useMemo(() => {
    if (!did) return (_contactDid: string) => 'none' as VerificationDirection
    return (contactDid: string) => getVerificationStatus(did, contactDid, allAttestations)
  }, [did, allAttestations])

  return { getStatus, allAttestations }
}
