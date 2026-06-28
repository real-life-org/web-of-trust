import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Attestation } from '@web_of_trust/core/types'

const MY_DID = 'did:key:z6MkMe'
const ALICE_DID = 'did:key:z6MkAlice'
const BOB_DID = 'did:key:z6MkBob'
const CAROL_DID = 'did:key:z6MkCarol'
const STRANGER_DID = 'did:key:z6MkStranger'
const VERIFICATION_CLAIM = 'in-person verifiziert'

const testDir = path.dirname(fileURLToPath(import.meta.url))

function readRepoFile(file: string): string {
  const actualPath = fs.existsSync(file) ? file : path.resolve(testDir, '..', '..', '..', file)
  return fs.readFileSync(actualPath, 'utf8')
}

function makeTrustVerificationAttestation(
  from: string,
  to: string,
  options: Partial<Pick<Attestation, 'claim' | 'vcJws' | 'inResponseTo' | 'isVerification'>> = {},
): Attestation {
  return {
    id: `urn:uuid:att-${from.slice(-5)}-${to.slice(-5)}-${Math.random()}`,
    from,
    to,
    claim: options.claim ?? VERIFICATION_CLAIM,
    createdAt: new Date().toISOString(),
    vcJws: options.vcJws ?? 'eyJhbGciOiJFZERTQSJ9.eyJ0eXAiOiJXb3RBdHRlc3RhdGlvbiJ9.signature',
    // Type-borne marker (review MAJOR 2): genuine verification unless overridden.
    isVerification: options.isVerification ?? true,
    ...(options.inResponseTo ? { inResponseTo: options.inResponseTo } : {}),
  }
}

let attestationsForTest: Attestation[] = []
let contactsForTest: Array<{ did: string; name?: string }> = []

vi.mock('../src/context', () => ({
  useAdapters: () => ({ reactiveStorage: {} }),
  useIdentity: () => ({ did: MY_DID }),
}))

vi.mock('../src/hooks/useContacts', () => ({
  useContacts: () => ({
    activeContacts: contactsForTest,
    pendingContacts: [],
  }),
}))

vi.mock('../src/hooks/useVerificationStatus', async () => {
  const actual = await vi.importActual<typeof import('../src/hooks/useVerificationStatus')>(
    '../src/hooks/useVerificationStatus',
  )
  return {
    ...actual,
    useVerificationStatus: () => ({
      getStatus: () => 'none' as const,
      allAttestations: attestationsForTest,
    }),
  }
})

vi.mock('../src/hooks/useAttestations', () => ({
  useAttestations: () => ({
    attestations: attestationsForTest,
  }),
}))

vi.mock('../src/hooks/useGraphCache', () => ({
  useGraphCache: () => ({
    entries: new Map(),
  }),
}))

vi.mock('../src/hooks/useProfile', () => ({
  useLocalIdentity: () => null,
}))

vi.mock('../src/hooks/useSpaces', () => ({
  useSpaces: () => ({ spaces: [] }),
}))

import { useNetworkGraph } from '../src/hooks/useNetworkGraph'

function findEdge(
  edges: Array<{ source: string; target: string; type: string }>,
  a: string,
  b: string,
) {
  return edges.find(
    (e) => (e.source === a && e.target === b) || (e.source === b && e.target === a),
  )
}

describe('Network graph contact-to-contact edges from Trust 002 attestations', () => {
  it('derives a mutual edge between two visible contacts from opposite-direction verification-attestations', () => {
    contactsForTest = [
      { did: ALICE_DID, name: 'Alice' },
      { did: BOB_DID, name: 'Bob' },
    ]
    attestationsForTest = [
      makeTrustVerificationAttestation(ALICE_DID, BOB_DID),
      makeTrustVerificationAttestation(BOB_DID, ALICE_DID),
    ]

    const { result } = renderHook(() => useNetworkGraph())
    const edge = findEdge(result.current.edges, ALICE_DID, BOB_DID)

    expect(edge).toBeDefined()
    expect(edge?.type).toBe('mutual')
  })

  it('derives a directional edge when only one verification-attestation exists', () => {
    contactsForTest = [
      { did: ALICE_DID, name: 'Alice' },
      { did: BOB_DID, name: 'Bob' },
    ]
    attestationsForTest = [makeTrustVerificationAttestation(ALICE_DID, BOB_DID)]

    const { result } = renderHook(() => useNetworkGraph())
    const edge = findEdge(result.current.edges, ALICE_DID, BOB_DID)

    expect(edge).toBeDefined()
    expect(edge?.type).not.toBe('mutual')
  })

  it('collapses opposite-direction attestations into a single mutual edge (no duplicates)', () => {
    contactsForTest = [
      { did: ALICE_DID, name: 'Alice' },
      { did: BOB_DID, name: 'Bob' },
    ]
    attestationsForTest = [
      makeTrustVerificationAttestation(ALICE_DID, BOB_DID),
      makeTrustVerificationAttestation(BOB_DID, ALICE_DID),
    ]

    const { result } = renderHook(() => useNetworkGraph())
    const aliceBobEdges = result.current.edges.filter(
      (e) =>
        (e.source === ALICE_DID && e.target === BOB_DID) ||
        (e.source === BOB_DID && e.target === ALICE_DID),
    )

    expect(aliceBobEdges).toHaveLength(1)
  })

  it('skips edges that involve my DID (those belong to the me-to-contact layer)', () => {
    contactsForTest = [
      { did: ALICE_DID, name: 'Alice' },
      { did: BOB_DID, name: 'Bob' },
    ]
    attestationsForTest = [
      makeTrustVerificationAttestation(MY_DID, ALICE_DID),
      makeTrustVerificationAttestation(ALICE_DID, MY_DID),
    ]

    const { result } = renderHook(() => useNetworkGraph())
    const contactToContactEdges = result.current.edges.filter(
      (e) => e.source !== MY_DID && e.target !== MY_DID,
    )

    expect(contactToContactEdges).toHaveLength(0)
  })

  it('skips edges to non-contacts and self edges', () => {
    contactsForTest = [
      { did: ALICE_DID, name: 'Alice' },
      { did: BOB_DID, name: 'Bob' },
    ]
    attestationsForTest = [
      makeTrustVerificationAttestation(ALICE_DID, STRANGER_DID),
      makeTrustVerificationAttestation(STRANGER_DID, BOB_DID),
      makeTrustVerificationAttestation(ALICE_DID, ALICE_DID),
    ]

    const { result } = renderHook(() => useNetworkGraph())
    expect(findEdge(result.current.edges, ALICE_DID, STRANGER_DID)).toBeUndefined()
    expect(findEdge(result.current.edges, STRANGER_DID, BOB_DID)).toBeUndefined()
    expect(result.current.edges.find((e) => e.source === ALICE_DID && e.target === ALICE_DID)).toBeUndefined()
  })

  it('ignores non-verification-claim attestations and unsigned verification claims', () => {
    contactsForTest = [
      { did: ALICE_DID, name: 'Alice' },
      { did: BOB_DID, name: 'Bob' },
    ]
    const unsigned = makeTrustVerificationAttestation(ALICE_DID, BOB_DID, { isVerification: false })
    delete (unsigned as Partial<Attestation>).vcJws
    attestationsForTest = [
      makeTrustVerificationAttestation(ALICE_DID, BOB_DID, { claim: 'helped with groceries', isVerification: false }),
      makeTrustVerificationAttestation(BOB_DID, ALICE_DID, { claim: 'profile:name=Bob', isVerification: false }),
      unsigned,
    ]

    const { result } = renderHook(() => useNetworkGraph())
    expect(findEdge(result.current.edges, ALICE_DID, BOB_DID)).toBeUndefined()
  })

  it('preserves attestation from→to direction on non-mutual edges even when from sorts after to', () => {
    contactsForTest = [
      { did: ALICE_DID, name: 'Alice' },
      { did: BOB_DID, name: 'Bob' },
    ]
    // BOB_DID > ALICE_DID lexicographically; from=BOB, to=ALICE must yield source=BOB, target=ALICE
    attestationsForTest = [makeTrustVerificationAttestation(BOB_DID, ALICE_DID)]

    const { result } = renderHook(() => useNetworkGraph())
    const edge = result.current.edges.find(
      (e) => e.source !== MY_DID && e.target !== MY_DID,
    )

    expect(edge).toBeDefined()
    expect(edge?.source).toBe(BOB_DID)
    expect(edge?.target).toBe(ALICE_DID)
    expect(edge?.type).toBe('outgoing')
  })

  it('builds edges across more than two contacts independently', () => {
    contactsForTest = [
      { did: ALICE_DID, name: 'Alice' },
      { did: BOB_DID, name: 'Bob' },
      { did: CAROL_DID, name: 'Carol' },
    ]
    attestationsForTest = [
      makeTrustVerificationAttestation(ALICE_DID, BOB_DID),
      makeTrustVerificationAttestation(BOB_DID, ALICE_DID),
      makeTrustVerificationAttestation(BOB_DID, CAROL_DID),
    ]

    const { result } = renderHook(() => useNetworkGraph())
    const aliceBob = findEdge(result.current.edges, ALICE_DID, BOB_DID)
    const bobCarol = findEdge(result.current.edges, BOB_DID, CAROL_DID)

    expect(aliceBob?.type).toBe('mutual')
    expect(bobCarol).toBeDefined()
    expect(bobCarol?.type).not.toBe('mutual')
  })
})

describe('Network graph edge derivation source guard', () => {
  it('useNetworkGraph.ts derives contact-to-contact edges from Trust 002 verification-attestations, not graph-cache verifierDids', () => {
    const text = readRepoFile('apps/demo/src/hooks/useNetworkGraph.ts')
    const hits: string[] = []

    if (/cached\??\.verifierDids/.test(text)) {
      hits.push('useNetworkGraph.ts still reads cached.verifierDids for edges')
    }
    if (/reverseCache\??\.verifierDids/.test(text)) {
      hits.push('useNetworkGraph.ts still reads reverseCache.verifierDids for edges')
    }
    if (/verifierDids\?\.includes/.test(text)) {
      hits.push('useNetworkGraph.ts still uses verifierDids.includes for edges')
    }
    if (!/isVerificationAttestation/.test(text)) {
      hits.push('useNetworkGraph.ts does not import/use isVerificationAttestation for edge derivation')
    }

    expect(hits).toEqual([])
  })

  it('useGraphCache.ts no longer treats missing verifierDids as a full-refresh trigger', () => {
    const text = readRepoFile('apps/demo/src/hooks/useGraphCache.ts')
    const hits: string[] = []

    if (/missing verifierDids/.test(text)) {
      hits.push('useGraphCache.ts still mentions "missing verifierDids" full-refresh comment')
    }
    if (/needed for inter-contact edges/.test(text)) {
      hits.push('useGraphCache.ts still mentions inter-contact edges full-refresh rationale')
    }
    if (/!entry\?\.verifierDids\?\.length/.test(text)) {
      hits.push('useGraphCache.ts still gates full-refresh on missing verifierDids array')
    }
    if (/\bneedsFull\b/.test(text)) {
      hits.push('useGraphCache.ts still computes needsFull for verifierDids-driven full refresh')
    }

    expect(hits).toEqual([])
  })
})
