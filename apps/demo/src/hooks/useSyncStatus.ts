import { useState, useEffect } from 'react'
import { useAdapters } from '../context'
import type { DirtyState } from '../adapters/AutomergePublishStateStore'

/**
 * Hook that tracks pending discovery sync state and errors.
 * Returns whether any publish operations are pending and the last error.
 */
export function useSyncStatus() {
  const { publishStateStore, discovery } = useAdapters()
  const [dirtyState, setDirtyState] = useState<DirtyState>({ profile: false, attestations: false, verifications: false })
  const [discoveryError, setDiscoveryError] = useState<string | null>(discovery.lastError)
  // Error CLASSIFICATION from the source (OfflineFirstDiscoveryAdapter) so Home can
  // map a transport fault to a friendly text instead of the raw AbortError string.
  const [discoveryErrorKind, setDiscoveryErrorKind] = useState<'network' | 'other' | null>(discovery.lastErrorKind)

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
    setDiscoveryErrorKind(discovery.lastErrorKind)
    // setError updates lastError + lastErrorKind BEFORE notifying, so reading
    // lastErrorKind inside the listener returns the fresh classification.
    return discovery.onErrorChange((error) => {
      setDiscoveryError(error)
      setDiscoveryErrorKind(discovery.lastErrorKind)
    })
  }, [discovery])

  const hasPendingSync = dirtyState.profile || dirtyState.attestations || dirtyState.verifications

  return { dirtyState, hasPendingSync, discoveryError, discoveryErrorKind }
}
