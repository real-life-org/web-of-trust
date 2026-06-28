/**
 * Slice A / VE-11 — REAL-relay Automerge client factory.
 *
 * Wires a REAL {@link AutomergeReplicationAdapter} (`enableLogSync:true`, NO vault,
 * NO CompactStore) to a REAL {@link WebSocketMessagingAdapter} against the
 * in-process RelayServer. Stores are injectable for cold-reconstruction (share the
 * key-management + metadata storage, supply a FRESH docLogStore + repoStorage).
 */
import { AutomergeReplicationAdapter, InMemoryRepoStorageAdapter } from '@web_of_trust/adapter-automerge'
import {
  InMemorySpaceMetadataStorage,
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

export interface AutomergeClient {
  identity: PublicIdentitySession
  deviceId: string
  adapter: AutomergeReplicationAdapter
  messaging: WebSocketMessagingAdapter
  probe: MessagingProbe
  keyManagement: InMemoryKeyManagementAdapter
  metadataStorage: InMemorySpaceMetadataStorage
  docLogStore: InMemoryDocLogStore
  repoStorage: InMemoryRepoStorageAdapter
  stop(): Promise<void>
}

export interface MakeAutomergeClientOptions {
  relay: StartedRelay
  identity: PublicIdentitySession
  deviceId?: string
  keyManagement?: InMemoryKeyManagementAdapter
  metadataStorage?: InMemorySpaceMetadataStorage
  docLogStore?: InMemoryDocLogStore
  repoStorage?: InMemoryRepoStorageAdapter
  capabilityValidityMs?: number
  noStart?: boolean
}

/**
 * Build + start a real Automerge client against the real relay.
 *
 * LEGACY ISOLATION: no `vault`/`vaultUrl`, NO CompactStore; convergence rides
 * sync-request + log-entry. Incoming content/full-state envelopes are blocked by
 * the messaging spy.
 */
export async function makeAutomergeClient(opts: MakeAutomergeClientOptions): Promise<AutomergeClient> {
  const keyManagement = opts.keyManagement ?? new InMemoryKeyManagementAdapter()
  const metadataStorage = opts.metadataStorage ?? new InMemorySpaceMetadataStorage()
  const docLogStore = opts.docLogStore ?? new InMemoryDocLogStore()
  const repoStorage = opts.repoStorage ?? new InMemoryRepoStorageAdapter()

  // BLOCKER-1b: the deviceId is OWNED by the durable log store and resolved FIRST,
  // so the messaging adapter registers with the SAME id the log path authors under
  // (the relay's author-binding requires log deviceId == registered deviceId). A
  // caller-pinned id seeds the store; otherwise the store mints one. A fresh store
  // (cold-reconstruction / clone) therefore yields a fresh nonce namespace.
  await docLogStore.init()
  if (opts.deviceId) await docLogStore.setDeviceId(opts.deviceId)
  const deviceId = await docLogStore.getOrCreateDeviceId()
  const { messaging, probe } = await connectMessaging(opts.relay.url, opts.identity, deviceId)

  const adapter = new AutomergeReplicationAdapter({
    identity: opts.identity,
    messaging,
    crypto: sharedCrypto,
    brokerUrls: BROKER_URLS,
    keyManagement,
    metadataStorage,
    repoStorage,
    // Slice A / VE-11: log path primary. NO vault, NO CompactStore (cold-start
    // rides sync-request + log-entry only).
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
    repoStorage,
    stop: async () => {
      await adapter.stop()
      await messaging.disconnect()
    },
  }
}
