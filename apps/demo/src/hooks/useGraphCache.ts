import { useState, useEffect, useCallback, useRef } from 'react'
import { GraphCacheService } from '@web_of_trust/core/adapters'
import type { CachedGraphEntry, GraphCacheStore } from '@web_of_trust/core/ports'
import type { Attestation } from '@web_of_trust/core/types'
import { useAdapters } from '../context'
import { useContacts } from './useContacts'

/** Max concurrent force-refreshes — mirrors GraphCacheService.concurrency (3). */
const REFRESH_CONCURRENCY = 3

/**
 * Load the cached verification records (derived Attestation[] with from/to) for
 * a set of DIDs. Used to feed contact↔contact edges into the network graph.
 * Missing/errored entries default to an empty list.
 */
async function loadVerifications(
  store: GraphCacheStore,
  dids: string[],
): Promise<Map<string, Attestation[]>> {
  const map = new Map<string, Attestation[]>()
  await Promise.all(
    dids.map(async (did) => {
      const v = await store.getCachedVerifications(did).catch(() => [] as Attestation[])
      map.set(did, v)
    }),
  )
  return map
}

/**
 * Hook that provides access to the local social graph cache.
 *
 * On mount, refreshes stale/missing entries for all contacts in background.
 * Exposes methods for cache lookup, refresh, and graph queries.
 *
 * `verifications` holds each contact's cached `/v` records (from/to) so the
 * network graph can draw contact↔contact edges from the cache, not just from
 * local attestations. `forceRefresh` bypasses the staleness window (used by the
 * Network page's live polling).
 */
export function useGraphCache() {
  const { discovery, graphCacheStore } = useAdapters()
  const { activeContacts } = useContacts()
  const [entries, setEntries] = useState<Map<string, CachedGraphEntry>>(new Map())
  const [verifications, setVerifications] = useState<Map<string, Attestation[]>>(new Map())
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

      // Load existing cached entries + verifications immediately
      const [cached, cachedV] = await Promise.all([
        graphCacheStore.getEntries(contactDids),
        loadVerifications(graphCacheStore, contactDids),
      ])
      if (!cancelled) {
        setEntries(cached)
        setVerifications(cachedV)
      }

      // Lightweight batch refresh: one HTTP request for all contacts
      await service.refreshContactSummaries(contactDids)

      // Reload after summary refresh
      if (!cancelled) {
        const afterSummary = await graphCacheStore.getEntries(contactDids)
        if (!cancelled) setEntries(afterSummary)
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

  /**
   * Force-refresh the full graph data (profile + attestations + verifications)
   * for ALL active contacts, bypassing the staleness window. Runs at most
   * REFRESH_CONCURRENCY DIDs in parallel, then reloads entries + verifications so
   * consumers (useNetworkGraph) re-memoize. Used by the Network page's live poll.
   */
  const forceRefresh = useCallback(async (): Promise<void> => {
    const contactDids = activeContacts.map(c => c.did)
    if (contactDids.length === 0) return

    for (let i = 0; i < contactDids.length; i += REFRESH_CONCURRENCY) {
      const batch = contactDids.slice(i, i + REFRESH_CONCURRENCY)
      await Promise.allSettled(batch.map(did => service.refresh(did)))
    }

    const [freshEntries, freshV] = await Promise.all([
      graphCacheStore.getEntries(contactDids),
      loadVerifications(graphCacheStore, contactDids),
    ])
    setEntries(freshEntries)
    setVerifications(freshV)
  }, [activeContacts, graphCacheStore, service])

  const resolveName = useCallback(
    async (did: string): Promise<string | null> => {
      return service.resolveName(did)
    },
    [service],
  )

  return {
    entries,
    verifications,
    getEntry,
    ensureCached,
    refresh,
    forceRefresh,
    resolveName,
  }
}
