// In-memory backend of the seed vault for tests and the harness: same transaction semantics
// (all writes of one transaction apply together or not at all), values deep-copied through
// structuredClone like IndexedDB does. The maps outlive a runtime, so a test can "restart" over them.

import type { VaultBackend, VaultStore, VaultTx } from './vault'

export interface MemoryVaultBackend extends VaultBackend {
  readonly stores: Record<VaultStore, Map<string, unknown>>
  /** called inside every write transaction before it commits; throwing aborts it (fault injection) */
  beforeCommit: ((writes: readonly { store: VaultStore; key: string; value: unknown }[]) => void) | null
}

export function memoryVaultBackend(): MemoryVaultBackend {
  const stores: Record<VaultStore, Map<string, unknown>> = { vaults: new Map(), meta: new Map() }
  const backend: MemoryVaultBackend = {
    stores,
    beforeCommit: null,
    async read(fn) {
      const tx: VaultTx = {
        get: async (s, k) => structuredClone(stores[s].get(k)),
        keys: async (s) => [...stores[s].keys()],
        put: () => {
          throw new Error('read-only transaction')
        },
        delete: () => {
          throw new Error('read-only transaction')
        },
      }
      return fn(tx)
    },
    async write(fn) {
      const writes: { store: VaultStore; key: string; value: unknown }[] = []
      const view = (s: VaultStore, k: string): unknown => {
        for (let i = writes.length - 1; i >= 0; i--) {
          const w = writes[i]
          if (w && w.store === s && w.key === k) return w.value
        }
        return stores[s].get(k)
      }
      const tx: VaultTx = {
        get: async (s, k) => structuredClone(view(s, k)),
        keys: async (s) => {
          const keys = new Set(stores[s].keys())
          for (const w of writes) {
            if (w.store !== s) continue
            if (w.value === undefined) keys.delete(w.key)
            else keys.add(w.key)
          }
          return [...keys]
        },
        put: (s, k, v) => void writes.push({ store: s, key: k, value: structuredClone(v) }),
        delete: (s, k) => void writes.push({ store: s, key: k, value: undefined }),
      }
      const result = await fn(tx)
      backend.beforeCommit?.(writes)
      for (const w of writes) {
        if (w.value === undefined) stores[w.store].delete(w.key)
        else stores[w.store].set(w.key, w.value)
      }
      return result
    },
  }
  return backend
}
