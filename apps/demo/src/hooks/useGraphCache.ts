import { useState, useEffect, useCallback, useRef } from 'react'
import { GraphCacheService, type CachedGraphEntry } from '@web.of.trust/core'
import { useAdapters } from '../context'
import { useContacts } from './useContacts'

/**
 * Hook that provides access to the local social graph cache.
 *
 * On mount, refreshes stale/missing entries for all contacts in background.
 * Exposes methods for cache lookup, refresh, and graph queries.
 */
export function useGraphCache() {
  const { discovery, graphCacheStore } = useAdapters()
  const { activeContacts } = useContacts()
  const [entries, setEntries] = useState<Map<string, CachedGraphEntry>>(new Map())
  const serviceRef = useRef<GraphCacheService | null>(null)

  // Stable service instance
  if (!serviceRef.current) {
    serviceRef.current = new GraphCacheService(discovery, graphCacheStore)
  }
  const service = serviceRef.current

  // Load cached entries for all active contacts and refresh stale ones
  useEffect(() => {
    let cancelled = false

    async function loadAndRefresh() {
      const contactDids = activeContacts.map(c => c.did)
      if (contactDids.length === 0) return

      // Load existing cached entries immediately
      const cached = await graphCacheStore.getEntries(contactDids)
      if (!cancelled) setEntries(cached)

      // Lightweight batch refresh: one HTTP request for all contacts
      await service.refreshContactSummaries(contactDids)

      // Reload after summary refresh
      if (!cancelled) {
        const afterSummary = await graphCacheStore.getEntries(contactDids)
        if (!cancelled) setEntries(afterSummary)

        // Full refresh for entries missing verifierDids (needed for inter-contact edges)
        // Use service.refresh() directly to bypass the stale-check in refreshContacts()
        const needsFull = contactDids.filter(did => {
          const entry = afterSummary.get(did)
          return !entry?.verifierDids?.length
        })
        if (needsFull.length > 0 && !cancelled) {
          await Promise.allSettled(needsFull.map(did => service.refresh(did)))
          if (!cancelled) {
            const afterFull = await graphCacheStore.getEntries(contactDids)
            if (!cancelled) setEntries(afterFull)
          }
        }
      }
    }

    loadAndRefresh()
    return () => { cancelled = true }
  }, [activeContacts, graphCacheStore, service])

  const getEntry = useCallback(
    (did: string): CachedGraphEntry | undefined => entries.get(did),
    [entries],
  )

  const ensureCached = useCallback(
    async (did: string): Promise<CachedGraphEntry | null> => {
      return service.ensureCached(did)
    },
    [service],
  )

  const refresh = useCallback(
    async (did: string): Promise<CachedGraphEntry | null> => {
      const entry = await service.refresh(did)
      // Update local state
      if (entry) {
        setEntries(prev => new Map(prev).set(did, entry))
      }
      return entry
    },
    [service],
  )

  const resolveName = useCallback(
    async (did: string): Promise<string | null> => {
      return service.resolveName(did)
    },
    [service],
  )

  const findMutualContacts = useCallback(
    async (targetDid: string): Promise<string[]> => {
      const myContactDids = activeContacts.map(c => c.did)
      return service.findMutualContacts(targetDid, myContactDids)
    },
    [service, activeContacts],
  )

  return {
    entries,
    getEntry,
    ensureCached,
    refresh,
    resolveName,
    findMutualContacts,
  }
}
