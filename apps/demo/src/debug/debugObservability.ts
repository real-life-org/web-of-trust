import type { DebugSnapshot } from '@web_of_trust/core/storage'
import { BiometricService } from '../services/BiometricService'

/**
 * D2 — In-App test-observability channel (Spur-B enabler).
 *
 * SENSITIVE, default-OFF: this surfaces deviceId, per-space log heads, the keystore-enrollment
 * STATUS, and the durable-store names — data the harmless core `window.wotDebug` deliberately
 * does NOT carry. The demo is deployed publicly (pages.dev + native), so EVERYTHING here is gated
 * behind an explicit build/env flag (analogous to `RELAY_DEBUG_STATS` for the relay). Without the
 * flag the collector + channel are NOT registered at all (not merely hidden): `window.__wotDebug`
 * is undefined and the `data-testid` element is absent from the DOM. Exposing this broadly in prod
 * must be a deliberate decision.
 *
 * NEVER surfaces a seed, raw key material, passphrase, keystore contents, or record payloads —
 * only status/counts/heads/ids.
 */
export const DEBUG_OBSERVABILITY_ENABLED = import.meta.env.VITE_WOT_DEBUG_OBSERVABILITY === '1'

/** The DOM marker the Spur-B / Playwright operator reads (its text is the JSON snapshot). */
export const WOT_DEBUG_JSON_TESTID = 'wot-debug-json'

/** Keystore enrollment status — fail-CLOSED: a throw is 'error' (never 'false', which would mask a residual entry). */
export type KeystoreStatus = boolean | 'error'

export interface DurableStorePresence {
  /** The IndexedDB database name (identity-scoped). */
  name: string
  /** Whether the DB exists on disk (survives app-kill), or 'unknown' if the browser can't enumerate. */
  present: boolean | 'unknown'
}

export interface SpaceObservable {
  spaceId: string
  name: string | null
  /** Current content-key generation (via replication; the key material is NEVER exposed). */
  generation: number
  /** Slice-B head semantics — three DISTINCT views (strict ≠ sync-cursor ≠ max). */
  heads: {
    strictContiguous: Record<string, number>
    syncRequest: Record<string, number>
    known: Record<string, number>
  }
}

export interface WotDebugSnapshot {
  /** The unchanged core DebugSnapshot (persistence/spaces/relay), merged for a single channel. */
  core: DebugSnapshot
  /** The store-resolved deviceId (nonce namespace identity) — sensitive → gated. */
  deviceId: string
  /** The identity DID this snapshot belongs to (so a stale-closure leak is detectable in tests). */
  did: string
  spaces: SpaceObservable[]
  /** Pending outbox depth. */
  outboxDepth: number
  keystore: { enrolled: KeystoreStatus }
  durableStores: DurableStorePresence[]
}

export type WotDebugCollector = () => Promise<WotDebugSnapshot>

// ── minimal structural deps (avoid coupling to concrete adapter classes) ──────────────
interface HeadsSource {
  getStrictContiguousHeads(docId: string): Promise<Record<string, number>>
  getSyncRequestHeads(docId: string): Promise<Record<string, number>>
  getKnownHeads(docId: string): Promise<Record<string, number>>
}
interface SpacesSource {
  getSpaces(): Promise<Array<{ id: string; name?: string }>>
  getKeyGeneration(spaceId: string): Promise<number>
}
interface OutboxSource {
  count(): Promise<number>
}

export interface CollectDeps {
  metrics: { getSnapshot(): DebugSnapshot }
  deviceId: string
  did: string
  docLogStore: HeadsSource
  replication: SpacesSource
  outboxStore: OutboxSource
}

/** Keystore STATUS only, fail-closed (a throw → 'error', never 'false'). */
async function keystoreStatus(): Promise<KeystoreStatus> {
  try {
    return await BiometricService.isEnrolledStrict()
  } catch {
    return 'error'
  }
}

/** Existence (not contents) of the identity's durable IndexedDB stores — key store: presence ONLY. */
async function durableStorePresence(did: string): Promise<DurableStorePresence[]> {
  const names = [
    `wot-doc-log:${did}`,
    `wot-key-management:${did}`,
    `wot-member-update-pending:${did}`,
    `wot-message-id-history:${did}`,
  ]
  let existing: Set<string> | null = null
  try {
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases()
      existing = new Set(dbs.map((d) => d.name).filter((n): n is string => typeof n === 'string'))
    }
  } catch {
    existing = null
  }
  return names.map((name) => ({ name, present: existing ? existing.has(name) : ('unknown' as const) }))
}

/**
 * Build the full app observability snapshot from the CURRENT identity's live instances. Every
 * per-space read is individually guarded so one broken space never blanks the whole snapshot.
 */
export async function collectDebugObservabilitySnapshot(deps: CollectDeps): Promise<WotDebugSnapshot> {
  const core = deps.metrics.getSnapshot()
  const spaces = await deps.replication.getSpaces().catch(() => [])
  const spaceObservables = await Promise.all(
    spaces.map(async (s): Promise<SpaceObservable> => ({
      spaceId: s.id,
      name: s.name ?? null,
      generation: await deps.replication.getKeyGeneration(s.id).catch(() => -1),
      heads: {
        strictContiguous: await deps.docLogStore.getStrictContiguousHeads(s.id).catch(() => ({})),
        syncRequest: await deps.docLogStore.getSyncRequestHeads(s.id).catch(() => ({})),
        known: await deps.docLogStore.getKnownHeads(s.id).catch(() => ({})),
      },
    })),
  )
  return {
    core,
    deviceId: deps.deviceId,
    did: deps.did,
    spaces: spaceObservables,
    outboxDepth: await deps.outboxStore.count().catch(() => -1),
    keystore: { enrolled: await keystoreStatus() },
    durableStores: await durableStorePresence(deps.did),
  }
}

// ── the gated channel (module singleton + window binding) ──────────────────────────────

let currentCollector: WotDebugCollector | null = null

interface DebugWindow {
  __wotDebug?: WotDebugCollector
}

/** Notified SYNCHRONOUSLY whenever the collector is (un)registered — the DebugPanel subscribes so
 *  the hidden `data-testid` DOM channel clears immediately on unregister, not on the next poll. */
type CollectorChangeListener = (collect: WotDebugCollector | null) => void
const listeners = new Set<CollectorChangeListener>()

/**
 * Register (or, with `null`, UNREGISTER) the app observability collector. No-op unless the flag is
 * set. Unregistering deletes `window.__wotDebug`, drops the collector reference, AND synchronously
 * notifies subscribers so no stale closure OR retained DOM snapshot can leak the PREVIOUS identity's
 * deviceId/DID/store-names/keystore-status after logout / identity-switch / adapter-reinit
 * (teardown = security surface — BOTH the window channel and the `data-testid` DOM channel). MUST
 * be called with `null` in the AdapterContext cleanup.
 */
export function setDebugObservabilityCollector(collect: WotDebugCollector | null): void {
  if (!DEBUG_OBSERVABILITY_ENABLED) return
  currentCollector = collect
  if (typeof window !== 'undefined') {
    const w = window as unknown as DebugWindow
    if (collect) w.__wotDebug = collect
    else delete w.__wotDebug
  }
  // Synchronous notify — the DebugPanel drops the retained snapshot in the SAME tick on unregister.
  for (const listener of listeners) listener(collect)
}

/**
 * Subscribe to collector (un)registration. Fires immediately with the current state, then on every
 * change. No-op (returns a no-op unsubscribe) when the flag is off. Used by the DebugPanel to clear
 * its snapshot synchronously the instant the collector is unregistered.
 */
export function subscribeDebugObservability(listener: CollectorChangeListener): () => void {
  if (!DEBUG_OBSERVABILITY_ENABLED) return () => {}
  listeners.add(listener)
  listener(currentCollector)
  return () => { listeners.delete(listener) }
}

/** The current collector (for the DebugPanel), or null when the flag is off / not registered. */
export function getDebugObservabilityCollector(): WotDebugCollector | null {
  return DEBUG_OBSERVABILITY_ENABLED ? currentCollector : null
}
