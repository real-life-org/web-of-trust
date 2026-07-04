import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import { InMemoryMessagingAdapter, InMemoryKeyManagementAdapter } from '@web_of_trust/core/adapters'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'

// I-READ guard parity (Automerge ≡ Yjs): replayBlockedByKeyForSpace wraps
// coordinator.replayBlockedByKey() with the SAME coalesce-with-trailing-rerun guard.
// Driven directly with a fake coordinator so the contract is verified deterministically.

interface FakeCoordinator {
  replayBlockedByKey: () => Promise<number>
}
interface GuardInternals {
  logSyncEnabled: boolean
  spaces: Map<string, unknown>
  coordinators: Map<string, FakeCoordinator>
  replayBlockedByKeyForSpace: (spaceId: string) => Promise<void>
  replayBlockedInFlight: Set<string>
  replayBlockedDirty: Set<string>
}

/** Register both a space (so the !spaces.has guard passes) and its fake coordinator. */
function wire(g: GuardInternals, spaceId: string, coordinator: FakeCoordinator): void {
  g.spaces.set(spaceId, {})
  g.coordinators.set(spaceId, coordinator)
}

const SPACE = '11111111-1111-4111-8111-111111111111'

describe('I-READ guard (Automerge parity): replayBlockedByKeyForSpace (coalesce-with-trailing-rerun)', () => {
  let alice: PublicIdentitySession
  let messaging: InMemoryMessagingAdapter
  let adapter: AutomergeReplicationAdapter
  let g: GuardInternals

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    alice = (await createTestIdentity('alice-guard-am')).identity
    messaging = new InMemoryMessagingAdapter()
    await messaging.connect(alice.getDid())
    adapter = new AutomergeReplicationAdapter({
      identity: alice,
      messaging,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
    })
    g = adapter as unknown as GuardInternals
    g.logSyncEnabled = true
  })
  afterEach(async () => {
    try { await adapter.stop() } catch { /* never started — ignore */ }
    InMemoryMessagingAdapter.resetAll()
    try { await alice.deleteStoredIdentity() } catch { /* ignore */ }
  })

  it('is a no-op (no throw) when no coordinator is registered for the space', async () => {
    await expect(g.replayBlockedByKeyForSpace(SPACE)).resolves.toBeUndefined()
    expect(g.replayBlockedInFlight.has(SPACE)).toBe(false)
  })

  it('coalesces a re-entrant call DURING an in-flight pass into EXACTLY ONE trailing rerun', async () => {
    let calls = 0
    let reentered = false
    wire(g, SPACE, {
      replayBlockedByKey: async () => {
        calls += 1
        if (!reentered) {
          reentered = true
          await g.replayBlockedByKeyForSpace(SPACE)
          expect(g.replayBlockedDirty.has(SPACE)).toBe(true)
          expect(calls).toBe(1)
        }
        return 0
      },
    })

    await g.replayBlockedByKeyForSpace(SPACE)

    expect(calls).toBe(2)
    expect(g.replayBlockedInFlight.has(SPACE)).toBe(false)
    expect(g.replayBlockedDirty.has(SPACE)).toBe(false)
  })

  it('does NOT replay a stale coordinator whose space was removed locally (defense-in-depth)', async () => {
    let calls = 0
    g.coordinators.set(SPACE, { replayBlockedByKey: async () => { calls += 1; return 0 } })
    await g.replayBlockedByKeyForSpace(SPACE)
    expect(calls).toBe(0)
    expect(g.replayBlockedInFlight.has(SPACE)).toBe(false)
  })

  it('releases the guard in finally on error AND still runs the trailing pass (dirty is never lost)', async () => {
    let calls = 0
    wire(g, SPACE, {
      replayBlockedByKey: async () => {
        calls += 1
        if (calls === 1) {
          void g.replayBlockedByKeyForSpace(SPACE)
          throw new Error('replay boom')
        }
        return 0
      },
    })

    await g.replayBlockedByKeyForSpace(SPACE)

    expect(calls).toBe(2)
    expect(g.replayBlockedInFlight.has(SPACE)).toBe(false)
    expect(g.replayBlockedDirty.has(SPACE)).toBe(false)
  })
})
