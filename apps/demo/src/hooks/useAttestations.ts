import { useCallback, useMemo } from 'react'
import { useAdapters, useIdentity } from '../context'
import { useSubscribable } from './useSubscribable'
import type { Attestation } from '@real-life/wot-core'

export function useAttestations() {
  const { attestationService, reactiveStorage } = useAdapters()
  const { identity: wotIdentity, did } = useIdentity()

  const attestationsSubscribable = useMemo(() => reactiveStorage.watchAllAttestations(), [reactiveStorage])
  const attestations = useSubscribable(attestationsSubscribable)

  const createAttestation = useCallback(
    async (toDid: string, claim: string, tags?: string[]) => {
      if (!wotIdentity || !did) {
        throw new Error('No identity found')
      }
      return attestationService.createAttestation(
        did,
        toDid,
        claim,
        (data) => wotIdentity.sign(data),
        tags
      )
    },
    [wotIdentity, did, attestationService]
  )

  const verifyAttestation = useCallback(
    async (attestation: Attestation) => {
      return attestationService.verifyAttestation(attestation)
    },
    [attestationService]
  )

  const importAttestation = useCallback(
    async (encoded: string) => {
      return attestationService.importAttestation(encoded)
    },
    [attestationService]
  )

  const setAttestationAccepted = useCallback(
    async (attestationId: string, accepted: boolean) => {
      await attestationService.setAttestationAccepted(attestationId, accepted)
    },
    [attestationService]
  )

  const myAttestations = useMemo(
    () => did ? attestations.filter(a => a.from === did) : [],
    [attestations, did]
  )

  const receivedAttestations = useMemo(
    () => did ? attestations.filter(a => a.to === did) : [],
    [attestations, did]
  )

  return {
    attestations,
    myAttestations,
    receivedAttestations,
    isLoading: false,
    error: null,
    createAttestation,
    importAttestation,
    verifyAttestation,
    setAttestationAccepted,
    refresh: () => {},
  }
}
