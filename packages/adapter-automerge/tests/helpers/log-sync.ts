import { InMemoryDocLogStore } from '@web_of_trust/core/adapters'

/**
 * wot#386: the replication options of a production device. The relay accepts
 * only the log-sync path (log-entry, sync-request, control frames), so a test
 * that checks cross-device convergence must run in this mode — with a
 * broker-backed transport (`new InMemoryMessagingAdapter({ broker, socketId })`).
 *
 * The deviceId is store-bound (BLOCKER-1b): seed the store first, then wire.
 * Reuse the returned `docLogStore` when restarting the same device.
 */
export interface LogSyncOptions {
  docLogStore: InMemoryDocLogStore
  deviceId: string
}

export async function logSyncOptions(deviceId: string): Promise<LogSyncOptions> {
  const docLogStore = new InMemoryDocLogStore()
  await docLogStore.init()
  await docLogStore.setDeviceId(deviceId)
  return { docLogStore, deviceId }
}

/** Deterministic UUID-shaped deviceId from a single hex digit (e.g. 'a' → aaaaaaaa-aaaa-4aaa-8aaa-…). */
export function deviceIdFrom(hex: string): string {
  const h = hex.slice(0, 1)
  return `${h.repeat(8)}-${h.repeat(4)}-4${h.repeat(3)}-8${h.repeat(3)}-${h.repeat(12)}`
}
