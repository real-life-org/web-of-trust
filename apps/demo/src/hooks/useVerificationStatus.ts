import { useMemo } from 'react'
import type { Verification } from '@web.of.trust/core'
import { useAdapters } from '../context'
import { useIdentity } from '../context'
import { useSubscribable } from './useSubscribable'

export type VerificationDirection = 'mutual' | 'incoming' | 'outgoing' | 'none'

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
  verifications: Verification[],
): VerificationDirection {
  let incoming = false
  let outgoing = false

  for (const v of verifications) {
    if (v.from === contactDid && v.to === myDid) incoming = true
    if (v.from === myDid && v.to === contactDid) outgoing = true
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

  const allVerificationsSubscribable = useMemo(
    () => reactiveStorage.watchAllVerifications(),
    [reactiveStorage],
  )
  const allVerifications = useSubscribable(allVerificationsSubscribable)

  const getStatus = useMemo(() => {
    if (!did) return (_contactDid: string) => 'none' as VerificationDirection
    return (contactDid: string) => getVerificationStatus(did, contactDid, allVerifications)
  }, [did, allVerifications])

  return { getStatus, allVerifications }
}
