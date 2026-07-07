import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * #237 — getMetrics()/getTraceLog() must return the SAME instance even when the
 * module exists more than once in the bundle (bundler chunk duplication: the demo
 * carries core/storage in the main chunk AND the dynamically imported adapter
 * chunks). A module-scoped singleton silently splits: AdapterContext fed one
 * metrics instance while window.wotDebug exposed another → the debug panel showed
 * "Relay: Disconnected" forever. vi.resetModules() simulates the duplication: two
 * imports yield two distinct module instances, whose getters MUST still resolve to
 * one shared object (anchored on globalThis).
 */
describe('#237 debug singletons survive module duplication', () => {
  afterEach(() => {
    delete (globalThis as { __wotPersistenceMetrics?: unknown }).__wotPersistenceMetrics
    delete (globalThis as { __wotTraceLog?: unknown }).__wotTraceLog
    vi.resetModules()
  })

  it('getMetrics returns one instance across two module copies', async () => {
    const copyA = await import('../src/storage/PersistenceMetrics')
    vi.resetModules()
    const copyB = await import('../src/storage/PersistenceMetrics')

    expect(copyA).not.toBe(copyB) // two REAL module instances (the duplication)
    const metricsA = copyA.getMetrics()
    const metricsB = copyB.getMetrics()
    expect(metricsA).toBe(metricsB)

    // The regression scenario: chunk A feeds the relay status, chunk B snapshots it.
    metricsA.setRelayStatus(true, 'wss://relay.example', 3)
    expect(metricsB.getSnapshot().sync.relay.connected).toBe(true)
  })

  it('getTraceLog returns one instance across two module copies', async () => {
    const copyA = await import('../src/storage/TraceLog')
    vi.resetModules()
    const copyB = await import('../src/storage/TraceLog')

    expect(copyA.getTraceLog()).toBe(copyB.getTraceLog())
  })
})
