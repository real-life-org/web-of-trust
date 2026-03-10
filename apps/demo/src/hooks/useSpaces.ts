import { useState, useEffect, useCallback } from 'react'
import { decodeBase64Url, type SpaceInfo } from '@real-life/wot-core'
import { useAdapters } from '../context'

export function useSpaces() {
  const { replication, discovery, messaging } = useAdapters()
  const [spaces, setSpaces] = useState<SpaceInfo[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const all = await replication.getSpaces()
    setSpaces(all)
    setLoading(false)
  }, [replication])

  // Initial load
  useEffect(() => {
    refresh()
  }, [refresh])

  // Subscribe to member changes (fires on local addMember/removeMember)
  useEffect(() => {
    return replication.onMemberChange(() => {
      refresh()
    })
  }, [replication, refresh])

  // Listen for space-invite and member-update messages
  // (handleSpaceInvite does not fire onMemberChange, so we need this)
  useEffect(() => {
    const unsub = messaging.onMessage(async (envelope) => {
      const type = envelope.type as string
      if (type === 'space-invite' || type === 'member-update') {
        // Give the adapter time to process the message
        setTimeout(() => refresh(), 500)
      }
    })
    return unsub
  }, [messaging, refresh])

  const createSpace = useCallback(async (name: string) => {
    const space = await replication.createSpace('shared', { notes: '' }, { name })
    await refresh()
    return space
  }, [replication, refresh])

  const inviteMember = useCallback(async (spaceId: string, memberDid: string) => {
    const result = await discovery.resolveProfile(memberDid)
    if (!result.profile?.encryptionPublicKey) {
      throw new Error('NO_ENCRYPTION_KEY')
    }
    const encPubKey = decodeBase64Url(result.profile.encryptionPublicKey)
    await replication.addMember(spaceId, memberDid, encPubKey)
    await refresh()
  }, [replication, discovery, refresh])

  const removeMember = useCallback(async (spaceId: string, memberDid: string) => {
    await replication.removeMember(spaceId, memberDid)
    await refresh()
  }, [replication, refresh])

  const getSpace = useCallback(async (spaceId: string) => {
    return replication.getSpace(spaceId)
  }, [replication])

  return {
    spaces,
    loading,
    createSpace,
    inviteMember,
    removeMember,
    getSpace,
    refresh,
  }
}
