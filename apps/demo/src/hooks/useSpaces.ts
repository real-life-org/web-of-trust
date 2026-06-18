import { useState, useEffect, useCallback, useMemo } from 'react'
import { SpacesWorkflow } from '@web_of_trust/core/application'
import * as protocol from '@web_of_trust/core/protocol'
import type { SpaceMemberKeyDirectory } from '@web_of_trust/core/ports'
import type { SpaceDocMeta } from '@web_of_trust/core/types'
import { useAdapters } from '../context'
import { useSubscribable } from './useSubscribable'

export function useSpaces() {
  const { replication, discovery } = useAdapters()
  const [loading, setLoading] = useState(true)
  const memberKeys = useMemo<SpaceMemberKeyDirectory>(() => ({
    async resolveMemberEncryptionKey(did: string) {
      const result = await discovery.resolveProfile(did)
      const keyAgreement = result.didDocument?.keyAgreement?.[0]?.publicKeyMultibase
      if (!keyAgreement) return null
      try {
        return protocol.x25519MultibaseToPublicKeyBytes(keyAgreement)
      } catch {
        return null
      }
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

  // Inbox-Wire-Migration: der frühere onMessage-Listener auf die Old-World-Typen
  // 'space-invite'/'member-update' ist tot — die Typen existieren auf dem Wire
  // nicht mehr (DIDComm-Type-URIs, vom Replication-Adapter dekodiert) und der
  // Handler war ein No-op. watchSpaces() ist der reaktive Pfad.

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

  // Sync 005 Z.221: ein Admin befördert einen aktiven Member zum Admin. Aufrufer-
  // Guard + active-member-Check liegen im Adapter (durch die volle Port-Kette
  // ReplicationAdapter → SpaceReplicationPort → SpacesWorkflow gefädelt).
  const promoteToAdmin = useCallback(async (spaceId: string, memberDid: string) => {
    await spacesWorkflow.promoteToAdmin({ spaceId, memberDid })
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
    promoteToAdmin,
    leaveSpace,
    getSpace,
    refresh,
  }
}
