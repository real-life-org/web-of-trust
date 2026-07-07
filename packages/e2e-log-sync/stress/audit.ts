/**
 * Festival-Scale-Stress — wire-level ZERO-LOSS audit.
 *
 * seq-contiguity is NOT a valid zero-loss criterion (VE-C2 deliberately re-emits a
 * KEY_GENERATION_STALE write under a NEW seq; the old seq is never stored at the
 * broker → a healthy rotated space shows broker-confirmed gaps). So zero-loss is
 * proven over LOGICAL writeIds:
 *
 *   1. Pull every log-entry JWS of a space from the relay, paginated (explicit heads
 *      cursor advanced from the DECODED entries — NOT response.body.heads, which are
 *      broker-wide MAX heads that would skip entries).
 *   2. verify (verifyLogEntryJws) → decode (decodeBase64Url) → decrypt
 *      (decryptLogPayload with the historical space key of payload.keyGeneration) →
 *      apply the plaintext Yjs update to a scratch Y.Doc.
 *   3. Read scratch.getMap('data')._stressWrites and assert every EXPECTED writeId is
 *      present. A missing writeId is the only hard FAIL.
 *
 * seq gaps are reported + classified (explained vs. unexplained), never hard-failed.
 */
import * as Y from 'yjs'
import { verifyLogEntryJws, decodeBase64Url, decryptLogPayload } from '@web_of_trust/core/protocol'
import { RawRelayClient, mintSpaceCap } from '../tests/raw-client'
import { sharedCrypto, makeIdentity } from '../tests/harness'

/** How the audit resolves the space key material it needs (from a remaining member). */
export interface SpaceKeyAccess {
  /** Current content-key generation of the space (for minting the read capability). */
  currentGeneration(): Promise<number>
  /** The capability signing seed at a generation (to mint an audit read-cap). */
  capabilitySigningSeed(generation: number): Promise<Uint8Array | null>
  /** The content key at a generation (to decrypt entries authored under it). */
  contentKey(generation: number): Promise<Uint8Array | null>
}

export interface SpaceAuditResult {
  spaceId: string
  entriesPulled: number
  entriesDecrypted: number
  verifyFailures: number
  decryptFailures: number
  applyFailures: number
  /** Distinct writeIds reconstructed from the decrypted CRDT. */
  reconstructedWriteIds: string[]
  /** Expected writeIds absent from the reconstruction — HARD FAIL if non-empty. */
  missingWriteIds: string[]
  /** Seq gaps observed per device on the wire (classified). */
  seqGaps: SeqGapReport[]
  /** Highest seq seen per device (diagnostic). */
  maxSeqByDevice: Record<string, number>
  /** True if pagination could not make progress (stalled) — surfaced, not silently capped. */
  stalled: boolean
}

export interface SeqGapReport {
  deviceId: string
  /** The seqs missing between the min and max observed for this device. */
  missingSeqs: number[]
  classification: 'explained' | 'unexplained'
}

const AUDIT_PAGE_LIMIT = 200

/**
 * Audit ONE space at the wire. `expectedWriteIds` is the runner's expected-ledger for
 * this space (union over all authoring devices). `staleReemitDevices` are devices that
 * were observed to re-emit under KEY_GENERATION_STALE (→ their gaps are "explained").
 */
export async function auditSpace(params: {
  relayUrl: string
  spaceId: string
  keys: SpaceKeyAccess
  expectedWriteIds: Set<string>
  staleReemitDevices: Set<string>
}): Promise<SpaceAuditResult> {
  const auditIdentity = await makeIdentity()
  const client = new RawRelayClient(params.relayUrl, auditIdentity)
  await client.connect()

  try {
    // Read capability, audience = the audit client's DID, at the CURRENT generation
    // (the relay rejects stale-gen caps after a rotation).
    const generation = await params.keys.currentGeneration()
    const signingSeed = await params.keys.capabilitySigningSeed(generation)
    if (!signingSeed) throw new Error(`no capability signing seed for space ${params.spaceId} gen ${generation}`)
    const capJws = await mintSpaceCap({
      signingSeed,
      spaceId: params.spaceId,
      audience: auditIdentity.getDid(),
      permissions: ['read'],
      generation,
    })
    await client.presentCapability(capJws)

    // --- paginated wire pull, cursor from DECODED entries -----------------------
    const scratch = new Y.Doc()
    const seenBySeq = new Map<string, Set<number>>() // deviceId → seqs seen
    const maxSeqByDevice: Record<string, number> = {}
    let cursor: Record<string, number> = {}
    let entriesPulled = 0
    let entriesDecrypted = 0
    let verifyFailures = 0
    let decryptFailures = 0
    let applyFailures = 0
    let stalled = false
    const contentKeyCache = new Map<number, Uint8Array | null>()

    for (;;) {
      const page = await client.auditPull(params.spaceId, cursor, AUDIT_PAGE_LIMIT)
      let advanced = false
      const nextCursor: Record<string, number> = { ...cursor }

      for (const jws of page.entries) {
        entriesPulled += 1
        let payload
        try {
          payload = await verifyLogEntryJws(jws, { crypto: sharedCrypto })
        } catch {
          verifyFailures += 1
          continue
        }
        const { deviceId, seq, keyGeneration, data } = payload
        // track per-device seqs + cursor
        let seqs = seenBySeq.get(deviceId)
        if (!seqs) {
          seqs = new Set<number>()
          seenBySeq.set(deviceId, seqs)
        }
        if (!seqs.has(seq)) {
          seqs.add(seq)
          maxSeqByDevice[deviceId] = Math.max(maxSeqByDevice[deviceId] ?? -1, seq)
          if (seq > (nextCursor[deviceId] ?? -1)) {
            nextCursor[deviceId] = seq
            advanced = true
          }
        }
        // decrypt with the historical key of THIS entry's generation
        let key = contentKeyCache.get(keyGeneration)
        if (key === undefined) {
          key = await params.keys.contentKey(keyGeneration)
          contentKeyCache.set(keyGeneration, key)
        }
        if (!key) {
          decryptFailures += 1
          continue
        }
        let plaintext: Uint8Array
        try {
          plaintext = await decryptLogPayload({ crypto: sharedCrypto, spaceContentKey: key, blob: decodeBase64Url(data) })
        } catch {
          decryptFailures += 1
          continue
        }
        try {
          Y.applyUpdate(scratch, plaintext)
          entriesDecrypted += 1
        } catch {
          applyFailures += 1
        }
      }

      cursor = nextCursor
      if (!page.truncated) break
      if (!advanced) {
        // truncated but no cursor progress → cannot continue without skipping; surface it.
        stalled = true
        break
      }
    }

    // --- reconstruction + writeId completeness ----------------------------------
    const dataMap = scratch.getMap('data').toJSON() as { _stressWrites?: Record<string, unknown> }
    const reconstructed = new Set<string>(Object.keys(dataMap._stressWrites ?? {}))
    const missingWriteIds = [...params.expectedWriteIds].filter((id) => !reconstructed.has(id))

    // --- seq-gap classification -------------------------------------------------
    const seqGaps: SeqGapReport[] = []
    for (const [deviceId, seqs] of seenBySeq) {
      const sorted = [...seqs].sort((a, b) => a - b)
      const missing: number[] = []
      for (let s = sorted[0]; s < sorted[sorted.length - 1]; s++) {
        if (!seqs.has(s)) missing.push(s)
      }
      if (missing.length > 0) {
        seqGaps.push({
          deviceId,
          missingSeqs: missing,
          // explained: this device re-emitted under KEY_GENERATION_STALE (old seq never stored).
          classification: params.staleReemitDevices.has(deviceId) ? 'explained' : 'unexplained',
        })
      }
    }

    return {
      spaceId: params.spaceId,
      entriesPulled,
      entriesDecrypted,
      verifyFailures,
      decryptFailures,
      applyFailures,
      reconstructedWriteIds: [...reconstructed],
      missingWriteIds,
      seqGaps,
      maxSeqByDevice,
      stalled,
    }
  } finally {
    await client.disconnect()
  }
}
