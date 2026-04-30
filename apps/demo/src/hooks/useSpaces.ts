import { useState, useEffect, useCallback, useMemo } from 'react'
import { SpacesWorkflow, type SpaceDocMeta, type SpaceMemberKeyDirectory } from '@web_of_trust/core'
import { useAdapters } from '../context'
import { useSubscribable } from './useSubscribable'

export function useSpaces() {
  const { replication, discovery, messaging } = useAdapters()
  const [loading, setLoading] = useState(true)
  const memberKeys = useMemo<SpaceMemberKeyDirectory>(() => ({
    async resolveMemberEncryptionKey(did: string) {
      const result = await discovery.resolveProfile(did)
      return result.profile?.encryptionPublicKey ?? null
    },
  }), [discovery])
  const spacesWorkflow = useMemo(
    () => new SpacesWorkflow({
      replication,
      memberKeys,
      defaultInitialDoc: () => ({ notes: '' }),
    }),
    [replication, memberKeys],
  )

  // Reactive subscription to space list via watchSpaces()
  const spacesSubscribable = useMemo(
    () => spacesWorkflow.watchSpaces(),
    [spacesWorkflow],
  )
  const spaces = useSubscribable(spacesSubscribable)

  // Mark loading done once we have initial data
  useEffect(() => {
    if (spaces !== undefined) setLoading(false)
  }, [spaces])

  // Also refresh on space-invite / member-update messages
  // (belt-and-suspenders: watchSpaces handles most cases, but
  //  invite processing is async and may not have updated yet)
  useEffect(() => {
    const unsub = messaging.onMessage(async (envelope) => {
      const type = envelope.type as string
      if (type === 'space-invite' || type === 'member-update') {
        // Give the adapter time to process the message, then force a re-read
        setTimeout(async () => {
          // watchSpaces will notify automatically, but just in case
        }, 500)
      }
    })
    return unsub
  }, [messaging])

  const createSpace = useCallback(async (name: string) => {
    const space = await spacesWorkflow.createSpace({ name })
    return space
  }, [spacesWorkflow])

  const inviteMember = useCallback(async (spaceId: string, memberDid: string) => {
    await spacesWorkflow.inviteMember({ spaceId, memberDid })
  }, [spacesWorkflow])

  const removeMember = useCallback(async (spaceId: string, memberDid: string) => {
    await spacesWorkflow.removeMember({ spaceId, memberDid })
  }, [spacesWorkflow])

  const leaveSpace = useCallback(async (spaceId: string) => {
    await spacesWorkflow.leaveSpace(spaceId)
  }, [spacesWorkflow])

  const updateSpace = useCallback(async (spaceId: string, meta: SpaceDocMeta) => {
    await spacesWorkflow.updateSpace(spaceId, meta)
  }, [spacesWorkflow])

  const getSpace = useCallback(async (spaceId: string) => {
    return spacesWorkflow.getSpace(spaceId)
  }, [spacesWorkflow])

  const refresh = useCallback(async () => {
    await spacesWorkflow.requestSync()
  }, [spacesWorkflow])

  return {
    spaces,
    loading,
    createSpace,
    updateSpace,
    inviteMember,
    removeMember,
    leaveSpace,
    getSpace,
    refresh,
  }
}
