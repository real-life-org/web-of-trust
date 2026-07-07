import { describe, expect, it, vi } from 'vitest'
import { DualVaultClient } from '../src/adapters/vault/DualVaultClient'
import type { VaultChangesResponse, VaultClient, VaultDocInfo } from '../src/adapters/vault/VaultClient'

// Stage A dual-vault semantics (#251, I-VAULT-SURVIVES + the loop-review
// seq-space blocker). The invariants under test:
//   - writes are best-effort fan-out: one vault failing never blocks the other;
//     throw only when ALL fail
//   - putSnapshot sends the SAME client-monotone upToSeq to every vault (that is
//     what makes snapshot upToSeq comparable across vaults on the merge-read)
//   - getChanges applies the `since` cursor to the PRIMARY ONLY — seqs are
//     vault-local, a cursor from one vault must never filter another vault's log
//   - getDocInfo returns ONE vault's info (first reachable with a doc), never a
//     cross-vault field mix — a max()-mix would hand consumers a cursor from a
//     foreign seq space
//   - deleteDoc is all-or-nothing (teardown is a security surface)

const DOC_ID = 'doc-under-test'

function change(seq: number, data: string): VaultChangesResponse['changes'][number] {
  return { seq, data, authorDid: 'did:key:z6MkAuthor', createdAt: '2026-07-07T10:00:00Z' }
}

function emptyResponse(): VaultChangesResponse {
  return { docId: DOC_ID, snapshot: null, changes: [] }
}

/** Structural fake — DualVaultClient only touches the VaultClientLike surface. */
function fakeVault(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    pushChange: vi.fn().mockResolvedValue(1),
    getChanges: vi.fn().mockResolvedValue(emptyResponse()),
    putSnapshot: vi.fn().mockResolvedValue(undefined),
    getDocInfo: vi.fn().mockResolvedValue(null),
    deleteDoc: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function dual(...vaults: ReturnType<typeof fakeVault>[]) {
  return new DualVaultClient(vaults as unknown as VaultClient[])
}

describe('DualVaultClient (Stage A dual-vault)', () => {
  it('rejects an empty target list', () => {
    expect(() => new DualVaultClient([])).toThrow('at least one vault')
  })

  describe('getChanges — seq-space consistency (loop-review blocker)', () => {
    it('applies `since` to the PRIMARY only; secondaries are read from 0', async () => {
      const primary = fakeVault()
      const secondary = fakeVault()
      await dual(primary, secondary).getChanges(DOC_ID, 42)
      expect(primary.getChanges).toHaveBeenCalledWith(DOC_ID, 42)
      expect(secondary.getChanges).toHaveBeenCalledWith(DOC_ID, 0)
    })

    it('merges the change sets and picks the newest snapshot by upToSeq', async () => {
      const primary = fakeVault({
        getChanges: vi.fn().mockResolvedValue({
          docId: DOC_ID,
          snapshot: { data: 'stale-primary', upToSeq: 5 },
          changes: [change(6, 'p6')],
        }),
      })
      const secondary = fakeVault({
        getChanges: vi.fn().mockResolvedValue({
          docId: DOC_ID,
          snapshot: { data: 'fresh-secondary', upToSeq: 9 },
          changes: [change(1, 's1'), change(2, 's2')],
        }),
      })
      const result = await dual(primary, secondary).getChanges(DOC_ID, 5)
      // A stale-but-reachable primary must lose against a fresher secondary.
      expect(result.snapshot).toEqual({ data: 'fresh-secondary', upToSeq: 9 })
      expect(result.changes.map((c) => c.data).sort()).toEqual(['p6', 's1', 's2'])
    })

    it('survives a dead primary: the secondary alone serves the read', async () => {
      const primary = fakeVault({ getChanges: vi.fn().mockRejectedValue(new Error('box is gone')) })
      const secondary = fakeVault({
        getChanges: vi.fn().mockResolvedValue({
          docId: DOC_ID,
          snapshot: { data: 'survivor', upToSeq: 3 },
          changes: [change(4, 's4')],
        }),
      })
      const result = await dual(primary, secondary).getChanges(DOC_ID, 42)
      expect(result.snapshot?.data).toBe('survivor')
      expect(result.changes).toHaveLength(1)
    })

    it('throws only when ALL vaults fail', async () => {
      const primary = fakeVault({ getChanges: vi.fn().mockRejectedValue(new Error('primary down')) })
      const secondary = fakeVault({ getChanges: vi.fn().mockRejectedValue(new Error('secondary down')) })
      await expect(dual(primary, secondary).getChanges(DOC_ID)).rejects.toThrow('primary down')
    })
  })

  describe('getDocInfo — no cross-vault field mix (loop-review blocker)', () => {
    it('returns the first reachable vault\'s info verbatim, ignoring higher seqs elsewhere', async () => {
      const primaryInfo: VaultDocInfo = { latestSeq: 3, snapshotSeq: 2, changeCount: 1 }
      const primary = fakeVault({ getDocInfo: vi.fn().mockResolvedValue(primaryInfo) })
      const secondary = fakeVault({
        getDocInfo: vi.fn().mockResolvedValue({ latestSeq: 100, snapshotSeq: 50, changeCount: 10 }),
      })
      // A max()-mix would report latestSeq 100 / snapshotSeq 50 — a cursor from a
      // foreign seq space. The consumer must see ONE vault's coherent view.
      await expect(dual(primary, secondary).getDocInfo(DOC_ID)).resolves.toEqual(primaryInfo)
    })

    it('falls through to the secondary when the primary is dead (post-camp path)', async () => {
      const primary = fakeVault({ getDocInfo: vi.fn().mockRejectedValue(new Error('box is gone')) })
      const secondaryInfo: VaultDocInfo = { latestSeq: 7, snapshotSeq: 7, changeCount: 0 }
      const secondary = fakeVault({ getDocInfo: vi.fn().mockResolvedValue(secondaryInfo) })
      await expect(dual(primary, secondary).getDocInfo(DOC_ID)).resolves.toEqual(secondaryInfo)
    })

    it('falls through to the secondary when the primary has no doc (freshly reset box)', async () => {
      // Yjs consumers are snapshot-only here, so adopting the secondary's view
      // while the primary is empty never mis-filters a primary read.
      const secondaryInfo: VaultDocInfo = { latestSeq: 12, snapshotSeq: 12, changeCount: 0 }
      const primary = fakeVault() // resolves null
      const secondary = fakeVault({ getDocInfo: vi.fn().mockResolvedValue(secondaryInfo) })
      await expect(dual(primary, secondary).getDocInfo(DOC_ID)).resolves.toEqual(secondaryInfo)
    })

    it('returns null when every vault is reachable but none has the doc', async () => {
      await expect(dual(fakeVault(), fakeVault()).getDocInfo(DOC_ID)).resolves.toBeNull()
    })

    it('throws only when ALL vaults fail', async () => {
      const primary = fakeVault({ getDocInfo: vi.fn().mockRejectedValue(new Error('primary down')) })
      const secondary = fakeVault({ getDocInfo: vi.fn().mockRejectedValue(new Error('secondary down')) })
      await expect(dual(primary, secondary).getDocInfo(DOC_ID)).rejects.toThrow('primary down')
    })
  })

  describe('putSnapshot — same upToSeq everywhere, best-effort', () => {
    it('sends the SAME client-monotone upToSeq to every vault', async () => {
      const primary = fakeVault()
      const secondary = fakeVault()
      const data = new Uint8Array([1, 2, 3])
      const nonce = new Uint8Array(12)
      await dual(primary, secondary).putSnapshot(DOC_ID, data, nonce, 17)
      expect(primary.putSnapshot).toHaveBeenCalledWith(DOC_ID, data, nonce, 17)
      expect(secondary.putSnapshot).toHaveBeenCalledWith(DOC_ID, data, nonce, 17)
    })

    it('does not throw while at least one vault accepts the snapshot', async () => {
      const primary = fakeVault({ putSnapshot: vi.fn().mockRejectedValue(new Error('box is gone')) })
      const secondary = fakeVault()
      await expect(
        dual(primary, secondary).putSnapshot(DOC_ID, new Uint8Array(1), new Uint8Array(12), 1),
      ).resolves.toBeUndefined()
      expect(secondary.putSnapshot).toHaveBeenCalledOnce()
    })

    it('throws only when ALL vaults reject', async () => {
      const primary = fakeVault({ putSnapshot: vi.fn().mockRejectedValue(new Error('primary down')) })
      const secondary = fakeVault({ putSnapshot: vi.fn().mockRejectedValue(new Error('secondary down')) })
      await expect(
        dual(primary, secondary).putSnapshot(DOC_ID, new Uint8Array(1), new Uint8Array(12), 1),
      ).rejects.toThrow('primary down')
    })
  })

  describe('pushChange — fan-out, primary seq preferred', () => {
    it('writes to every vault and returns the primary\'s vault-local seq', async () => {
      const primary = fakeVault({ pushChange: vi.fn().mockResolvedValue(7) })
      const secondary = fakeVault({ pushChange: vi.fn().mockResolvedValue(99) })
      await expect(dual(primary, secondary).pushChange(DOC_ID, new Uint8Array(1))).resolves.toBe(7)
      expect(primary.pushChange).toHaveBeenCalledOnce()
      expect(secondary.pushChange).toHaveBeenCalledOnce()
    })

    it('returns the first successful secondary seq when the primary fails', async () => {
      const primary = fakeVault({ pushChange: vi.fn().mockRejectedValue(new Error('box is gone')) })
      const secondary = fakeVault({ pushChange: vi.fn().mockResolvedValue(99) })
      await expect(dual(primary, secondary).pushChange(DOC_ID, new Uint8Array(1))).resolves.toBe(99)
    })

    it('throws only when ALL vaults fail', async () => {
      const primary = fakeVault({ pushChange: vi.fn().mockRejectedValue(new Error('primary down')) })
      const secondary = fakeVault({ pushChange: vi.fn().mockRejectedValue(new Error('secondary down')) })
      await expect(dual(primary, secondary).pushChange(DOC_ID, new Uint8Array(1))).rejects.toThrow('primary down')
    })
  })

  describe('deleteDoc — all-or-nothing (teardown security)', () => {
    it('resolves only when EVERY vault confirmed the deletion', async () => {
      const primary = fakeVault()
      const secondary = fakeVault()
      await expect(dual(primary, secondary).deleteDoc(DOC_ID)).resolves.toBeUndefined()
      expect(primary.deleteDoc).toHaveBeenCalledWith(DOC_ID)
      expect(secondary.deleteDoc).toHaveBeenCalledWith(DOC_ID)
    })

    it('throws when ANY vault fails — deletion must not silently half-succeed', async () => {
      const primary = fakeVault()
      const secondary = fakeVault({ deleteDoc: vi.fn().mockRejectedValue(new Error('secondary kept the doc')) })
      await expect(dual(primary, secondary).deleteDoc(DOC_ID)).rejects.toThrow('secondary kept the doc')
    })
  })
})
