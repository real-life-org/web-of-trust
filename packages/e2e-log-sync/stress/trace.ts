/**
 * Festival-Scale-Stress — write tracing (STRESS_TRACE=1).
 *
 * The multi-device silent-loss investigation ([[feedback_runtime_first_for_multidevice]]):
 * a writeId is recorded in the CRDT/ledger AFTER `handle.transact`, but the actual log write
 * is FIRE-AND-FORGET (`void writeLocalUpdateViaLog(...)`) — so a write can (a) never get a
 * local (deviceId, seq) at all (no content key / append failure), (b) get a seq but stay
 * pending (send timed out, no retry), or (c) be acked yet absent at the broker. This tracer
 * classifies each MISSING writeId over the runner-observable state alone (no core changes):
 *
 *   - seq never appeared (getKnownHeads never bumped)  → `never-local-logged`
 *   - seq appeared, still in getPending() at run end   → `local-logged-pending`
 *   - seq appeared, acked (not pending), broker-absent  → `broker-received-absent`
 *
 * Events are appended as JSONL to `stress-artifacts/<ts>/trace.jsonl`.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export interface WriteTrace {
  writeId: string
  deviceId: string
  spaceId: string
  isSecond: boolean
  /** seq assigned by appendLocalEntry, or null if none appeared within budget (never-local-logged). */
  seq: number | null
  /** ms from transact to seq-appearance (local-log latency), or null if it never appeared. */
  localLogMs: number | null
  /** whether the writeId is present in the AUTHOR's own local doc IMMEDIATELY after transact. */
  localAfterWrite: boolean
}

export type LossClass =
  /** was in the author's own doc right after transact, GONE at run end — the doc dropped the
   *  mutation before it was flushed to a durable log entry (the observed dual-device mechanism). */
  | 'local-doc-lost-after-write'
  /** the mutation never entered the author's own doc at all (transact no-op). */
  | 'transact-noop'
  /** entered the doc but no (deviceId,seq) log entry was ever assigned. */
  | 'never-local-logged'
  /** a log entry was assigned but is still pending (unsent / send never acked) at run end. */
  | 'local-logged-pending'
  /** seq assigned + acked (not pending) yet absent at the broker — needs a broker-side trace. */
  | 'broker-received-absent'
  | 'no-trace'

export class WriteTracer {
  private records = new Map<string, WriteTrace>()
  private path: string
  private buffer: string[] = []

  constructor(artifactsDir: string) {
    this.path = resolve(REPO_ROOT, artifactsDir, 'trace.jsonl')
  }

  record(t: WriteTrace): void {
    this.records.set(t.writeId, t)
    this.buffer.push(JSON.stringify({ ev: 'write', ...t }))
  }

  get(writeId: string): WriteTrace | undefined {
    return this.records.get(writeId)
  }

  event(obj: Record<string, unknown>): void {
    this.buffer.push(JSON.stringify(obj))
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, this.buffer.join('\n') + '\n', 'utf8')
    this.buffer = []
  }
}

/**
 * After a `handle.transact`, wait until the fire-and-forget log write assigns a seq
 * (getKnownHeads for the own device bumps past `beforeMax`) — or time out, which IS the
 * never-local-logged detector. getKnownHeads counts pending AND acked entries, so a
 * successful appendLocalEntry always shows here even if the send later fails.
 */
export async function detectSeqAfterWrite(
  getKnownHeads: (docId: string) => Promise<Record<string, number>>,
  docId: string,
  deviceId: string,
  beforeMax: number,
  budgetMs: number,
): Promise<{ seq: number | null; ms: number | null }> {
  // seq numbering starts at 0, so a fresh device's head is ABSENT (-1 sentinel), not 0 —
  // otherwise a first write that gets seq 0 is indistinguishable from "no write" (head 0 == 0).
  const start = Date.now()
  const deadline = start + budgetMs
  for (;;) {
    const h = (await getKnownHeads(docId).catch(() => ({}) as Record<string, number>))[deviceId] ?? -1
    if (h > beforeMax) return { seq: h, ms: Date.now() - start }
    if (Date.now() >= deadline) return { seq: null, ms: null }
    await new Promise((r) => setTimeout(r, 20))
  }
}
