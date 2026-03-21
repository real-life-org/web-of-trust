import { useCallback, useMemo } from 'react'
import { useAdapters } from '../context'
import { useSubscribable } from './useSubscribable'
import type { DeliveryStatus } from '../services/AttestationService'

export function useAttestationDelivery() {
  const { attestationService } = useAdapters()

  const subscribable = useMemo(
    () => attestationService.watchDeliveryStatus(),
    [attestationService]
  )
  const statusMap = useSubscribable(subscribable)

  const retryAttestation = useCallback(
    (id: string) => attestationService.retryAttestation(id),
    [attestationService]
  )

  return { deliveryStatusMap: statusMap, retryAttestation }
}

export type { DeliveryStatus }
