import { useMemo } from 'react'
import type { Contact, SpaceInfo } from '@real-life/wot-core'
import { useIdentity } from '../context'
import { useContacts } from './useContacts'
import { useVerificationStatus, type VerificationDirection } from './useVerificationStatus'
import { useAttestations } from './useAttestations'
import { useGraphCache } from './useGraphCache'
import { useLocalIdentity } from './useProfile'
import { useSpaces } from './useSpaces'

export interface GraphNode {
  id: string
  label: string
  type: 'me' | 'active' | 'pending'
  size: number
  hue: number
  avatar?: string | undefined
  bio?: string | undefined
  verificationStatus: VerificationDirection
  verificationCount: number
  attestationCount: number
  sharedSpaces: string[]
  // D3 mutable fields
  x?: number | undefined
  y?: number | undefined
  fx?: number | null | undefined
  fy?: number | null | undefined
}

export interface GraphEdge {
  source: string
  target: string
  type: 'mutual' | 'outgoing' | 'incoming'
}

/** Deterministic hue from DID string */
function didToHue(did: string): number {
  let hash = 0
  for (let i = 0; i < did.length; i++) {
    hash = (hash * 31 + did.charCodeAt(i)) | 0
  }
  return ((hash % 360) + 360) % 360
}

/** Short display label from DID */
function didLabel(did: string): string {
  return did.slice(-8)
}

export function useNetworkGraph() {
  const { did: myDid } = useIdentity()
  const localIdentity = useLocalIdentity()
  const { activeContacts, pendingContacts } = useContacts()
  const { getStatus } = useVerificationStatus()
  const { attestations } = useAttestations()
  const { entries } = useGraphCache()
  const { spaces } = useSpaces()

  return useMemo(() => {
    if (!myDid) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] }

    const spacesList: SpaceInfo[] = spaces ?? []

    // Helper: find shared spaces between me and a contact
    const sharedSpacesFor = (contactDid: string): string[] =>
      spacesList
        .filter(s => s.type === 'shared' && s.members.includes(contactDid))
        .map(s => s.name || 'Space')

    // Helper: count attestations involving a contact
    const attestationCountFor = (contactDid: string): number =>
      attestations.filter(a => a.from === contactDid || a.to === contactDid).length

    // Build "me" node
    const meNode: GraphNode = {
      id: myDid,
      label: localIdentity?.profile?.name || 'Ich',
      type: 'me',
      size: 28,
      hue: 45, // Gold
      avatar: localIdentity?.profile?.avatar,
      bio: localIdentity?.profile?.bio,
      verificationStatus: 'none',
      verificationCount: 0,
      attestationCount: attestations.length,
      sharedSpaces: [],
    }

    // Build contact nodes
    const contactNodes: GraphNode[] = []
    const allContacts: (Contact & { nodeType: 'active' | 'pending' })[] = [
      ...activeContacts.map(c => ({ ...c, nodeType: 'active' as const })),
      ...pendingContacts.map(c => ({ ...c, nodeType: 'pending' as const })),
    ]

    for (const contact of allContacts) {
      const cached = entries.get(contact.did)
      const vCount = cached?.verificationCount ?? 0
      const aCount = cached?.attestationCount ?? attestationCountFor(contact.did)
      const status = getStatus(contact.did)

      // Size: base 14, +2 per verification, +1 per attestation, max 24
      const size = contact.nodeType === 'pending'
        ? 10
        : Math.min(24, 14 + vCount * 2 + aCount)

      contactNodes.push({
        id: contact.did,
        label: contact.name || didLabel(contact.did),
        type: contact.nodeType,
        size,
        hue: didToHue(contact.did),
        avatar: contact.avatar || cached?.avatar,
        bio: contact.bio || cached?.bio,
        verificationStatus: status,
        verificationCount: vCount,
        attestationCount: aCount,
        sharedSpaces: sharedSpacesFor(contact.did),
      })
    }

    const nodes: GraphNode[] = [meNode, ...contactNodes]

    // Build edges from verification status (me ↔ contacts)
    const edges: GraphEdge[] = []
    for (const contact of allContacts) {
      const status = getStatus(contact.did)
      if (status !== 'none') {
        edges.push({
          source: myDid,
          target: contact.did,
          type: status,
        })
      }
    }

    // Build edges between contacts (from cached verifierDids)
    const contactDids = new Set(allContacts.map(c => c.did))
    for (const contact of allContacts) {
      const cached = entries.get(contact.did)
      if (!cached?.verifierDids) continue

      for (const verifierDid of cached.verifierDids) {
        // Only add edge if the verifier is also one of my contacts (visible in graph)
        // and skip self-edges and edges to me
        if (verifierDid === myDid || verifierDid === contact.did) continue
        if (!contactDids.has(verifierDid)) continue

        // Check if reverse edge already exists to determine mutual
        const reverseCache = entries.get(verifierDid)
        const isMutual = reverseCache?.verifierDids?.includes(contact.did)

        // Avoid duplicate edges: only add if source < target (lexicographic)
        if (verifierDid < contact.did) {
          edges.push({
            source: verifierDid,
            target: contact.did,
            type: isMutual ? 'mutual' : 'outgoing',
          })
        }
      }
    }

    return { nodes, edges }
  }, [myDid, localIdentity, activeContacts, pendingContacts, getStatus, attestations, entries, spaces])
}
