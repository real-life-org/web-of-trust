import {
  encryptOneShot,
  decryptOneShot,
  decodeBase64Url,
  classifySnapshotDisposition,
  type SnapshotDisposition,
  type SyncHeads,
} from '@web_of_trust/core/protocol'
import { crypto, deriveSpaceContentKey, utf8 } from './identity.js'
import {
  applyUpdate,
  exportRegisters,
  type CrdtDoc,
  type RegisterEntry,
  stateSnapshot,
} from './crdt-stub.js'

/**
 * Per-doc snapshot backup for BOTH personal and space docs (Plan-B durability).
 *
 * A snapshot is a CHECKPOINT, not a log replacement. The restore path is:
 *   load snapshot (classifySnapshotDisposition with its heads) THEN sync-request log
 *   entries SINCE the snapshot heads. A snapshot WITHOUT coverage-heads must NOT be
 *   treated as authoritative (it can only help CRDT merge and still needs log catch-up).
 */
export interface VaultSnapshot {
  docId: string
  keyGeneration: number
  /** opaque encrypted snapshot blob (encryptOneShot under the Space Content Key). */
  encryptedStateBase64Url: string
  /** coverage-heads: the (deviceId -> last seq) the snapshot includes. */
  heads?: SyncHeads
}

export class SimVault {
  private snapshots = new Map<string, VaultSnapshot>()

  /**
   * Store a snapshot of the doc's CURRENT state (FULL registers + causal metadata)
   * plus coverage-heads. The state blob is encrypted with `encryptOneShot` (random
   * nonce — NOT the deterministic log nonce); heads ride along as cleartext metadata
   * (they are not secret, exactly as on the wire). Persisting full registers (not
   * just visible values) is what lets a restore deep-converge across the snapshot
   * boundary and resolve post-snapshot overwrites by the same LWW rule as a full log.
   */
  async putSnapshot(params: {
    docId: string
    keyGeneration: number
    doc: CrdtDoc
    heads?: SyncHeads
  }): Promise<VaultSnapshot> {
    const spaceContentKey = await deriveSpaceContentKey(params.docId, params.keyGeneration)
    const plaintext = utf8(JSON.stringify({ registers: exportRegisters(params.doc) }))
    const enc = await encryptOneShot({ crypto, spaceContentKey, plaintext })
    const snap: VaultSnapshot = {
      docId: params.docId,
      keyGeneration: params.keyGeneration,
      encryptedStateBase64Url: enc.blobBase64Url,
      heads: params.heads,
    }
    this.snapshots.set(params.docId, snap)
    return snap
  }

  getSnapshot(docId: string): VaultSnapshot | undefined {
    return this.snapshots.get(docId)
  }

  /**
   * Classify a snapshot for restore. Mirrors the production decision: a snapshot is
   * NEVER an append-only-log replacement (markSnapshotProcessed === false), and
   * without coverage-heads it is only a crdt-merge helper that still needs log
   * catch-up (status 'crdt-merge-helper-only', action 'sync-request-log-catch-up').
   */
  classify(params: {
    snapshot: VaultSnapshot
    expectedDocId: string
    expectedKeyGeneration: number
    keyMaterial: 'available' | 'missing' | 'unavailable' | 'future'
  }): SnapshotDisposition {
    return classifySnapshotDisposition({
      expectedDocId: params.expectedDocId,
      expectedKeyGeneration: params.expectedKeyGeneration,
      keyMaterial: params.keyMaterial,
      snapshot: {
        docId: params.snapshot.docId,
        keyGeneration: params.snapshot.keyGeneration,
        heads: params.snapshot.heads,
      },
    })
  }

  /**
   * Decrypt + merge a snapshot into a doc as a CRDT helper. This does NOT mark the
   * snapshot as a log replacement; the caller MUST follow with log catch-up.
   *
   * Each register is replayed carrying its ORIGINAL (lamport, deviceId). So the
   * snapshot reconstructs byte-identical registers for the keys it covers, and a
   * later post-snapshot log entry for the same key wins iff it genuinely dominates
   * under LWW (lamport, then deviceId) — exactly how a full log replay would resolve
   * it. The snapshot is therefore a faithful, load-bearing compaction of the
   * pre-coverage-heads log, not a lossy visible-value approximation.
   */
  async mergeInto(doc: CrdtDoc, snapshot: VaultSnapshot): Promise<void> {
    for (const reg of await this.decodeRegisters(snapshot)) {
      applyUpdate(doc, utf8(JSON.stringify(reg)))
    }
  }

  /** Convenience for tests: visible state a snapshot would restore. */
  async restoredState(snapshot: VaultSnapshot): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const reg of await this.decodeRegisters(snapshot)) out[reg.key] = reg.value
    return out
  }

  private async decodeRegisters(snapshot: VaultSnapshot): Promise<RegisterEntry[]> {
    const spaceContentKey = await deriveSpaceContentKey(snapshot.docId, snapshot.keyGeneration)
    const blob = decodeBase64Url(snapshot.encryptedStateBase64Url)
    const plaintext = await decryptOneShot({ crypto, spaceContentKey, blob })
    return (JSON.parse(new TextDecoder().decode(plaintext)) as { registers: RegisterEntry[] }).registers
  }
}

// Re-export so callers can compare visible state if desired.
export { stateSnapshot }
