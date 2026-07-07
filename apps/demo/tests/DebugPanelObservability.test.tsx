import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

// The debug flag + the DebugPanel bind the flag at module load, so each case imports them fresh
// with the env stubbed. Verifies the DOM-level gating (mount matrix + data-testid presence).

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.resetModules()
  delete (globalThis as { __wotDebug?: unknown }).__wotDebug
})

async function loadPanel(flag: string | undefined) {
  vi.resetModules()
  vi.stubEnv('VITE_WOT_DEBUG_OBSERVABILITY', flag ?? '')
  const obs = await import('../src/debug/debugObservability')
  const { DebugPanel } = await import('../src/components/debug/DebugPanel')
  return { obs, DebugPanel }
}

const SNAP = {
  core: {},
  deviceId: 'test-device-id-xyz',
  did: 'did:key:zTestTestTest',
  spaces: [],
  outboxDepth: 0,
  keystore: { enrolled: false },
  durableStores: [],
}

const SNAP_B = { ...SNAP, deviceId: 'device-B-id', did: 'did:key:zBBB' }

/** A collector whose promise resolves only when `resolve()` is called (models a slow in-flight read). */
function deferredCollector(snapshot: unknown) {
  let resolve!: () => void
  const gate = new Promise<void>((r) => { resolve = r })
  const collector = async () => { await gate; return snapshot as never }
  return { collector, resolve }
}

describe('DebugPanel D2 observability — DOM gating', () => {
  it('DEFAULT-OFF: the data-testid JSON element is NOT in the DOM without the flag', async () => {
    const { obs, DebugPanel } = await loadPanel(undefined)
    // Even if some caller tries to register, gating no-ops it.
    obs.setDebugObservabilityCollector(async () => SNAP as never)
    render(<DebugPanel />)
    expect(screen.queryByTestId('wot-debug-json')).toBeNull()
  })

  it('DEBUG-ON: the data-testid JSON element appears with the snapshot once a collector is registered', async () => {
    const { obs, DebugPanel } = await loadPanel('1')
    obs.setDebugObservabilityCollector(async () => SNAP as never)
    render(<DebugPanel />)
    const el = await screen.findByTestId('wot-debug-json', {}, { timeout: 3000 })
    expect(el.textContent).toContain('test-device-id-xyz')
    expect(el.textContent).toContain('did:key:zTestTestTest')
  })

  it('clears the data-testid element SYNCHRONOUSLY when the collector is unregistered (no stale-identity gap)', async () => {
    const { obs, DebugPanel } = await loadPanel('1')
    obs.setDebugObservabilityCollector(async () => SNAP as never)
    render(<DebugPanel />)
    expect((await screen.findByTestId('wot-debug-json', {}, { timeout: 3000 })).textContent).toContain('test-device-id-xyz')

    // Identity-switch / logout unregisters the collector → the panel must drop the retained snapshot
    // in the SAME tick (synchronous notify), NOT on the next 2s poll. Assert immediately (no waitFor).
    act(() => { obs.setDebugObservabilityCollector(null) })
    expect(screen.queryByTestId('wot-debug-json')).toBeNull()
  })

  it('a still-in-flight collector that resolves AFTER unregister must NOT re-populate the DOM channel', async () => {
    const { obs, DebugPanel } = await loadPanel('1')
    // Identity A's collect() is slow (in-flight when the switch happens).
    const a = deferredCollector(SNAP)
    obs.setDebugObservabilityCollector(a.collector)
    render(<DebugPanel />)
    // Unregister (identity-switch/logout) BEFORE A's read resolves → DOM channel empty.
    act(() => { obs.setDebugObservabilityCollector(null) })
    expect(screen.queryByTestId('wot-debug-json')).toBeNull()

    // A's read now resolves late — its generation is stale, so it must be dropped: DOM stays empty.
    await act(async () => { a.resolve(); await a.collector() })
    expect(screen.queryByTestId('wot-debug-json')).toBeNull()
  })

  it('a still-in-flight collector A must NOT overwrite a newer collector B that resolved first', async () => {
    const { obs, DebugPanel } = await loadPanel('1')
    const a = deferredCollector(SNAP) // A: deviceId 'test-device-id-xyz'
    obs.setDebugObservabilityCollector(a.collector)
    render(<DebugPanel />)

    // B registers (fresh identity) and resolves immediately → DOM shows B.
    await act(async () => { obs.setDebugObservabilityCollector(async () => SNAP_B as never) })
    expect((await screen.findByTestId('wot-debug-json', {}, { timeout: 3000 })).textContent).toContain('device-B-id')

    // A finally resolves — stale generation → dropped: DOM must still show B, never A.
    await act(async () => { a.resolve(); await a.collector() })
    const el = screen.getByTestId('wot-debug-json')
    expect(el.textContent).toContain('device-B-id')
    expect(el.textContent).not.toContain('test-device-id-xyz')
  })

  it('DEBUG-ON but no collector registered: no data-testid (channel gated on an actual collector)', async () => {
    const { DebugPanel } = await loadPanel('1')
    render(<DebugPanel />)
    // Give the poll a couple ticks; with no collector, appSnapshot stays null → no element.
    await new Promise((r) => setTimeout(r, 100))
    expect(screen.queryByTestId('wot-debug-json')).toBeNull()
  })
})
