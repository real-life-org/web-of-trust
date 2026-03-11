import { useState, useEffect } from 'react'
import { useAdapters } from '../context'
import type { DirtyState } from '../adapters/AutomergePublishStateStore'

/**
 * Hook that tracks pending discovery sync state and errors.
 * Returns whether any publish operations are pending and the last error.
 */
export function useSyncStatus() {
  const { publishStateStore, discovery } = useAdapters()
  const [dirtyState, setDirtyState] = useState<DirtyState>({ profile: false, verifications: false, attestations: false })
  const [discoveryError, setDiscoveryError] = useState<string | null>(discovery.lastError)

  useEffect(() => {
    const subscribable = publishStateStore.watchDirtyState()
    setDirtyState(subscribable.getValue())

    const unsub = subscribable.subscribe((state) => {
      setDirtyState(state)
    })

    return unsub
  }, [publishStateStore])

  useEffect(() => {
    setDiscoveryError(discovery.lastError)
    return discovery.onErrorChange((error) => {
      setDiscoveryError(error)
    })
  }, [discovery])

  const hasPendingSync = dirtyState.profile || dirtyState.verifications || dirtyState.attestations

  return { dirtyState, hasPendingSync, discoveryError }
}
