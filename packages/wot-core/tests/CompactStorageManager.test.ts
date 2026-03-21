import { describe, it, expect, beforeEach } from 'vitest'
import { CompactStorageManager } from '../src/storage/CompactStorageManager'

describe('CompactStorageManager', () => {
  let store: CompactStorageManager
  let dbCounter = 0

  beforeEach(async () => {
    // Each test gets a unique IDB name to avoid shared state
    store = new CompactStorageManager(`test-compact-store-${++dbCounter}`)
    await store.open()
  })

  describe('save + load', () => {
    it('should roundtrip binary data', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      await store.save('doc-1', data)

      const loaded = await store.load('doc-1')
      expect(loaded).toEqual(data)
    })

    it('should return null for non-existent doc', async () => {
      const loaded = await store.load('does-not-exist')
      expect(loaded).toBeNull()
    })

    it('should overwrite on repeated save (latest wins)', async () => {
      await store.save('doc-1', new Uint8Array([1, 2, 3]))
      await store.save('doc-1', new Uint8Array([4, 5, 6]))

      const loaded = await store.load('doc-1')
      expect(loaded).toEqual(new Uint8Array([4, 5, 6]))
    })

    it('should store multiple docs independently', async () => {
      await store.save('doc-a', new Uint8Array([10]))
      await store.save('doc-b', new Uint8Array([20]))

      expect(await store.load('doc-a')).toEqual(new Uint8Array([10]))
      expect(await store.load('doc-b')).toEqual(new Uint8Array([20]))
    })

    it('should handle empty binary', async () => {
      await store.save('doc-empty', new Uint8Array(0))

      const loaded = await store.load('doc-empty')
      expect(loaded).toEqual(new Uint8Array(0))
    })

    it('should handle large binary (~100KB)', async () => {
      const large = new Uint8Array(100_000)
      for (let i = 0; i < large.length; i++) large[i] = i % 256
      await store.save('doc-large', large)

      const loaded = await store.load('doc-large')
      expect(loaded).toEqual(large)
    })
  })

  describe('delete', () => {
    it('should delete existing doc', async () => {
      await store.save('doc-1', new Uint8Array([1]))
      await store.delete('doc-1')

      expect(await store.load('doc-1')).toBeNull()
    })

    it('should not throw when deleting non-existent doc', async () => {
      await expect(store.delete('nope')).resolves.not.toThrow()
    })

    it('should not affect other docs', async () => {
      await store.save('doc-a', new Uint8Array([1]))
      await store.save('doc-b', new Uint8Array([2]))
      await store.delete('doc-a')

      expect(await store.load('doc-a')).toBeNull()
      expect(await store.load('doc-b')).toEqual(new Uint8Array([2]))
    })
  })

  describe('list', () => {
    it('should return empty array initially', async () => {
      expect(await store.list()).toEqual([])
    })

    it('should return all stored docIds', async () => {
      await store.save('doc-a', new Uint8Array([1]))
      await store.save('doc-b', new Uint8Array([2]))
      await store.save('doc-c', new Uint8Array([3]))

      const ids = await store.list()
      expect(ids.sort()).toEqual(['doc-a', 'doc-b', 'doc-c'])
    })

    it('should not include deleted docs', async () => {
      await store.save('doc-a', new Uint8Array([1]))
      await store.save('doc-b', new Uint8Array([2]))
      await store.delete('doc-a')

      expect(await store.list()).toEqual(['doc-b'])
    })

    it('should not have duplicates after overwrite', async () => {
      await store.save('doc-1', new Uint8Array([1]))
      await store.save('doc-1', new Uint8Array([2]))

      expect(await store.list()).toEqual(['doc-1'])
    })
  })

  describe('close', () => {
    it('should be closeable', () => {
      expect(() => store.close()).not.toThrow()
    })
  })
})
