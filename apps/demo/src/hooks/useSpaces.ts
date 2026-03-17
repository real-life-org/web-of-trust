import { useState, useEffect, useCallback, useMemo } from 'react'
import { decodeBase64Url, type SpaceInfo, type SpaceDocMeta } from '@real-life/wot-core'
import { useAdapters } from '../context'
import { useSubscribable } from './useSubscribable'

export function useSpaces() {
  const { replication, discovery, messaging } = useAdapters()
  const [loading, setLoading] = useState(true)

  // Reactive subscription to space list via watchSpaces()
  const spacesSubscribable = useMemo(
    () => replication.watchSpaces(),
    [replication],
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
    const space = await replication.createSpace('shared', { notes: '' }, { name })
    return space
  }, [replication])

  const inviteMember = useCallback(async (spaceId: string, memberDid: string) => {
    const result = await discovery.resolveProfile(memberDid)
    if (!result.profile?.encryptionPublicKey) {
      throw new Error('NO_ENCRYPTION_KEY')
    }
    const encPubKey = decodeBase64Url(result.profile.encryptionPublicKey)
    await replication.addMember(spaceId, memberDid, encPubKey)
  }, [replication, discovery])

  const removeMember = useCallback(async (spaceId: string, memberDid: string) => {
    await replication.removeMember(spaceId, memberDid)
  }, [replication])

  const updateSpace = useCallback(async (spaceId: string, meta: SpaceDocMeta) => {
    await replication.updateSpace(spaceId, meta)
  }, [replication])

  const getSpace = useCallback(async (spaceId: string) => {
    return replication.getSpace(spaceId)
  }, [replication])

  const refresh = useCallback(async () => {
    // No-op: watchSpaces handles updates reactively now
    // Kept for backwards compatibility with components that call refresh()
  }, [])

  return {
    spaces,
    loading,
    createSpace,
    updateSpace,
    inviteMember,
    removeMember,
    getSpace,
    refresh,
  }
}
