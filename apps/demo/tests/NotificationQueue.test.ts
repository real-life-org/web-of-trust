/**
 * Tests for the notification queue in PendingVerificationContext.
 *
 * The queue replaces the old single-value states (mutualPeer, incomingAttestation,
 * pendingIncoming) with a FIFO queue that deduplicates by ID. This ensures
 * multiple simultaneous notifications are shown one after another instead of
 * overwriting each other.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement } from 'react'
import { ConfettiProvider, useConfetti } from '../src/context/PendingVerificationContext'
import type { Verification } from '@web_of_trust/core/types'

function wrapper({ children }: { children: React.ReactNode }) {
  return createElement(ConfettiProvider, null, children)
}

describe('Notification Queue', () => {
  it('shows first queued notification as current', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.triggerAttestationDialog({
        attestationId: 'att-1',
        senderName: 'Alice',
        senderDid: 'did:key:alice',
        claim: 'Knows TypeScript',
      })
    })

    expect(result.current.incomingAttestation).toEqual({
      attestationId: 'att-1',
      senderName: 'Alice',
      senderDid: 'did:key:alice',
      claim: 'Knows TypeScript',
    })
    expect(result.current.mutualPeer).toBeNull()
    expect(result.current.pendingIncoming).toBeNull()
  })

  it('queues multiple notifications and shows them sequentially', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.triggerAttestationDialog({
        attestationId: 'att-1',
        senderName: 'Alice',
        senderDid: 'did:key:alice',
        claim: 'First',
      })
      result.current.triggerAttestationDialog({
        attestationId: 'att-2',
        senderName: 'Bob',
        senderDid: 'did:key:bob',
        claim: 'Second',
      })
    })

    // First in queue
    expect(result.current.incomingAttestation?.attestationId).toBe('att-1')

    // Dismiss first → second becomes current
    act(() => result.current.dismissAttestationDialog())
    expect(result.current.incomingAttestation?.attestationId).toBe('att-2')

    // Dismiss second → empty
    act(() => result.current.dismissAttestationDialog())
    expect(result.current.incomingAttestation).toBeNull()
  })

  it('deduplicates by notification id', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.triggerAttestationDialog({
        attestationId: 'att-1',
        senderName: 'Alice',
        senderDid: 'did:key:alice',
        claim: 'Same attestation',
      })
      // Same attestation triggered again (e.g. duplicate relay message)
      result.current.triggerAttestationDialog({
        attestationId: 'att-1',
        senderName: 'Alice',
        senderDid: 'did:key:alice',
        claim: 'Same attestation',
      })
    })

    expect(result.current.incomingAttestation?.attestationId).toBe('att-1')

    // After dismiss, queue should be empty (no duplicate)
    act(() => result.current.dismissAttestationDialog())
    expect(result.current.incomingAttestation).toBeNull()
  })

  it('mixes different notification types in the queue', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    act(() => {
      result.current.triggerMutualDialog({ name: 'Alice', did: 'did:key:alice' })
      result.current.triggerAttestationDialog({
        attestationId: 'att-1',
        senderName: 'Bob',
        senderDid: 'did:key:bob',
        claim: 'Knows React',
      })
    })

    // First: mutual dialog
    expect(result.current.mutualPeer?.did).toBe('did:key:alice')
    expect(result.current.incomingAttestation).toBeNull()

    // Dismiss mutual → attestation becomes current
    act(() => result.current.dismissMutualDialog())
    expect(result.current.mutualPeer).toBeNull()
    expect(result.current.incomingAttestation?.attestationId).toBe('att-1')
  })

  it('handles setPendingIncoming enqueue and dismiss', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    const verification: Verification = {
      id: 'ver-1',
      from: 'did:key:alice',
      to: 'did:key:me',
      timestamp: new Date().toISOString(),
      proof: { type: 'Ed25519Signature2020', verificationMethod: '', created: '', proofPurpose: 'assertionMethod', proofValue: '' },
    }

    act(() => {
      result.current.setPendingIncoming({ verification, fromDid: 'did:key:alice' })
    })

    expect(result.current.pendingIncoming?.fromDid).toBe('did:key:alice')

    // setPendingIncoming(null) dismisses
    act(() => result.current.setPendingIncoming(null))
    expect(result.current.pendingIncoming).toBeNull()
  })

  it('triggerMutualDialog increments confettiKey', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    const initialKey = result.current.confettiKey
    act(() => {
      result.current.triggerMutualDialog({ name: 'Alice', did: 'did:key:alice' })
    })
    expect(result.current.confettiKey).toBe(initialKey + 1)
  })

  it('triggerAttestationDialog does not increment confettiKey', () => {
    const { result } = renderHook(() => useConfetti(), { wrapper })

    const initialKey = result.current.confettiKey
    act(() => {
      result.current.triggerAttestationDialog({
        attestationId: 'att-1',
        senderName: 'Alice',
        senderDid: 'did:key:alice',
        claim: 'Test',
      })
    })
    expect(result.current.confettiKey).toBe(initialKey)
  })
})
