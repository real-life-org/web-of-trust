import {
  classifyBrokerSeqCollision,
  type BrokerSeqCollisionResult,
} from '@web_of_trust/core/protocol'
import { verifyLogEntryJws } from '@web_of_trust/core/protocol'
import type { SyncHeads } from '@web_of_trust/core/protocol'
import { crypto } from './identity.js'
import { bytesToHex } from '@web_of_trust/core/protocol'
import { decodeBase64Url } from '@web_of_trust/core/protocol'

export type RelayMode = 'transient' | 'durable-log'

/** A stored log entry as the broker sees it: opaque JWS + indexing metadata. */
export interface StoredEntry {
  jws: string
  docId: string
  deviceId: string
  seq: number
  /** content hash of the encrypted `data` blob (for seq-collision detection). */
  contentHash: string
}

export interface SyncPage {
  entries: string[]
  heads: SyncHeads
  truncated: boolean
}

export interface RelayAppendResult {
  disposition: BrokerSeqCollisionResult['disposition']
  errorCode?: 'SEQ_COLLISION_DETECTED'
  clientHint?: 'restore-clone-required'
  /** how many subscribers the entry was broadcast to (0 if rejected/idempotent). */
  broadcastFanout: number
}

type Subscriber = (entry: StoredEntry) => void | Promise<void>

interface DocState {
  /** durable-log: retained append-only log, append order. */
  log: StoredEntry[]
  /** (deviceId,seq) -> contentHash, for collision classification. */
  seqTable: Map<string, string>
  /** brokerHeads: max seq per deviceId. */
  brokerHeads: Map<string, number>
}

interface TransientQueueRow {
  recipient: string
  entry: StoredEntry
  status: 'queued' | 'delivered'
}

/**
 * In-memory broker.
 *
 *  - 'transient' reproduces today's bug (packages/wot-relay/src/queue.ts):
 *    per-recipient queue, queued -> delivered -> ACK -> ROW DELETED. After ACK the
 *    content is GONE; there is NO retained per-doc log, so a fresh client that asks
 *    for history gets nothing => cold reconstruction is impossible.
 *
 *  - 'durable-log' implements Sync-002: a RETAINED append-only log per docId, keyed
 *    by (deviceId,seq), with tracked heads. Serves catch-up via heads, and enforces
 *    seq with classifyBrokerSeqCollision.
 */
export class SimRelay {
  readonly mode: RelayMode
  private docs = new Map<string, DocState>()
  private subscribers = new Map<string, Set<Subscriber>>()
  /** transient mode only: per-recipient delivery queue. */
  private transientQueue: TransientQueueRow[] = []
  /** flat broadcast worklist (avoids deep recursion under re-entrant appends). */
  private pendingDeliveries: { fn: Subscriber; entry: StoredEntry }[] = []
  private draining = false
  /** observability counters. */
  totalAppendCalls = 0
  totalBroadcasts = 0

  constructor(mode: RelayMode) {
    this.mode = mode
  }

  private docState(docId: string): DocState {
    let state = this.docs.get(docId)
    if (!state) {
      state = { log: [], seqTable: new Map(), brokerHeads: new Map() }
      this.docs.set(docId, state)
    }
    return state
  }

  /** Subscribe a connected client to live broadcasts for a doc. */
  subscribe(docId: string, fn: Subscriber): () => void {
    let set = this.subscribers.get(docId)
    if (!set) {
      set = new Set()
      this.subscribers.set(docId, set)
    }
    set.add(fn)
    return () => set!.delete(fn)
  }

  private async hashEntryData(jws: string): Promise<string> {
    // Verify signature + schema, then hash the encrypted data blob (opaque).
    const payload = await verifyLogEntryJws(jws, { crypto })
    const blob = decodeBase64Url(payload.data)
    return bytesToHex(await crypto.sha256(blob))
  }

  /**
   * A client appends an entry. Returns the broker disposition.
   * In durable-log mode the entry is retained and indexed; in transient mode it is
   * only enqueued for currently-known recipients (and dropped after ACK).
   */
  async append(params: {
    jws: string
    docId: string
    deviceId: string
    seq: number
    /** recipients for transient delivery (the membership minus the sender). */
    recipients: string[]
  }): Promise<RelayAppendResult> {
    this.totalAppendCalls += 1
    const { jws, docId, deviceId, seq, recipients } = params

    const incomingContentHash = await this.hashEntryData(jws)
    const state = this.docState(docId)
    const seqKey = `${deviceId}|${seq}`
    const existingContentHash = state.seqTable.get(seqKey) ?? null

    const decision = classifyBrokerSeqCollision({
      docId,
      deviceId,
      seq,
      existingContentHash,
      incomingContentHash,
    })

    if (decision.disposition === 'reject-seq-collision') {
      return {
        disposition: decision.disposition,
        errorCode: decision.errorCode,
        clientHint: decision.clientHint,
        broadcastFanout: 0,
      }
    }

    if (decision.disposition === 'idempotent-retransmission') {
      // Already have this exact (deviceId,seq,content). No re-store, no re-broadcast.
      return { disposition: decision.disposition, broadcastFanout: 0 }
    }

    // accept-new-entry
    state.seqTable.set(seqKey, incomingContentHash)
    const prevHead = state.brokerHeads.get(deviceId) ?? -1
    if (seq > prevHead) state.brokerHeads.set(deviceId, seq)

    const stored: StoredEntry = { jws, docId, deviceId, seq, contentHash: incomingContentHash }

    if (this.mode === 'durable-log') {
      state.log.push(stored)
    } else {
      // transient: enqueue for each currently-known recipient.
      for (const recipient of recipients) {
        this.transientQueue.push({ recipient, entry: stored, status: 'queued' })
      }
    }

    // Live broadcast to currently-subscribed clients (both modes). Deliveries run
    // through a FLAT worklist drain, not recursion: a re-entrant append (e.g. the
    // naive echo loop) appends more work to the same queue instead of growing the
    // call stack. This keeps the simulation deterministic and stack-safe while
    // still letting the naive control explode in append COUNT.
    const set = this.subscribers.get(docId)
    let fanout = 0
    if (set) {
      for (const fn of [...set]) {
        fanout += 1
        this.totalBroadcasts += 1
        this.pendingDeliveries.push({ fn, entry: stored })
      }
    }
    await this.drainDeliveries()
    return { disposition: decision.disposition, broadcastFanout: fanout }
  }

  private async drainDeliveries(): Promise<void> {
    // Only the outermost append owns the drain loop; nested appends just enqueue.
    if (this.draining) return
    this.draining = true
    try {
      while (this.pendingDeliveries.length > 0) {
        const next = this.pendingDeliveries.shift()!
        await next.fn(next.entry)
      }
    } finally {
      this.draining = false
    }
  }

  // --- durable-log catch-up -------------------------------------------------

  /** Current broker heads for a doc (max seq per deviceId). */
  brokerHeads(docId: string): SyncHeads {
    const out: Record<string, number> = {}
    const state = this.docs.get(docId)
    if (state) for (const [dev, seq] of state.brokerHeads) out[dev] = seq
    return out
  }

  /**
   * Serve a catch-up page: every retained entry with seq > heads[deviceId] per device,
   * ordered (deviceId, seq). Supports a `limit` to exercise truncation/paging.
   * Only valid in durable-log mode (transient retains nothing post-ACK).
   */
  syncPage(docId: string, heads: SyncHeads, limit?: number): SyncPage {
    if (this.mode !== 'durable-log') {
      // The whole point of the control: no retained log to serve from.
      return { entries: [], heads: this.brokerHeads(docId), truncated: false }
    }
    const state = this.docs.get(docId)
    if (!state) return { entries: [], heads: {}, truncated: false }

    const missing = state.log
      .filter((e) => e.seq > (heads[e.deviceId] ?? -1))
      .sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : a.seq - b.seq))

    let truncated = false
    let page = missing
    if (typeof limit === 'number' && missing.length > limit) {
      page = missing.slice(0, limit)
      truncated = true
    }
    return { entries: page.map((e) => e.jws), heads: this.brokerHeads(docId), truncated }
  }

  // --- transient delivery / ACK lifecycle ----------------------------------

  /** Deliver all 'queued' rows for a recipient; mark them 'delivered'. */
  transientDeliver(recipient: string): StoredEntry[] {
    const rows = this.transientQueue.filter((r) => r.recipient === recipient && r.status === 'queued')
    for (const r of rows) r.status = 'delivered'
    return rows.map((r) => r.entry)
  }

  /** ACK: delete delivered rows for a recipient — the bug's data-loss moment. */
  transientAck(recipient: string): void {
    this.transientQueue = this.transientQueue.filter(
      (r) => !(r.recipient === recipient && r.status === 'delivered'),
    )
  }

  /** Total rows still held in the transient queue (for assertions). */
  transientQueueSize(): number {
    return this.transientQueue.length
  }

  // --- introspection for tests ---------------------------------------------

  /** Retained log length for a doc (durable-log). */
  logLength(docId: string): number {
    return this.docs.get(docId)?.log.length ?? 0
  }

  /** Snapshot of the retained log JWS list. */
  logEntries(docId: string): string[] {
    return (this.docs.get(docId)?.log ?? []).map((e) => e.jws)
  }

  /** All (deviceId,seq) keys recorded in the seq table. */
  seqKeys(docId: string): string[] {
    return [...(this.docs.get(docId)?.seqTable.keys() ?? [])].sort()
  }
}
