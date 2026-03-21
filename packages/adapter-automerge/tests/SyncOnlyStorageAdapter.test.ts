import { describe, it, expect, beforeEach } from 'vitest'
import { SyncOnlyStorageAdapter } from '../src/SyncOnlyStorageAdapter'

/**
 * SyncOnlyStorageAdapter sits between automerge-repo and IndexedDB.
 * It only persists sync-state keys — all doc data (snapshots, incrementals) is ignored.
 * This prevents the chunk accumulation bug that causes WASM OOM crashes.
 *
 * Key format from automerge-repo:
 *   [docId, "snapshot", hash]      → doc data, IGNORED
 *   [docId, "incremental", hash]   → doc data, IGNORED
 *   [docId, "sync-state", peerId]  → sync state, PERSISTED
 */
describe('SyncOnlyStorageAdapter', () => {
  let adapter: SyncOnlyStorageAdapter
  let dbCounter = 0

  beforeEach(async () => {
    adapter = new SyncOnlyStorageAdapter(`test-sync-only-${++dbCounter}`)
    await adapter.ready()
  })

  const DOC_ID = 'doc-abc123'
  const PEER_ID = 'peer-xyz'

  describe('sync-state keys (persisted)', () => {
    it('should save and load sync-state', async () => {
      const key = [DOC_ID, 'sync-state', PEER_ID]
      const data = new Uint8Array([1, 2, 3])

      await adapter.save(key, data)
      const loaded = await adapter.load(key)

      expect(loaded).toEqual(data)
    })

    it('should return undefined for unknown sync-state', async () => {
      const loaded = await adapter.load([DOC_ID, 'sync-state', 'unknown-peer'])
      expect(loaded).toBeUndefined()
    })

    it('should overwrite sync-state on repeated save', async () => {
      const key = [DOC_ID, 'sync-state', PEER_ID]

      await adapter.save(key, new Uint8Array([1]))
      await adapter.save(key, new Uint8Array([2]))

      expect(await adapter.load(key)).toEqual(new Uint8Array([2]))
    })

    it('should remove sync-state', async () => {
      const key = [DOC_ID, 'sync-state', PEER_ID]
      await adapter.save(key, new Uint8Array([1]))

      await adapter.remove(key)
      expect(await adapter.load(key)).toBeUndefined()
    })

    it('should load range of sync-states for a doc', async () => {
      await adapter.save([DOC_ID, 'sync-state', 'peer-a'], new Uint8Array([1]))
      await adapter.save([DOC_ID, 'sync-state', 'peer-b'], new Uint8Array([2]))
      await adapter.save(['other-doc', 'sync-state', 'peer-c'], new Uint8Array([3]))

      const chunks = await adapter.loadRange([DOC_ID, 'sync-state'])

      expect(chunks).toHaveLength(2)
      const keys = chunks.map(c => c.key)
      expect(keys).toContainEqual([DOC_ID, 'sync-state', 'peer-a'])
      expect(keys).toContainEqual([DOC_ID, 'sync-state', 'peer-b'])
    })

    it('should remove range of sync-states', async () => {
      await adapter.save([DOC_ID, 'sync-state', 'peer-a'], new Uint8Array([1]))
      await adapter.save([DOC_ID, 'sync-state', 'peer-b'], new Uint8Array([2]))

      await adapter.removeRange([DOC_ID, 'sync-state'])

      expect(await adapter.load([DOC_ID, 'sync-state', 'peer-a'])).toBeUndefined()
      expect(await adapter.load([DOC_ID, 'sync-state', 'peer-b'])).toBeUndefined()
    })
  })

  describe('doc keys (ignored)', () => {
    it('should ignore snapshot saves', async () => {
      const key = [DOC_ID, 'snapshot', 'sha256-abc']
      await adapter.save(key, new Uint8Array([1, 2, 3]))

      const loaded = await adapter.load(key)
      expect(loaded).toBeUndefined()
    })

    it('should ignore incremental saves', async () => {
      const key = [DOC_ID, 'incremental', 'sha256-def']
      await adapter.save(key, new Uint8Array([4, 5, 6]))

      const loaded = await adapter.load(key)
      expect(loaded).toBeUndefined()
    })

    it('should return empty range for doc prefix', async () => {
      await adapter.save([DOC_ID, 'snapshot', 'hash1'], new Uint8Array([1]))
      await adapter.save([DOC_ID, 'incremental', 'hash2'], new Uint8Array([2]))

      const chunks = await adapter.loadRange([DOC_ID, 'snapshot'])
      expect(chunks).toEqual([])

      const chunks2 = await adapter.loadRange([DOC_ID, 'incremental'])
      expect(chunks2).toEqual([])
    })

    it('should not throw on remove of ignored keys', async () => {
      await expect(adapter.remove([DOC_ID, 'snapshot', 'hash1'])).resolves.not.toThrow()
      await expect(adapter.removeRange([DOC_ID, 'incremental'])).resolves.not.toThrow()
    })
  })

  describe('mixed operations', () => {
    it('should persist sync-state while ignoring doc data', async () => {
      // Save both doc data and sync state
      await adapter.save([DOC_ID, 'snapshot', 'hash1'], new Uint8Array([10]))
      await adapter.save([DOC_ID, 'incremental', 'hash2'], new Uint8Array([20]))
      await adapter.save([DOC_ID, 'sync-state', PEER_ID], new Uint8Array([30]))

      // Only sync-state should be loadable
      expect(await adapter.load([DOC_ID, 'snapshot', 'hash1'])).toBeUndefined()
      expect(await adapter.load([DOC_ID, 'incremental', 'hash2'])).toBeUndefined()
      expect(await adapter.load([DOC_ID, 'sync-state', PEER_ID])).toEqual(new Uint8Array([30]))
    })

    it('loadRange with doc prefix should return only sync-states', async () => {
      await adapter.save([DOC_ID, 'snapshot', 'hash1'], new Uint8Array([10]))
      await adapter.save([DOC_ID, 'sync-state', 'peer-a'], new Uint8Array([30]))

      // loadRange([DOC_ID]) matches all keys starting with DOC_ID
      // but only sync-state keys should be stored
      const chunks = await adapter.loadRange([DOC_ID])
      expect(chunks).toHaveLength(1)
      expect(chunks[0].key).toEqual([DOC_ID, 'sync-state', 'peer-a'])
    })
  })
})
