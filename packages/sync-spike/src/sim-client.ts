import {
  createLogEntryJws,
  verifyLogEntryJws,
  encryptLogPayload,
  decryptLogPayload,
  decodeBase64Url,
  classifyLocalBrokerSeqConsistency,
  classifyLogEntryKeyDisposition,
  deriveSyncStartSeq,
  type LogEntryPayload,
  type SyncHeads,
} from '@web_of_trust/core/protocol'
import { crypto, deriveSpaceContentKey, contentHash, type Author } from './identity.js'
import {
  applyUpdate,
  localWrite,
  newDoc,
  stateHash,
  stateSnapshot,
  type CrdtDoc,
} from './crdt-stub.js'
import type { SimRelay, StoredEntry } from './sim-relay.js'

const FIXED_TIMESTAMP = '2026-06-22T10:00:00Z'

export interface SimClientOptions {
  author: Author
  deviceId: string
  /** the docId this device participates in. */
  docId: string
  relay: SimRelay
  /** key generations whose Space Content Key this device currently holds. */
  availableKeyGenerations?: number[]
  /** active keyGeneration used for NEW local writes. */
  keyGeneration?: number
  /** membership recipients (DIDs) for transient delivery; excludes self at append. */
  members?: string[]
  /**
   * NAIVE/buggy variant: re-broadcast every applied entry. Used by the loop-safety
   * control to reproduce the outbox loop explosion. Default false (loop-free).
   */
  naiveRebroadcast?: boolean
}

export class SimClient {
  readonly author: Author
  readonly deviceId: string
  readonly docId: string
  private relay: SimRelay
  doc: CrdtDoc = newDoc()
  /** per docId localSeq (single doc per client here). next write uses localSeq+1? we track last used. */
  localSeq = -1
  /** applied (deviceId,seq) keys, for idempotency. */
  private applied = new Set<string>()
  /** entries buffered because their keyGeneration key is missing. */
  private keyBuffer: StoredEntry[] = []
  /** keyGeneration -> Space Content Key (32 bytes). */
  private keys = new Map<number, Uint8Array>()
  availableKeyGenerations: number[]
  keyGeneration: number
  members: string[]
  private naiveRebroadcast: boolean
  /** Safety valve for the naive-loop control so the test cannot hang. */
  echoBudget = 0
  private echoCounter = 0
  private unsubscribe: (() => void) | null = null
  private online = false

  constructor(opts: SimClientOptions) {
    this.author = opts.author
    this.deviceId = opts.deviceId
    this.docId = opts.docId
    this.relay = opts.relay
    this.availableKeyGenerations = [...(opts.availableKeyGenerations ?? [0])]
    this.keyGeneration = opts.keyGeneration ?? 0
    this.members = [...(opts.members ?? [])]
    this.naiveRebroadcast = opts.naiveRebroadcast ?? false
  }

  /** Lazily derive + cache the Space Content Key for a generation we hold. */
  private async keyFor(generation: number): Promise<Uint8Array> {
    let key = this.keys.get(generation)
    if (!key) {
      key = await deriveSpaceContentKey(this.docId, generation)
      this.keys.set(generation, key)
    }
    return key
  }

  /** Connect to the relay's live broadcast for this doc. */
  connect(): void {
    if (this.online) return
    this.online = true
    this.unsubscribe = this.relay.subscribe(this.docId, (entry) => this.receive(entry).then(() => undefined))
  }

  goOffline(): void {
    this.online = false
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  isOnline(): boolean {
    return this.online
  }

  /** Wipe local CRDT + applied set + localSeq (simulate empty browser cache). */
  clearCache(): void {
    this.doc = newDoc()
    this.applied.clear()
    this.keyBuffer = []
    this.localSeq = -1
  }

  /**
   * Seed local coverage from a vault snapshot's coverage-heads, so a subsequent
   * catchUp() fetches ONLY entries with seq > head per device — the Sync-002
   * 'catch-up-optimization-eligible' / log-head-coverage optimization. Marks every
   * (deviceId, seq<=head) as applied (seq is contiguous from 0 in this harness), so
   * localHeads() reports the snapshot's coverage and the pre-snapshot log is not
   * re-fetched. The snapshot's merged registers (see SimVault.mergeInto) are what
   * supply the pre-snapshot state that catch-up now skips — making the snapshot
   * genuinely load-bearing, not decorative.
   */
  seedCoverage(heads: SyncHeads): void {
    for (const [dev, head] of Object.entries(heads)) {
      for (let s = 0; s <= head; s += 1) this.applied.add(`${dev}|${s}`)
    }
  }

  /** Add a key generation and replay anything buffered-by-key. */
  async importKeyGeneration(generation: number, key: Uint8Array): Promise<void> {
    this.keys.set(generation, key)
    if (!this.availableKeyGenerations.includes(generation)) {
      this.availableKeyGenerations.push(generation)
    }
    const buffered = this.keyBuffer
    this.keyBuffer = []
    for (const entry of buffered) await this.receive(entry)
  }

  /** Switch the active generation for future local writes. */
  setActiveKeyGeneration(generation: number): void {
    this.keyGeneration = generation
    if (!this.availableKeyGenerations.includes(generation)) {
      this.availableKeyGenerations.push(generation)
    }
  }

  private recipients(): string[] {
    return this.members.filter((did) => did !== this.author.did)
  }

  /**
   * Local write: bump localSeq, make a CRDT update, encrypt+sign, push to relay.
   * The entry is broadcast ONCE by the relay; we never re-broadcast on receive.
   * `seqOverride` lets the restore-clone test rewind seq deliberately.
   */
  async localWrite(
    key: string,
    value: string,
    opts?: { seqOverride?: number; keyGeneration?: number },
  ): Promise<{ seq: number; appendResult: Awaited<ReturnType<SimRelay['append']>> }> {
    const seq = opts?.seqOverride ?? this.localSeq + 1
    const generation = opts?.keyGeneration ?? this.keyGeneration
    const { updateBytes } = localWrite(this.doc, key, value, this.deviceId)

    // Optimistic local commit: reserve the seq + mark applied BEFORE pushing, so a
    // re-entrant write triggered by the broadcast cascade sees the advanced seq
    // (a real client reserves its next seq before sending). Rolled back on reject.
    const seqKey = `${this.deviceId}|${seq}`
    const prevLocalSeq = this.localSeq
    const seqWasApplied = this.applied.has(seqKey)
    if (seq > this.localSeq) this.localSeq = seq
    this.applied.add(seqKey)

    const spaceContentKey = await this.keyFor(generation)
    const enc = await encryptLogPayload({
      crypto,
      spaceContentKey,
      deviceId: this.deviceId,
      seq,
      plaintext: updateBytes,
    })

    const payload: LogEntryPayload = {
      seq,
      deviceId: this.deviceId,
      docId: this.docId,
      authorKid: this.author.authorKid,
      keyGeneration: generation,
      data: enc.blobBase64Url,
      timestamp: FIXED_TIMESTAMP,
    }
    const jws = await createLogEntryJws({ payload, signingSeed: this.author.seed })

    const appendResult = await this.relay.append({
      jws,
      docId: this.docId,
      deviceId: this.deviceId,
      seq,
      recipients: this.recipients(),
    })

    // Roll back the optimistic commit if the broker rejected (seq collision):
    // the restore-clone hazard. The CRDT op already applied locally is harmless
    // (idempotent), but the seq reservation must not stick.
    if (appendResult.disposition === 'reject-seq-collision') {
      this.localSeq = prevLocalSeq
      if (!seqWasApplied) this.applied.delete(seqKey)
    }
    return { seq, appendResult }
  }

  /**
   * Receive an entry (live broadcast or catch-up page).
   *  - verify signature/schema
   *  - idempotency: already-applied (deviceId,seq) => no-op, NO echo
   *  - key disposition: blocked-by-key => buffer
   *  - else decrypt + applyUpdate. Never re-broadcast (unless naive control).
   */
  async receive(entry: StoredEntry): Promise<{ applied: boolean; bufferedByKey: boolean }> {
    const payload = await verifyLogEntryJws(entry.jws, { crypto })
    const seqKey = `${payload.deviceId}|${payload.seq}`
    if (this.applied.has(seqKey)) {
      return { applied: false, bufferedByKey: false }
    }

    const disposition = classifyLogEntryKeyDisposition({
      keyGeneration: payload.keyGeneration,
      availableKeyGenerations: this.availableKeyGenerations,
    })
    if (disposition === 'blocked-by-key') {
      this.keyBuffer.push(entry)
      return { applied: false, bufferedByKey: true }
    }

    const spaceContentKey = await this.keyFor(payload.keyGeneration)
    const blob = decodeBase64Url(payload.data)
    const plaintext = await decryptLogPayload({ crypto, spaceContentKey, blob })
    applyUpdate(this.doc, plaintext)
    this.applied.add(seqKey)

    if (this.naiveRebroadcast && this.echoBudget > 0) {
      // BUG REPRODUCTION (the historical outbox loop): observe -> write -> observe
      // -> write. On every applied change the naive client emits a NEW write of its
      // own (fresh, never-colliding seq + fresh content), which the broker accepts
      // and re-broadcasts, so peers observe-and-write again => unbounded growth.
      // The echoBudget is only a test safety valve so the process cannot truly
      // hang; crossing a large count within a few rounds is the explosion signature.
      this.echoBudget -= 1
      this.echoCounter += 1
      await this.localWrite(`echo:${this.deviceId}`, `tick-${this.echoCounter}`)
    }
    return { applied: true, bufferedByKey: false }
  }

  /** Local heads = max applied seq per deviceId (what catch-up compares against). */
  localHeads(): SyncHeads {
    const out: Record<string, number> = {}
    for (const seqKey of this.applied) {
      const sep = seqKey.lastIndexOf('|')
      const dev = seqKey.slice(0, sep)
      const seq = Number(seqKey.slice(sep + 1))
      if (out[dev] === undefined || seq > out[dev]) out[dev] = seq
    }
    return out
  }

  /**
   * Catch-up against a durable-log relay:
   *  - compare local vs broker heads per device (classifyLocalBrokerSeqConsistency)
   *  - sync-request entries since our heads (paged), apply, converge.
   * Returns the dispositions observed (for restore-clone assertions).
   */
  async catchUp(limit?: number): Promise<{
    consistency: ReturnType<typeof classifyLocalBrokerSeqConsistency>[]
    appliedCount: number
    pages: number
  }> {
    const localHeads = this.localHeads()
    const brokerHeads = this.relay.brokerHeads(this.docId)

    // classifyLocalBrokerSeqConsistency requires non-negative seqs. For a device we
    // have never seen, brokerSeq > 0 simply means "catch up needed" (not a rewind);
    // the restore-clone signal is specifically for OUR OWN device where the broker
    // is ahead of our local seq. We classify every device the broker knows.
    const consistency = Object.keys(brokerHeads).map((deviceId) =>
      classifyLocalBrokerSeqConsistency({
        docId: this.docId,
        deviceId,
        localSeq: localHeads[deviceId] ?? 0,
        brokerSeq: brokerHeads[deviceId],
      }),
    )

    let appliedCount = 0
    let pages = 0
    // Page until the response is no longer truncated.
    // deriveSyncStartSeq is the canonical "where do I resume" for each device.
    for (;;) {
      const heads = this.localHeads()
      // sanity: deriveSyncStartSeq is the per-device resume point (head+1 or 0).
      for (const dev of Object.keys(brokerHeads)) deriveSyncStartSeq(heads, dev)

      const page = this.relay.syncPage(this.docId, heads, limit)
      pages += 1
      for (const jws of page.entries) {
        const payload = await verifyLogEntryJws(jws, { crypto })
        const res = await this.receive({
          jws,
          docId: payload.docId,
          deviceId: payload.deviceId,
          seq: payload.seq,
          contentHash: await contentHash(decodeBase64Url(payload.data)),
        })
        if (res.applied) appliedCount += 1
      }
      if (!page.truncated || page.entries.length === 0) break
    }
    return { consistency, appliedCount, pages }
  }

  snapshot(): Record<string, string> {
    return stateSnapshot(this.doc)
  }

  hash(): Promise<string> {
    return stateHash(this.doc)
  }
}
