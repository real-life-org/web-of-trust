import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CollectDeps } from '../src/debug/debugObservability'

// BiometricService.isEnrolledStrict is mocked so the keystore-status branch (incl. fail-closed) is
// deterministic and does not touch WebAuthn.
const isEnrolledStrict = vi.fn<[], Promise<boolean>>()
vi.mock('../src/services/BiometricService', () => ({
  BiometricService: { isEnrolledStrict: () => isEnrolledStrict() },
}))

const CORE = { impl: 'yjs', persistence: { errors: [] }, spaces: [], sync: { relay: {} }, automerge: {} }

function mockDeps(overrides: Partial<CollectDeps> = {}): CollectDeps {
  return {
    metrics: { getSnapshot: () => CORE as never },
    deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    did: 'did:key:z6MkExampleExampleExampleExampleExampleEx',
    docLogStore: {
      getStrictContiguousHeads: async () => ({ 'dev-a': 3 }),
      getSyncRequestHeads: async () => ({ 'dev-a': 4 }),
      getKnownHeads: async () => ({ 'dev-a': 5 }),
    },
    replication: {
      getSpaces: async () => [{ id: 'space-1', name: 'Test Space' }],
      getKeyGeneration: async () => 1,
    },
    outboxStore: { count: async () => 2 },
    ...overrides,
  }
}

beforeEach(() => {
  isEnrolledStrict.mockReset()
  isEnrolledStrict.mockResolvedValue(false)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  delete (globalThis as { __wotDebug?: unknown }).__wotDebug
})

/** Import the module fresh with a controlled build flag (it is a module-load-time const). */
async function loadModule(flag: string | undefined) {
  vi.resetModules()
  vi.stubEnv('VITE_WOT_DEBUG_OBSERVABILITY', flag ?? '')
  return import('../src/debug/debugObservability')
}

describe('collectDebugObservabilitySnapshot', () => {
  it('produces the fixed-field snapshot (deviceId, 3 distinct heads, gen, outbox, keystore, store presence)', async () => {
    const { collectDebugObservabilitySnapshot } = await import('../src/debug/debugObservability')
    isEnrolledStrict.mockResolvedValue(true)

    const snap = await collectDebugObservabilitySnapshot(mockDeps())

    expect(snap.deviceId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(snap.did).toContain('did:key:')
    expect(snap.outboxDepth).toBe(2)
    expect(snap.keystore.enrolled).toBe(true)
    expect(snap.spaces).toHaveLength(1)
    expect(snap.spaces[0]).toMatchObject({
      spaceId: 'space-1',
      name: 'Test Space',
      generation: 1,
      heads: { strictContiguous: { 'dev-a': 3 }, syncRequest: { 'dev-a': 4 }, known: { 'dev-a': 5 } },
    })
    // durable stores are listed by identity-scoped DB name (presence only, no counts on key store)
    expect(snap.durableStores.map((s) => s.name)).toEqual([
      `wot-doc-log:${snap.did}`,
      `wot-key-management:${snap.did}`,
      `wot-member-update-pending:${snap.did}`,
      `wot-message-id-history:${snap.did}`,
    ])
    expect(snap.core).toBe(CORE)
  })

  it('is FAIL-CLOSED on keystore error: a throw yields "error", never false', async () => {
    const { collectDebugObservabilitySnapshot } = await import('../src/debug/debugObservability')
    isEnrolledStrict.mockRejectedValue(new Error('WebAuthn unavailable'))

    const snap = await collectDebugObservabilitySnapshot(mockDeps())

    expect(snap.keystore.enrolled).toBe('error')
    expect(snap.keystore.enrolled).not.toBe(false)
  })

  it('a broken per-space read never blanks the whole snapshot (each read is guarded)', async () => {
    const { collectDebugObservabilitySnapshot } = await import('../src/debug/debugObservability')
    const snap = await collectDebugObservabilitySnapshot(mockDeps({
      replication: {
        getSpaces: async () => [{ id: 'space-1', name: 'S' }],
        getKeyGeneration: async () => { throw new Error('boom') },
      },
      docLogStore: {
        getStrictContiguousHeads: async () => { throw new Error('boom') },
        getSyncRequestHeads: async () => ({ 'dev-a': 4 }),
        getKnownHeads: async () => ({ 'dev-a': 5 }),
      },
    }))
    expect(snap.spaces[0].generation).toBe(-1)
    expect(snap.spaces[0].heads.strictContiguous).toEqual({})
    expect(snap.spaces[0].heads.syncRequest).toEqual({ 'dev-a': 4 })
  })

  it('NO SECRETS: neither the snapshot JSON nor the copy/export format leaks key material', async () => {
    const { collectDebugObservabilitySnapshot } = await import('../src/debug/debugObservability')
    const snap = await collectDebugObservabilitySnapshot(mockDeps())

    const forbiddenMarkers = [
      'spaceContentKey', 'spaceCapabilitySigningKey', 'signingSeed', 'signingKey',
      'privateKey', 'secretKey', 'mnemonic', 'passphrase', 'master-seed', 'masterSeed', 'capability',
    ]
    for (const format of [JSON.stringify(snap), JSON.stringify(snap, null, 2) /* copy/export */]) {
      for (const marker of forbiddenMarkers) {
        expect(format.toLowerCase()).not.toContain(marker.toLowerCase())
      }
      // No raw key-length base64url run once the legit public identifiers (deviceId + did) are
      // removed — a leaked 32-byte key would base64url-encode to a ~43-char run.
      const scrubbed = format.split(snap.deviceId).join('').split(snap.did).join('')
      expect(scrubbed).not.toMatch(/[A-Za-z0-9_-]{40,}/)
    }
  })
})

describe('gated channel (window.__wotDebug) + cleanup', () => {
  it('DEFAULT-OFF: without the flag the collector + window channel are NOT registered', async () => {
    const mod = await loadModule(undefined)
    expect(mod.DEBUG_OBSERVABILITY_ENABLED).toBe(false)

    mod.setDebugObservabilityCollector(async () => ({} as never))
    expect((globalThis as { __wotDebug?: unknown }).__wotDebug).toBeUndefined()
    expect(mod.getDebugObservabilityCollector()).toBeNull()
  })

  it('DEBUG-ON: with the flag, register binds window.__wotDebug; unregister deletes it (teardown)', async () => {
    const mod = await loadModule('1')
    expect(mod.DEBUG_OBSERVABILITY_ENABLED).toBe(true)

    const collector = async () => ({ did: 'did:key:zA' } as never)
    mod.setDebugObservabilityCollector(collector)
    expect((globalThis as { __wotDebug?: unknown }).__wotDebug).toBe(collector)
    expect(mod.getDebugObservabilityCollector()).toBe(collector)

    mod.setDebugObservabilityCollector(null)
    expect((globalThis as { __wotDebug?: unknown }).__wotDebug).toBeUndefined()
    expect(mod.getDebugObservabilityCollector()).toBeNull()
  })

  it('SYNC-NOTIFY: subscribe fires with the current collector immediately, then synchronously on every (un)register', async () => {
    const mod = await loadModule('1')
    const events: Array<'set' | 'clear'> = []
    const c1: () => Promise<never> = async () => ({} as never)

    mod.setDebugObservabilityCollector(c1)
    const unsub = mod.subscribeDebugObservability((collect) => events.push(collect ? 'set' : 'clear'))
    expect(events).toEqual(['set']) // immediate current-state fire (collector already registered)

    mod.setDebugObservabilityCollector(null) // unregister → SYNCHRONOUS notify (no async gap)
    expect(events).toEqual(['set', 'clear'])

    mod.setDebugObservabilityCollector(async () => ({} as never))
    expect(events).toEqual(['set', 'clear', 'set'])

    unsub()
    mod.setDebugObservabilityCollector(null)
    expect(events).toEqual(['set', 'clear', 'set']) // no notifications after unsubscribe
  })

  it('SYNC-NOTIFY default-off: subscribe is a no-op that never fires', async () => {
    const mod = await loadModule(undefined)
    const events: unknown[] = []
    const unsub = mod.subscribeDebugObservability(() => events.push(1))
    mod.setDebugObservabilityCollector(async () => ({} as never))
    expect(events).toEqual([])
    unsub()
  })

  it('STALE-CLOSURE: after identity switch the channel exposes ONLY the new identity (no predecessor leak)', async () => {
    const mod = await loadModule('1')
    type W = { __wotDebug?: () => Promise<{ did: string; deviceId: string }> }

    // Identity A registers, then the AdapterContext cleanup unregisters on switch.
    mod.setDebugObservabilityCollector(async () => ({ did: 'did:key:zAAA', deviceId: 'dev-A' } as never))
    mod.setDebugObservabilityCollector(null)
    expect((globalThis as W).__wotDebug).toBeUndefined()

    // Identity B re-registers fresh.
    mod.setDebugObservabilityCollector(async () => ({ did: 'did:key:zBBB', deviceId: 'dev-B' } as never))
    const out = await (globalThis as W).__wotDebug!()
    expect(out.did).toBe('did:key:zBBB')
    expect(out.deviceId).toBe('dev-B')
    expect(JSON.stringify(out)).not.toContain('zAAA')
    expect(JSON.stringify(out)).not.toContain('dev-A')
  })
})
