/**
 * Slice A / VE-11 — REAL-relay Yjs client factory.
 *
 * Wires a REAL {@link YjsReplicationAdapter} (`enableLogSync:true`, NO vault) to a
 * REAL {@link WebSocketMessagingAdapter} against the in-process RelayServer. The
 * per-client stores are injectable so a cold-reconstruction client can SHARE the
 * key-management + metadata storage of an already-invited identity while starting
 * with an EMPTY docLogStore + EMPTY CompactStore (forcing sync-request catch-up).
 */
import { YjsReplicationAdapter } from '@web_of_trust/adapter-yjs'
import {
  InMemorySpaceMetadataStorage,
  InMemoryCompactStore,
  InMemoryKeyManagementAdapter,
  InMemoryDocLogStore,
} from '@web_of_trust/core/adapters'
import type { PublicIdentitySession } from '@web_of_trust/core/application'
import type { WebSocketMessagingAdapter } from '@web_of_trust/core/adapters/messaging/websocket'
import {
  connectMessaging,
  sharedCrypto,
  type MessagingProbe,
  type StartedRelay,
} from './harness'

export const BROKER_URLS = ['wss://relay.e2e.example']

export interface YjsClient {
  identity: PublicIdentitySession
  deviceId: string
  adapter: YjsReplicationAdapter
  messaging: WebSocketMessagingAdapter
  probe: MessagingProbe
  keyManagement: InMemoryKeyManagementAdapter
  metadataStorage: InMemorySpaceMetadataStorage
  docLogStore: InMemoryDocLogStore
  compactStore: InMemoryCompactStore
  stop(): Promise<void>
}

export interface MakeYjsClientOptions {
  relay: StartedRelay
  identity: PublicIdentitySession
  deviceId?: string
  /** Share an existing key store (cold-start: same identity already holds the keys). */
  keyManagement?: InMemoryKeyManagementAdapter
  /** Share an existing metadata store (cold-start: the space is already known). */
  metadataStorage?: InMemorySpaceMetadataStorage
  /** Override the doc-log store (cold-start: pass a FRESH empty one). */
  docLogStore?: InMemoryDocLogStore
  /** Override the compact store (cold-start: pass a FRESH empty one). */
  compactStore?: InMemoryCompactStore
  /** Capability validity window override (for the validUntil-expiry test). */
  capabilityValidityMs?: number
  /** Do not call adapter.start() (caller controls lifecycle). Default: start. */
  noStart?: boolean
}

/**
 * Build + start a real Yjs client against the real relay.
 *
 * LEGACY ISOLATION: no `vault`/`vaultUrl` is passed; the content channel is
 * blocked by the messaging spy. Convergence MUST ride the log path.
 */
export async function makeYjsClient(opts: MakeYjsClientOptions): Promise<YjsClient> {
  const keyManagement = opts.keyManagement ?? new InMemoryKeyManagementAdapter()
  const metadataStorage = opts.metadataStorage ?? new InMemorySpaceMetadataStorage()
  const docLogStore = opts.docLogStore ?? new InMemoryDocLogStore()
  const compactStore = opts.compactStore ?? new InMemoryCompactStore()

  // BLOCKER-1b: the deviceId is OWNED by the durable log store and resolved FIRST,
  // so the messaging adapter registers with the SAME id the log path authors under
  // (the relay's author-binding requires log deviceId == registered deviceId). A
  // caller-pinned id seeds the store; otherwise the store mints one. A fresh store
  // (cold-reconstruction / clone) therefore yields a fresh nonce namespace.
  await docLogStore.init()
  if (opts.deviceId) await docLogStore.setDeviceId(opts.deviceId)
  const deviceId = await docLogStore.getOrCreateDeviceId()
  const { messaging, probe } = await connectMessaging(opts.relay.url, opts.identity, deviceId)

  const adapter = new YjsReplicationAdapter({
    identity: opts.identity,
    messaging,
    crypto: sharedCrypto,
    brokerUrls: BROKER_URLS,
    keyManagement,
    metadataStorage,
    compactStore,
    // Slice A / VE-11: log path is the primary steady-state path. NO vault — the
    // standalone-convergence + cold-reconstruction anchor (sync-request only).
    docLogStore,
    enableLogSync: true,
    deviceId,
    capabilityValidityMs: opts.capabilityValidityMs,
  })

  if (!opts.noStart) await adapter.start()

  return {
    identity: opts.identity,
    deviceId,
    adapter,
    messaging,
    probe,
    keyManagement,
    metadataStorage,
    docLogStore,
    compactStore,
    stop: async () => {
      await adapter.stop()
      await messaging.disconnect()
    },
  }
}
