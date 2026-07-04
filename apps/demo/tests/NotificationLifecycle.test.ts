/**
 * Generic dialog lifecycle in ConfettiProvider (TC2-TC5, TC7):
 *
 * - OPEN gate: an id present in the synced dismissedNotifications map never
 *   (re-)enters the queue — checked SYNCHRONOUSLY at enqueue time (no flicker).
 * - CLOSE observe: a resolve arriving via sync removes matching open items.
 * - Resolve: dismissing writes markNotificationResolved(id), additive and
 *   type-scoped (a mismatching dismiss call must not resolve an unrelated
 *   dialog at the queue head).
 * - Per-event ids: ver-<attestationId> and space-<inviteMessageId> — one
 *   resolve never blocks the next event from the same DID / space.
 *
 * The AdapterContext module is mocked; the fake resolution store mimics the
 * storage adapters' contract (fresh synchronous getValue + reactive subscribe).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Attestation } from '@web_of_trust/core/types'

const mockAdapters: { current: unknown } = { current: null }

vi.mock('../src/context/AdapterContext', () => ({
  useOptionalAdapters: () => mockAdapters.current,
}))

// Import AFTER the mock so the provider picks it up.
const { ConfettiProvider, useConfetti } = await import('../src/context/PendingVerificationContext')

type ResolvedMap = Record<string, { resolvedAt: string }>

function createFakeResolutionStore(initial: ResolvedMap = {}) {
  let map: ResolvedMap = { ...initial }
  const listeners = new Set<(m: ResolvedMap) => void>()
  const notify = () => { for (const cb of listeners) cb(map) }

  const storage = {
    markNotificationResolved: vi.fn(async (id: string) => {
      map = { ...map, [id]: { resolvedAt: new Date().toISOString() } }
      notify()
    }),
    collectResolvedNotificationGarbage: vi.fn(async () => 0),
  }
  const reactiveStorage = {
    watchNotificationResolution: () => ({
      getValue: () => map,
      subscribe: (cb: (m: ResolvedMap) => void) => {
        listeners.add(cb)
        return () => { listeners.delete(cb) }
      },
    }),
  }
  /** Simulates a resolve synced in from ANOTHER device. */
  const resolveRemotely = (id: string) => {
    map = { ...map, [id]: { resolvedAt: new Date().toISOString() } }
    notify()
  }
  return { storage, reactiveStorage, resolveRemotely }
}

function wrapper({ children }: { children: React.ReactNode }) {
  return createElement(ConfettiProvider, null, children)
}

function makeAttestation(id: string, from = 'did:key:alice'): Attestation {
  return {
    id,
    from,
    to: 'did:key:me',
    claim: 'in-person verifiziert',
    createdAt: new Date().toISOString(),
    vcJws: 'header.payload.signature',
  }
}

describe('Generic dialog lifecycle (ConfettiProvider + synced resolution)', () => {
  let store: ReturnType<typeof createFakeResolutionStore>

  beforeEach(() => {
    store = createFakeResolutionStore()
    mockAdapters.current = { storage: store.storage, reactiveStorage: store.reactiveStorage }
  })

  it('OPEN gate: a resolved attestation id does not enqueue (history catch-up / retained-inbox redelivery)', () => {
    store.resolveRemotely('att-urn:uuid:a1')
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.triggerAttestationDialog({
        attestationId: 'urn:uuid:a1', senderName: 'Alice', senderDid: 'did:key:alice', claim: 'X',
      })
    })

    expect(result.current.incomingAttestation).toBeNull()
  })

  it('OPEN gate: a resolved mutual-verification neither shows nor fires confetti (observer re-fire, TC8)', () => {
    store.resolveRemotely('mutual-did:key:alice')
    const { result } = renderHook(() => useConfetti(), { wrapper })

    const keyBefore = result.current.confettiKey
    act(() => {
      result.current.triggerMutualDialog({ name: 'Alice', did: 'did:key:alice' })
    })

    expect(result.current.mutualPeer).toBeNull()
    expect(result.current.confettiKey).toBe(keyBefore)
  })

  it('CLOSE observe: a resolve synced from another device closes the open dialog', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.triggerAttestationDialog({
        attestationId: 'urn:uuid:a1', senderName: 'Alice', senderDid: 'did:key:alice', claim: 'X',
      })
    })
    expect(result.current.incomingAttestation?.attestationId).toBe('urn:uuid:a1')

    act(() => { store.resolveRemotely('att-urn:uuid:a1') })
    expect(result.current.incomingAttestation).toBeNull()
  })

  it('CLOSE observe: also removes resolved items further back in the queue', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.triggerAttestationDialog({
        attestationId: 'urn:uuid:a1', senderName: 'Alice', senderDid: 'did:key:alice', claim: 'first',
      })
      result.current.triggerAttestationDialog({
        attestationId: 'urn:uuid:a2', senderName: 'Bob', senderDid: 'did:key:bob', claim: 'second',
      })
    })

    // Resolve the SECOND (not currently shown) item remotely, then dismiss the first.
    act(() => { store.resolveRemotely('att-urn:uuid:a2') })
    act(() => { result.current.dismissAttestationDialog() })

    expect(result.current.incomingAttestation).toBeNull()
  })

  it('dismiss resolves the current notification (synced write, additive to the domain action)', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.triggerAttestationDialog({
        attestationId: 'urn:uuid:a1', senderName: 'Alice', senderDid: 'did:key:alice', claim: 'X',
      })
    })
    act(() => { result.current.dismissAttestationDialog() })

    expect(store.storage.markNotificationResolved).toHaveBeenCalledWith('att-urn:uuid:a1')
    expect(result.current.incomingAttestation).toBeNull()
  })

  it('type-scoped dismiss: setPendingIncoming(null) (e.g. useVerification.reset) must NOT resolve an unrelated queue head', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.triggerSpaceInviteDialog({
        spaceId: 's1', spaceName: 'Familie', inviterName: 'Alice', inviterDid: 'did:key:alice',
        inviteMessageId: 'urn:uuid:invite-1',
      })
    })
    // Unconditional reset from the verification flow while a space invite is showing.
    act(() => { result.current.setPendingIncoming(null) })

    expect(store.storage.markNotificationResolved).not.toHaveBeenCalled()
    expect(result.current.incomingSpaceInvite?.spaceId).toBe('s1')
  })

  it('incoming-verification uses per-event id ver-<attestationId>: one resolve does not block the next verification from the same DID', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.setPendingIncoming({ attestation: makeAttestation('urn:uuid:v1'), fromDid: 'did:key:alice' })
    })
    act(() => { result.current.setPendingIncoming(null) })
    expect(store.storage.markNotificationResolved).toHaveBeenCalledWith('ver-urn:uuid:v1')

    // Second verification from the SAME DID, new event → must open.
    act(() => {
      result.current.setPendingIncoming({ attestation: makeAttestation('urn:uuid:v2'), fromDid: 'did:key:alice' })
    })
    expect(result.current.pendingIncoming?.attestation.id).toBe('urn:uuid:v2')
  })

  it('space-invite uses per-event id space-<inviteMessageId>: a resolved invite does not block a re-invite of the same space', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    const invite = (inviteMessageId: string) => ({
      spaceId: 's1', spaceName: 'Familie', inviterName: 'Alice', inviterDid: 'did:key:alice', inviteMessageId,
    })
    act(() => { result.current.triggerSpaceInviteDialog(invite('urn:uuid:invite-1')) })
    act(() => { result.current.dismissSpaceInviteDialog() })
    expect(store.storage.markNotificationResolved).toHaveBeenCalledWith('space-urn:uuid:invite-1')

    act(() => { result.current.triggerSpaceInviteDialog(invite('urn:uuid:invite-2')) })
    expect(result.current.incomingSpaceInvite?.spaceId).toBe('s1')
  })

  it('event-id-scoped dismiss: a stale dismiss for A must not resolve the next same-type notification B (async-handler vs. remote-close race)', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    // Two same-type notifications: A is shown, B waits in the queue.
    act(() => {
      result.current.triggerAttestationDialog({
        attestationId: 'urn:uuid:a', senderName: 'Alice', senderDid: 'did:key:alice', claim: 'A',
      })
      result.current.triggerAttestationDialog({
        attestationId: 'urn:uuid:b', senderName: 'Bob', senderDid: 'did:key:bob', claim: 'B',
      })
    })
    expect(result.current.incomingAttestation?.attestationId).toBe('urn:uuid:a')

    // An async handler (e.g. handlePublish awaiting the domain action) captured
    // the dismiss callback while A was visible…
    const staleDismiss = result.current.dismissAttestationDialog

    // …then a synced CLOSE from another device removes A; B becomes the head.
    act(() => { store.resolveRemotely('att-urn:uuid:a') })
    expect(result.current.incomingAttestation?.attestationId).toBe('urn:uuid:b')

    // The stale dismiss fires now. It must target A (already gone → no-op),
    // NEVER resolve B — B was never handled by the user.
    act(() => { staleDismiss() })

    expect(store.storage.markNotificationResolved).not.toHaveBeenCalled()
    expect(result.current.incomingAttestation?.attestationId).toBe('urn:uuid:b')
  })

  it('dismiss of an already remotely-resolved id writes no echo marker (GC-TTL not extended)', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.triggerAttestationDialog({
        attestationId: 'urn:uuid:a', senderName: 'Alice', senderDid: 'did:key:alice', claim: 'A',
      })
    })
    const staleDismiss = result.current.dismissAttestationDialog
    act(() => { store.resolveRemotely('att-urn:uuid:a') })
    act(() => { staleDismiss() })

    expect(store.storage.markNotificationResolved).not.toHaveBeenCalled()
  })

  it('without an AdapterProvider the queue degrades to local-only behavior (tests / standalone)', () => {
    mockAdapters.current = null
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.triggerAttestationDialog({
        attestationId: 'urn:uuid:a1', senderName: 'Alice', senderDid: 'did:key:alice', claim: 'X',
      })
    })
    expect(result.current.incomingAttestation?.attestationId).toBe('urn:uuid:a1')
    act(() => { result.current.dismissAttestationDialog() })
    expect(result.current.incomingAttestation).toBeNull()
  })

  it('TC9 wiring proof: the adapter init calls the resolved-notification GC (no silent leak)', () => {
    const demoRoot = existsSync('apps/demo/src') ? 'apps/demo' : '.'
    const source = readFileSync(join(demoRoot, 'src/context/AdapterContext.tsx'), 'utf8')
    expect(source).toContain('collectResolvedNotificationGarbage(new Date())')
  })
})
