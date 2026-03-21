import { describe, it, expect, beforeEach } from 'vitest'
import { DocStore } from '../src/store'

describe('DocStore', () => {
  let store: DocStore

  beforeEach(() => {
    store = new DocStore(':memory:')
  })

  describe('appendChange', () => {
    it('should append a change and return seq=1', () => {
      const seq = store.appendChange('doc1', Buffer.from('encrypted-data'), 'did:key:alice')
      expect(seq).toBe(1)
    })

    it('should increment sequence numbers', () => {
      const seq1 = store.appendChange('doc1', Buffer.from('data1'), 'did:key:alice')
      const seq2 = store.appendChange('doc1', Buffer.from('data2'), 'did:key:alice')
      const seq3 = store.appendChange('doc1', Buffer.from('data3'), 'did:key:bob')
      expect(seq1).toBe(1)
      expect(seq2).toBe(2)
      expect(seq3).toBe(3)
    })

    it('should maintain separate sequences per document', () => {
      const seqA = store.appendChange('docA', Buffer.from('data'), 'did:key:alice')
      const seqB = store.appendChange('docB', Buffer.from('data'), 'did:key:alice')
      expect(seqA).toBe(1)
      expect(seqB).toBe(1)
    })
  })

  describe('getChanges', () => {
    it('should return empty for unknown document', () => {
      const result = store.getChanges('unknown')
      expect(result.snapshot).toBeNull()
      expect(result.changes).toHaveLength(0)
    })

    it('should return all changes since seq=0', () => {
      store.appendChange('doc1', Buffer.from('data1'), 'did:key:alice')
      store.appendChange('doc1', Buffer.from('data2'), 'did:key:bob')

      const result = store.getChanges('doc1', 0)
      expect(result.changes).toHaveLength(2)
      expect(result.changes[0].seq).toBe(1)
      expect(result.changes[0].data.toString()).toBe('data1')
      expect(result.changes[0].authorDid).toBe('did:key:alice')
      expect(result.changes[1].seq).toBe(2)
      expect(result.changes[1].data.toString()).toBe('data2')
    })

    it('should return changes after a given seq', () => {
      store.appendChange('doc1', Buffer.from('data1'), 'did:key:alice')
      store.appendChange('doc1', Buffer.from('data2'), 'did:key:alice')
      store.appendChange('doc1', Buffer.from('data3'), 'did:key:alice')

      const result = store.getChanges('doc1', 2)
      expect(result.changes).toHaveLength(1)
      expect(result.changes[0].seq).toBe(3)
    })
  })

  describe('putSnapshot', () => {
    it('should store a snapshot and delete covered changes', () => {
      store.appendChange('doc1', Buffer.from('data1'), 'did:key:alice')
      store.appendChange('doc1', Buffer.from('data2'), 'did:key:alice')
      store.appendChange('doc1', Buffer.from('data3'), 'did:key:alice')

      store.putSnapshot('doc1', Buffer.from('snapshot'), 2, 'did:key:alice')

      // Getting from seq=0 should include snapshot + remaining changes
      const result = store.getChanges('doc1', 0)
      expect(result.snapshot).not.toBeNull()
      expect(result.snapshot!.data.toString()).toBe('snapshot')
      expect(result.snapshot!.upToSeq).toBe(2)
      expect(result.changes).toHaveLength(1)
      expect(result.changes[0].seq).toBe(3)
    })

    it('should continue sequence after snapshot', () => {
      store.appendChange('doc1', Buffer.from('data1'), 'did:key:alice')
      store.appendChange('doc1', Buffer.from('data2'), 'did:key:alice')
      store.putSnapshot('doc1', Buffer.from('snapshot'), 2, 'did:key:alice')

      const seq = store.appendChange('doc1', Buffer.from('data3'), 'did:key:alice')
      expect(seq).toBe(3)
    })

    it('should replace existing snapshot', () => {
      store.appendChange('doc1', Buffer.from('data1'), 'did:key:alice')
      store.putSnapshot('doc1', Buffer.from('snap1'), 1, 'did:key:alice')

      store.appendChange('doc1', Buffer.from('data2'), 'did:key:alice')
      store.appendChange('doc1', Buffer.from('data3'), 'did:key:alice')
      store.putSnapshot('doc1', Buffer.from('snap2'), 3, 'did:key:alice')

      const result = store.getChanges('doc1', 0)
      expect(result.snapshot!.data.toString()).toBe('snap2')
      expect(result.snapshot!.upToSeq).toBe(3)
      expect(result.changes).toHaveLength(0)
    })
  })

  describe('getInfo', () => {
    it('should return null for unknown document', () => {
      expect(store.getInfo('unknown')).toBeNull()
    })

    it('should return info for document with changes', () => {
      store.appendChange('doc1', Buffer.from('data1'), 'did:key:alice')
      store.appendChange('doc1', Buffer.from('data2'), 'did:key:alice')

      const info = store.getInfo('doc1')
      expect(info).not.toBeNull()
      expect(info!.latestSeq).toBe(2)
      expect(info!.snapshotSeq).toBeNull()
      expect(info!.changeCount).toBe(2)
    })

    it('should reflect snapshot in info', () => {
      store.appendChange('doc1', Buffer.from('data1'), 'did:key:alice')
      store.appendChange('doc1', Buffer.from('data2'), 'did:key:alice')
      store.putSnapshot('doc1', Buffer.from('snap'), 2, 'did:key:alice')
      store.appendChange('doc1', Buffer.from('data3'), 'did:key:alice')

      const info = store.getInfo('doc1')
      expect(info!.latestSeq).toBe(3)
      expect(info!.snapshotSeq).toBe(2)
      expect(info!.changeCount).toBe(1) // Only the one after snapshot
    })
  })

  describe('deleteDoc', () => {
    it('should delete all changes and snapshots', () => {
      store.appendChange('doc1', Buffer.from('data1'), 'did:key:alice')
      store.putSnapshot('doc1', Buffer.from('snap'), 1, 'did:key:alice')
      store.appendChange('doc1', Buffer.from('data2'), 'did:key:alice')

      store.deleteDoc('doc1')

      expect(store.getInfo('doc1')).toBeNull()
      const result = store.getChanges('doc1', 0)
      expect(result.snapshot).toBeNull()
      expect(result.changes).toHaveLength(0)
    })

    it('should not affect other documents', () => {
      store.appendChange('doc1', Buffer.from('data1'), 'did:key:alice')
      store.appendChange('doc2', Buffer.from('data2'), 'did:key:alice')

      store.deleteDoc('doc1')

      expect(store.getInfo('doc1')).toBeNull()
      expect(store.getInfo('doc2')).not.toBeNull()
    })
  })
})
