import { useMemo } from 'react'
import type { Attestation, Contact, SpaceInfo } from '@web_of_trust/core/types'
import { useIdentity } from '../context'
import { useContacts } from './useContacts'
import {
  useVerificationStatus,
  isVerificationAttestation,
  type VerificationDirection,
} from './useVerificationStatus'
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
  const { entries, verifications, forceRefresh } = useGraphCache()
  const { spaces } = useSpaces()

  const graph = useMemo(() => {
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

    // Build edges between contacts from local Trust 002 verification-attestations.
    // Each verification-attestation (from → to) is a directional edge; opposite-direction
    // attestations between the same two contacts collapse into one `mutual` edge.
    const contactDids = new Set(allContacts.map(c => c.did))
    const pairs = new Map<string, { from: string; to: string; mutual: boolean }>()
    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

    const mergePair = (from: string, to: string) => {
      if (from === to) return
      if (from === myDid || to === myDid) return
      if (!contactDids.has(from) || !contactDids.has(to)) return

      const key = pairKey(from, to)
      const existing = pairs.get(key)
      if (!existing) {
        pairs.set(key, { from, to, mutual: false })
      } else if (existing.from !== from) {
        existing.mutual = true
      }
    }

    for (const attestation of attestations) {
      if (!isVerificationAttestation(attestation)) continue
      mergePair(attestation.from, attestation.to)
    }

    // Additionally merge contact↔contact edges from the graph cache: each
    // contact's cached `/v` records (verifications received from the profile
    // server). The `/v` resource is verifications-only, so no marker re-check is
    // needed — same directional filter as the local path. Merged into the SAME
    // pairs map BEFORE the mutual-collapse, so local + cached unite and duplicate
    // / opposite-direction edges collapse via pairKey (no duplicate edges).
    const cachedVerifications = verifications ?? new Map<string, Attestation[]>()
    for (const [contactDid, records] of cachedVerifications) {
      if (!contactDids.has(contactDid)) continue
      for (const record of records) {
        mergePair(record.from, record.to)
      }
    }

    for (const { from, to, mutual } of pairs.values()) {
      edges.push({
        source: from,
        target: to,
        type: mutual ? 'mutual' : 'outgoing',
      })
    }

    return { nodes, edges }
  }, [myDid, localIdentity, activeContacts, pendingContacts, getStatus, attestations, entries, verifications, spaces])

  // forceRefresh is exposed so the Network page can drive live polling (Beamer
  // mode) — refreshing the cache re-populates `verifications`/`entries`, which
  // re-memoizes the graph above. Kept out of the memo so its identity is stable.
  return { nodes: graph.nodes, edges: graph.edges, forceRefresh }
}
