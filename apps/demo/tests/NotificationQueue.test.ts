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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ConfettiProvider, useConfetti } from '../src/context/PendingVerificationContext'
import type { Attestation } from '@web_of_trust/core/types'

function wrapper({ children }: { children: React.ReactNode }) {
  return createElement(ConfettiProvider, null, children)
}

function regularFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) return regularFilesUnder(fullPath)
    return stats.isFile() ? [fullPath] : []
  })
}

describe('Notification Queue', () => {
  it('does not expose legacy pending verification API names in demo source or tests', () => {
    const demoRoot = existsSync('apps/demo/src') ? 'apps/demo' : '.'
    const blockedTerms = [
      ['Pending', 'Verification', 'Provider'].join(''),
      ['use', 'Pending', 'Verification'].join(''),
      ['Legacy', ' alias'].join(''),
    ]
    const files = [
      ...regularFilesUnder(join(demoRoot, 'src')),
      ...regularFilesUnder(join(demoRoot, 'tests')),
    ]

    const matches = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return blockedTerms
        .filter((term) => text.includes(term))
        .map((term) => `${file}: ${term}`)
    })

    expect(matches).toEqual([])
  })

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

    const attestation: Attestation = {
      id: 'att-1',
      from: 'did:key:alice',
      to: 'did:key:me',
      claim: 'in-person verifiziert',
      createdAt: new Date().toISOString(),
      vcJws: 'header.payload.signature',
    }

    act(() => {
      result.current.setPendingIncoming({ attestation, fromDid: 'did:key:alice' })
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
