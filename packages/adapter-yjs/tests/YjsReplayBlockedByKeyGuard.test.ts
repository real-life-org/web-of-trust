import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import { InMemoryMessagingAdapter, InMemoryKeyManagementAdapter } from '@web_of_trust/core/adapters'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

// I-READ guard unit tests ("Key-available ⇒ replayBlockedByKey"): the adapter's
// replayBlockedByKeyForSpace wraps coordinator.replayBlockedByKey() with a
// coalesce-with-trailing-rerun reentrancy guard. These tests drive the guard directly
// with a fake coordinator (no full sync stack) so the inFlight/dirty/trailing-rerun
// contract is verified deterministically. The end-to-end replay through the real key
// paths is covered by the (currently fixme) key-rotation-multi-device E2E — that E2E is
// blocked by a SEPARATE upstream issue (gen=1 distribution to the 2nd device), not by
// this guard, so the guard is validated here in isolation.

interface FakeCoordinator {
  replayBlockedByKey: () => Promise<number>
}
interface GuardInternals {
  logSyncEnabled: boolean
  coordinators: Map<string, FakeCoordinator>
  replayBlockedByKeyForSpace: (spaceId: string) => Promise<void>
  replayBlockedInFlight: Set<string>
  replayBlockedDirty: Set<string>
}

const SPACE = '11111111-1111-4111-8111-111111111111'

describe('I-READ guard: replayBlockedByKeyForSpace (coalesce-with-trailing-rerun)', () => {
  let alice: PublicIdentitySession
  let messaging: InMemoryMessagingAdapter
  let adapter: YjsReplicationAdapter
  let g: GuardInternals

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    alice = (await createTestIdentity('alice-guard')).identity
    messaging = new InMemoryMessagingAdapter()
    await messaging.connect(alice.getDid())
    adapter = new YjsReplicationAdapter({
      identity: alice,
      messaging,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
    })
    g = adapter as unknown as GuardInternals
    // Force the log-sync path on (readonly is compile-time only; the guard short-circuits
    // when logSyncEnabled is false). The guard only touches coordinators + the two Sets.
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

  it('runs the coordinator replay; sequential calls are each honored (idempotent) and leave the guard clean', async () => {
    let calls = 0
    g.coordinators.set(SPACE, { replayBlockedByKey: async () => { calls += 1; return 0 } })

    await g.replayBlockedByKeyForSpace(SPACE)
    await g.replayBlockedByKeyForSpace(SPACE)

    expect(calls).toBe(2)
    expect(g.replayBlockedInFlight.has(SPACE)).toBe(false)
    expect(g.replayBlockedDirty.has(SPACE)).toBe(false)
  })

  it('coalesces a re-entrant call DURING an in-flight pass into EXACTLY ONE trailing rerun', async () => {
    let calls = 0
    let reentered = false
    g.coordinators.set(SPACE, {
      replayBlockedByKey: async () => {
        calls += 1
        if (!reentered) {
          reentered = true
          // A concurrent call WHILE this pass is in-flight must NOT start a second pass —
          // it sets dirty and returns immediately (coalesce, no queue).
          await g.replayBlockedByKeyForSpace(SPACE)
          expect(g.replayBlockedDirty.has(SPACE)).toBe(true)
          expect(calls).toBe(1) // the re-entrant call did NOT run the replay again
        }
        return 0
      },
    })

    await g.replayBlockedByKeyForSpace(SPACE)

    // pass 1 + exactly one trailing rerun (driven by the coalesced dirty) = 2; no more.
    expect(calls).toBe(2)
    expect(g.replayBlockedInFlight.has(SPACE)).toBe(false)
    expect(g.replayBlockedDirty.has(SPACE)).toBe(false)
  })

  it('releases the guard in finally on error AND still runs the trailing pass (dirty is never lost)', async () => {
    let calls = 0
    g.coordinators.set(SPACE, {
      replayBlockedByKey: async () => {
        calls += 1
        if (calls === 1) {
          // Concurrent call during the in-flight (about-to-fail) pass → sets dirty.
          void g.replayBlockedByKeyForSpace(SPACE)
          throw new Error('replay boom') // pass 1 throws — guard MUST still release + drain dirty
        }
        return 0
      },
    })

    await g.replayBlockedByKeyForSpace(SPACE)

    // The throw was caught; the guard released inFlight in finally and the coalesced dirty
    // still drove exactly one trailing pass.
    expect(calls).toBe(2)
    expect(g.replayBlockedInFlight.has(SPACE)).toBe(false)
    expect(g.replayBlockedDirty.has(SPACE)).toBe(false)
  })

  it('does not leak in-flight state across different spaces (the guard is per-space)', async () => {
    const SPACE_B = '22222222-2222-4222-8222-222222222222'
    let aCalls = 0
    let bCalls = 0
    g.coordinators.set(SPACE, { replayBlockedByKey: async () => { aCalls += 1; return 0 } })
    g.coordinators.set(SPACE_B, { replayBlockedByKey: async () => { bCalls += 1; return 0 } })

    await Promise.all([g.replayBlockedByKeyForSpace(SPACE), g.replayBlockedByKeyForSpace(SPACE_B)])

    expect(aCalls).toBe(1)
    expect(bCalls).toBe(1)
    expect(g.replayBlockedInFlight.size).toBe(0)
    expect(g.replayBlockedDirty.size).toBe(0)
  })
})
