// Relay metrics (Stufe 1, Camp): in-memory ring of 10s buckets over 24h, served
// as history via GET /dashboard/metrics. Answers "how does the network behave at
// 100 DIDs" (ingest ok/reject, receipts, ws churn, inbox flow) and "what can the
// Pi 4 take" (event-loop lag, sqlite write p95, rss/heap, host load/mem/disk/
// temp/net).
//
// DELIBERATELY NOT persisted: the ring is process-local; a relay restart starts
// with an empty history (documented trade-off — Stufe 2 may add persistence).
//
// Memory: every series is a preallocated Float64Array with 8640 slots (24h at
// 10s). ~28 series + 11 reject columns + the timestamp row ≈ 40 × 8640 × 8 B
// ≈ 2.7 MB — safely under the 5 MB budget. NaN encodes "no value" (gap bucket /
// unavailable host reader) and serializes as null.
//
// Counters are MONOTONE accumulators on this long-lived object (owned by the
// RelayServer for its whole lifetime — never replaced, so they cannot jump
// backwards); each bucket stores the DELTA since the previous flush
// (snapshot-diff). Time: bucket timestamps are WALL clock (Date.now via the
// flush caller); durations (sqlite writes) are measured with performance.now()
// by the caller. A wall-clock gap > 2 buckets (system sleep, clock jump) writes
// the missed slots as NULL buckets and DISCARDS the gap-spanning counter deltas
// (resnapshot) — never a giant delta bucket. Gauges are instantaneous and are
// still sampled after a gap.

import { readFileSync, statfsSync } from 'node:fs'
import os from 'node:os'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

export const METRICS_BUCKET_SECONDS = 10
export const METRICS_RING_SLOTS = 8640 // 24h at 10s
/** Server-side downsampling target: responses carry at most ~this many points. */
export const METRICS_MAX_POINTS = 360

/** Query windows for /dashboard/metrics?window=… (seconds). */
export const METRICS_WINDOWS = {
  '15m': 900,
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
} as const
export type MetricsWindowKey = keyof typeof METRICS_WINDOWS

// ---------------------------------------------------------------------------
// Closed ingest-reject catalog. `ingestRejectByCode` must have HARD-BOUNDED
// cardinality (fixed ring columns) — relay error codes are plain strings on the
// wire, so an unexpected/new code folds into 'OTHER' instead of growing the
// ring. Codes = the real log-entry ingest reject sites in relay.ts (see
// handleLogEntry + the relay-whitelist reject).
// ---------------------------------------------------------------------------
export const INGEST_REJECT_CODES = [
  'MALFORMED_MESSAGE',
  'AUTH_INVALID',
  'DEVICE_REVOKED',
  'PERSONAL_DOC_OWNER_MISMATCH',
  'CAPABILITY_EXPIRED',
  'CAPABILITY_REQUIRED',
  'DEVICE_NOT_REGISTERED',
  'AUTHOR_MISMATCH',
  'KEY_GENERATION_STALE',
  'SEQ_COLLISION_DETECTED',
  'OTHER',
] as const
export type IngestRejectCode = (typeof INGEST_REJECT_CODES)[number]

/** Fold an arbitrary wire error code into the closed catalog ('OTHER' fallback). */
export function toIngestRejectCode(code: string): IngestRejectCode {
  return (INGEST_REJECT_CODES as readonly string[]).includes(code) ? (code as IngestRejectCode) : 'OTHER'
}

// ---------------------------------------------------------------------------
// Series catalog + downsampling semantics (v2 spec):
//   counters (incl. net BYTE counters)      → merge = SUM (client derives rates
//                                             as sum/spanSeconds)
//   eventLoopLagP99Ms / sqliteWriteP95Ms    → MAX (worst case is the signal)
//   rssMB / heapUsedMB                      → MAX
//   connections / queuePendingTotal         → MAX
//   cpuTempC                                → MAX (worst case; not in the v2
//                                             list — documented here)
//   memAvailableMB / diskFreeMB             → MIN (scarcest moment)
//   memTotalMB / diskTotalMB                → MAX (effectively constant)
//   loadavg1/5/15                           → AVG
// ---------------------------------------------------------------------------
type AggKind = 'sum' | 'max' | 'min' | 'avg'

const COUNTER_NAMES = [
  'ingestOk',
  'receiptsDelivered',
  'receiptsAccepted',
  'errorFramesSent',
  'rawWsConnects',
  'wsConnects',
  'wsDisconnects',
  'inboxEnqueued',
  'inboxDeliveredEntries',
  'acks',
] as const
type CounterName = (typeof COUNTER_NAMES)[number]

const SERIES_AGG: Record<string, AggKind> = {
  // counter deltas
  ingestOk: 'sum',
  receiptsDelivered: 'sum',
  receiptsAccepted: 'sum',
  errorFramesSent: 'sum',
  rawWsConnects: 'sum',
  wsConnects: 'sum',
  wsDisconnects: 'sum',
  inboxEnqueued: 'sum',
  inboxDeliveredEntries: 'sum',
  acks: 'sum',
  // net BYTE counters (per-bucket byte deltas of /proc/net/dev cumulative counters)
  netRxBytes: 'sum',
  netTxBytes: 'sum',
  // gauges
  eventLoopLagP99Ms: 'max',
  sqliteWriteP95Ms: 'max',
  rssMB: 'max',
  heapUsedMB: 'max',
  connections: 'max',
  queuePendingTotal: 'max',
  cpuTempC: 'max',
  loadavg1: 'avg',
  loadavg5: 'avg',
  loadavg15: 'avg',
  memAvailableMB: 'min',
  diskFreeMB: 'min',
  memTotalMB: 'max',
  diskTotalMB: 'max',
}

/** Column name of a reject code in the ring. */
const rejectColumn = (code: IngestRejectCode): string => `reject_${code}`
for (const code of INGEST_REJECT_CODES) SERIES_AGG[rejectColumn(code)] = 'sum'

const ALL_SERIES = Object.keys(SERIES_AGG)

// ---------------------------------------------------------------------------
// Host readers (best-effort). EVERY reader is try/catch → null so a container
// without /sys thermal zones, a non-Linux dev box, or a missing /proc never
// throws (spec: container portability; tests inject bogus paths and assert the
// null fallback).
// ---------------------------------------------------------------------------
export interface HostPaths {
  /** /proc/meminfo (MemAvailable/MemTotal). */
  meminfo: string
  /** /proc/net/dev (cumulative per-interface byte counters). */
  netDev: string
  /** /sys/class/thermal/thermal_zone0/temp (milli-°C; absent off-Pi). */
  cpuTemp: string
}

export const DEFAULT_HOST_PATHS: HostPaths = {
  meminfo: '/proc/meminfo',
  netDev: '/proc/net/dev',
  cpuTemp: '/sys/class/thermal/thermal_zone0/temp',
}

/** Parse /proc/meminfo → MB values, or null when unreadable/unparsable. */
export function readMeminfo(path: string): { availableMB: number; totalMB: number } | null {
  try {
    const txt = readFileSync(path, 'utf8')
    const avail = /MemAvailable:\s+(\d+)\s*kB/.exec(txt)
    const total = /MemTotal:\s+(\d+)\s*kB/.exec(txt)
    if (!avail || !total) return null
    return { availableMB: Number(avail[1]) / 1024, totalMB: Number(total[1]) / 1024 }
  } catch {
    return null
  }
}

/** Read the SoC temperature (milli-°C file) → °C, or null (non-Pi/container). */
export function readCpuTempC(path: string): number | null {
  try {
    const raw = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    if (!Number.isFinite(raw)) return null
    return raw / 1000
  } catch {
    return null
  }
}

/** Filesystem stats of the directory holding the SQLite DB, or null. */
export function readDisk(dir: string | null): { freeMB: number; totalMB: number } | null {
  if (dir === null) return null
  try {
    const s = statfsSync(dir)
    const toMB = (blocks: number) => (blocks * s.bsize) / (1024 * 1024)
    return { freeMB: toMB(s.bavail), totalMB: toMB(s.blocks) }
  } catch {
    return null
  }
}

/**
 * Parse /proc/net/dev cumulative rx/tx byte counters. Interface selection:
 * explicit override (env RELAY_NET_INTERFACE via the server option) when it
 * exists in the table, else the FIRST non-`lo` interface. Returns null when the
 * file is unreadable or no candidate interface exists. NOTE: inside a container
 * this measures the container network namespace (= relay-relevant traffic).
 */
export function readNetDev(
  path: string,
  iface: string | null,
): { iface: string; rxBytes: number; txBytes: number } | null {
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    const parsed: Array<{ name: string; rxBytes: number; txBytes: number }> = []
    for (const line of lines) {
      const m = /^\s*([^\s:]+):\s*(.*)$/.exec(line)
      if (!m) continue
      const fields = m[2].trim().split(/\s+/).map(Number)
      // /proc/net/dev: 8 rx fields then 8 tx fields; bytes are rx[0] and tx[0]=fields[8].
      if (fields.length < 16 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue
      parsed.push({ name: m[1], rxBytes: fields[0], txBytes: fields[8] })
    }
    const chosen =
      (iface !== null ? parsed.find((p) => p.name === iface) : undefined) ??
      parsed.find((p) => p.name !== 'lo')
    if (!chosen) return null
    return { iface: chosen.name, rxBytes: chosen.rxBytes, txBytes: chosen.txBytes }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// RelayMetrics
// ---------------------------------------------------------------------------

export interface RelayMetricsOptions {
  /** Host reader base paths — injectable for tests (fixtures / bogus paths). */
  hostPaths?: Partial<HostPaths>
  /** /proc/net/dev interface override (RELAY_NET_INTERFACE); default first non-lo. */
  netInterface?: string | null
  /** Directory whose filesystem backs the SQLite DB; null disables disk stats (':memory:'). */
  diskDir?: string | null
  /**
   * Enable the node:perf_hooks event-loop-delay histogram (default true). Pure
   * ring/downsampling unit tests may disable it; `dispose()` always disables.
   */
  eventLoopMonitor?: boolean
}

export interface MetricsGauges {
  /** Authenticated WS session count at flush time. */
  connections: number
  /** Pending inbox delivery slots (queue.count()). */
  queuePendingTotal: number
}

export interface MetricsBucket {
  /** Bucket wall-clock timestamp (epoch ms, time of flush / end of bucket). */
  t: number
  /** Seconds this (possibly merged) bucket spans — honest under downsampling. */
  spanSeconds: number
  /** Non-zero reject deltas by closed-catalog code; null in a gap bucket. */
  ingestRejectByCode: Partial<Record<IngestRejectCode, number>> | null
  /**
   * True when at least ONE merged source slot was an explicit gap bucket (relay
   * not sampling / deltas discarded). Present only when true. Without it,
   * downsampled windows (6h/24h) would BLUR gaps that 15m/1h render as line
   * breaks — charts break the line on `gap` exactly like on null.
   */
  gap?: boolean
  [series: string]: number | null | boolean | Partial<Record<IngestRejectCode, number>> | undefined
}

export interface MetricsQueryResult {
  bucketSeconds: number
  window: MetricsWindowKey
  windowSeconds: number
  buckets: MetricsBucket[]
}

/** Reservoir cap for per-bucket sqlite write samples (Algorithm R). */
const SQLITE_RESERVOIR_CAP = 512

export class RelayMetrics {
  // --- monotone accumulators (never reset; deltas via lastFlushedCounters) ---
  private counters: Record<CounterName, number>
  private rejectCounters: Record<IngestRejectCode, number>
  private lastFlushedCounters: Record<CounterName, number>
  private lastFlushedRejects: Record<IngestRejectCode, number>

  // --- ring storage (preallocated typed arrays; NaN = no value) --------------
  private readonly slotT = new Float64Array(METRICS_RING_SLOTS).fill(Number.NaN)
  private readonly slotSeries: Record<string, Float64Array> = {}
  private writeIdx = 0
  private written = 0

  // --- flush bookkeeping ------------------------------------------------------
  private lastFlushMs: number | null = null
  /**
   * Wall-clock `t` of the last WRITTEN slot. query() emits slots in insertion
   * order, so `t` MUST be strictly monotonic across writes — this is the durable
   * guard: after a backward clock jump every flush that is still at-or-behind
   * this stamp is dropped entirely (not just the first one, and also the
   * projected missed-slot times of the recovery gap).
   */
  private lastWrittenT: number | null = null
  private lastNet: { iface: string; rxBytes: number; txBytes: number } | null = null

  // --- sqlite write reservoir (per bucket) -------------------------------------
  private sqliteSamples: number[] = []
  private sqliteSeen = 0

  // --- event loop delay ---------------------------------------------------------
  private readonly elu: IntervalHistogram | null

  private readonly hostPaths: HostPaths
  private readonly netInterface: string | null
  private readonly diskDir: string | null

  constructor(options: RelayMetricsOptions = {}) {
    const zeroCounters = () =>
      Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0])) as Record<CounterName, number>
    const zeroRejects = () =>
      Object.fromEntries(INGEST_REJECT_CODES.map((c) => [c, 0])) as Record<IngestRejectCode, number>
    this.counters = zeroCounters()
    this.rejectCounters = zeroRejects()
    this.lastFlushedCounters = zeroCounters()
    this.lastFlushedRejects = zeroRejects()

    for (const name of ALL_SERIES) {
      this.slotSeries[name] = new Float64Array(METRICS_RING_SLOTS).fill(Number.NaN)
    }

    this.hostPaths = { ...DEFAULT_HOST_PATHS, ...options.hostPaths }
    this.netInterface = options.netInterface ?? null
    this.diskDir = options.diskDir ?? null

    if (options.eventLoopMonitor === false) {
      this.elu = null
    } else {
      this.elu = monitorEventLoopDelay({ resolution: 20 })
      this.elu.enable()
    }
  }

  /** Disable the event-loop histogram (idempotent). Called from RelayServer.stop(). */
  dispose(): void {
    this.elu?.disable()
  }

  // --- counter increments (call-sites in relay.ts; no behavior change there) ---
  countIngestOk(): void {
    this.counters.ingestOk += 1
  }
  countIngestReject(code: IngestRejectCode): void {
    this.rejectCounters[code] += 1
  }
  /** Central sendTo() hook: one receipt actually written to an OPEN socket. */
  countReceipt(status: 'accepted' | 'delivered' | 'failed'): void {
    if (status === 'delivered') this.counters.receiptsDelivered += 1
    else if (status === 'accepted') this.counters.receiptsAccepted += 1
    // 'failed' has no sender in the relay (types-only) — deliberately uncounted.
  }
  /** Central sendTo() hook: one error frame actually written to an OPEN socket. */
  countErrorFrame(): void {
    this.counters.errorFramesSent += 1
  }
  countRawWsConnect(): void {
    this.counters.rawWsConnects += 1
  }
  countWsConnect(): void {
    this.counters.wsConnects += 1
  }
  countWsDisconnect(): void {
    this.counters.wsDisconnects += 1
  }
  countInboxEnqueued(): void {
    this.counters.inboxEnqueued += 1
  }
  countInboxDelivered(n: number): void {
    this.counters.inboxDeliveredEntries += n
  }
  countAck(): void {
    this.counters.acks += 1
  }

  /** Record one sqlite ingest-write duration (ms). Reservoir-sampled per bucket. */
  recordSqliteWriteMs(ms: number): void {
    this.sqliteSeen += 1
    if (this.sqliteSamples.length < SQLITE_RESERVOIR_CAP) {
      this.sqliteSamples.push(ms)
    } else {
      const j = Math.floor(Math.random() * this.sqliteSeen)
      if (j < SQLITE_RESERVOIR_CAP) this.sqliteSamples[j] = ms
    }
  }

  /** Monotone counter snapshot (tests / debugging). */
  snapshotCounters(): { [K in CounterName]: number } & { ingestRejects: Record<IngestRejectCode, number> } {
    return { ...this.counters, ingestRejects: { ...this.rejectCounters } }
  }

  /**
   * Flush one bucket. Called every METRICS_BUCKET_SECONDS by the RelayServer
   * timer with wall-clock `nowMs` + current gauges.
   *
   * Clock-gap rules (v2 + review #257):
   * - FORWARD gap > 2 buckets (sleep / clock jump ahead): the missed slots are
   *   written as NULL buckets and the anomaly-spanning counter deltas are
   *   DISCARDED (resnapshot) — never crammed into one lying 10s bucket. Gauges
   *   are instantaneous → still sampled in the current bucket.
   * - BACKWARD jump (elapsed <= 0) or still at-or-behind the last WRITTEN
   *   bucket: the flush is dropped ENTIRELY (no slot — a write would emit a
   *   non-monotonic `t` into query()'s insertion-ordered output). All delta
   *   baselines (counters, net, sqlite reservoir, ELU histogram) are resynced
   *   so the anomaly-spanning deltas are discarded; normal buckets resume with
   *   the first flush that is strictly ahead of the last written stamp again.
   */
  flush(nowMs: number, gauges: MetricsGauges): void {
    const bucketMs = METRICS_BUCKET_SECONDS * 1000
    let gap = false
    if (this.lastFlushMs !== null) {
      const elapsed = nowMs - this.lastFlushMs
      if (elapsed <= 0 || (this.lastWrittenT !== null && nowMs <= this.lastWrittenT)) {
        // Backward/frozen clock — or the clock recovered forward but is STILL
        // behind the last written bucket. Skip the bucket entirely (strict
        // t-monotonicity), discard the anomaly-spanning deltas.
        this.resyncDeltaBaselines()
        this.lastFlushMs = nowMs
        return
      }
      if (elapsed > 2 * bucketMs) {
        gap = true
        const missed = Math.min(Math.floor(elapsed / bucketMs) - 1, METRICS_RING_SLOTS)
        for (let i = 0; i < missed; i++) {
          const t = this.lastFlushMs + (i + 1) * bucketMs
          // After a backward jump the projected missed-slot times can still lie
          // at-or-behind the last written bucket — keep `t` strictly monotonic.
          if (this.lastWrittenT !== null && t <= this.lastWrittenT) continue
          this.writeSlot(t, null)
        }
      }
    }

    const values: Record<string, number> = {}

    // Counter deltas (discarded on gap; snapshots ALWAYS advance).
    for (const name of COUNTER_NAMES) {
      const delta = this.counters[name] - this.lastFlushedCounters[name]
      values[name] = gap ? Number.NaN : delta
      this.lastFlushedCounters[name] = this.counters[name]
    }
    for (const code of INGEST_REJECT_CODES) {
      const delta = this.rejectCounters[code] - this.lastFlushedRejects[code]
      values[rejectColumn(code)] = gap ? Number.NaN : delta
      this.lastFlushedRejects[code] = this.rejectCounters[code]
    }

    // Net byte deltas from the cumulative /proc/net/dev counters. A negative
    // delta (interface/counter reset) or an interface change is a gap for this
    // series. First flush has no previous reading → NaN.
    const net = readNetDev(this.hostPaths.netDev, this.netInterface)
    if (!gap && net && this.lastNet && net.iface === this.lastNet.iface) {
      const dRx = net.rxBytes - this.lastNet.rxBytes
      const dTx = net.txBytes - this.lastNet.txBytes
      values.netRxBytes = dRx >= 0 ? dRx : Number.NaN
      values.netTxBytes = dTx >= 0 ? dTx : Number.NaN
    } else {
      values.netRxBytes = Number.NaN
      values.netTxBytes = Number.NaN
    }
    this.lastNet = net

    // Gauges — process.
    if (this.elu) {
      values.eventLoopLagP99Ms = this.elu.percentile(99) / 1e6 // ns → ms
      this.elu.reset()
    } else {
      values.eventLoopLagP99Ms = Number.NaN
    }
    values.sqliteWriteP95Ms = this.drainSqliteP95()
    const mem = process.memoryUsage()
    values.rssMB = mem.rss / (1024 * 1024)
    values.heapUsedMB = mem.heapUsed / (1024 * 1024)
    values.connections = gauges.connections
    values.queuePendingTotal = gauges.queuePendingTotal

    // Gauges — host (best-effort → NaN).
    const [l1, l5, l15] = os.loadavg()
    values.loadavg1 = l1
    values.loadavg5 = l5
    values.loadavg15 = l15
    const meminfo = readMeminfo(this.hostPaths.meminfo)
    values.memAvailableMB = meminfo?.availableMB ?? Number.NaN
    values.memTotalMB = meminfo?.totalMB ?? Number.NaN
    const disk = readDisk(this.diskDir)
    values.diskFreeMB = disk?.freeMB ?? Number.NaN
    values.diskTotalMB = disk?.totalMB ?? Number.NaN
    values.cpuTempC = readCpuTempC(this.hostPaths.cpuTemp) ?? Number.NaN

    this.writeSlot(nowMs, values)
    this.lastFlushMs = nowMs
  }

  /**
   * Resync EVERY delta baseline to "now" without writing a slot — the skip path
   * of a backward clock jump. Counters/net advance their snapshots (discarding
   * the anomaly-spanning deltas), the sqlite reservoir is drained and the ELU
   * histogram reset so the next written bucket measures only its own span.
   */
  private resyncDeltaBaselines(): void {
    for (const name of COUNTER_NAMES) this.lastFlushedCounters[name] = this.counters[name]
    for (const code of INGEST_REJECT_CODES) this.lastFlushedRejects[code] = this.rejectCounters[code]
    this.lastNet = readNetDev(this.hostPaths.netDev, this.netInterface)
    this.sqliteSamples = []
    this.sqliteSeen = 0
    this.elu?.reset()
  }

  private drainSqliteP95(): number {
    if (this.sqliteSamples.length === 0) {
      this.sqliteSeen = 0
      return Number.NaN
    }
    const sorted = [...this.sqliteSamples].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
    this.sqliteSamples = []
    this.sqliteSeen = 0
    return sorted[idx]
  }

  /** Write one ring slot; `values === null` writes a NULL (gap) bucket.
   * Callers guarantee strictly increasing `t` (see flush) — tracked here. */
  private writeSlot(t: number, values: Record<string, number> | null): void {
    const idx = this.writeIdx
    this.slotT[idx] = t
    for (const name of ALL_SERIES) {
      this.slotSeries[name][idx] = values === null ? Number.NaN : (values[name] ?? Number.NaN)
    }
    this.writeIdx = (idx + 1) % METRICS_RING_SLOTS
    this.written = Math.min(this.written + 1, METRICS_RING_SLOTS)
    this.lastWrittenT = t
  }

  /**
   * Read the window, downsampled on-read to ≤ METRICS_MAX_POINTS by merging
   * CONSECUTIVE buckets (groups aligned from the newest so the most recent point
   * is always a full group). Aggregation per series kind (SERIES_AGG); NaN slots
   * are skipped inside a group, an all-NaN group serializes as null. Every output
   * bucket carries `spanSeconds` so clients can derive honest rates.
   */
  query(window: MetricsWindowKey, nowMs: number): MetricsQueryResult {
    const windowSeconds = METRICS_WINDOWS[window]
    const minT = nowMs - windowSeconds * 1000

    // Chronological slot indices inside the window.
    const slots: number[] = []
    for (let i = 0; i < this.written; i++) {
      const idx = (this.writeIdx - this.written + i + METRICS_RING_SLOTS) % METRICS_RING_SLOTS
      const t = this.slotT[idx]
      if (!Number.isNaN(t) && t >= minT && t <= nowMs) slots.push(idx)
    }

    const wanted = Math.ceil(windowSeconds / METRICS_BUCKET_SECONDS)
    const mergeFactor = Math.max(1, Math.ceil(wanted / METRICS_MAX_POINTS))

    const buckets: MetricsBucket[] = []
    // Group from the END (newest group full); emit chronologically.
    for (let end = slots.length; end > 0; end -= mergeFactor) {
      const start = Math.max(0, end - mergeFactor)
      buckets.unshift(this.mergeGroup(slots.slice(start, end)))
    }
    return { bucketSeconds: METRICS_BUCKET_SECONDS, window, windowSeconds, buckets }
  }

  private mergeGroup(group: number[]): MetricsBucket {
    const agg = (name: string): number | null => {
      const kind = SERIES_AGG[name]
      let acc: number | null = null
      let n = 0
      for (const idx of group) {
        const v = this.slotSeries[name][idx]
        if (Number.isNaN(v)) continue
        n += 1
        if (acc === null) acc = v
        else if (kind === 'sum' || kind === 'avg') acc += v
        else if (kind === 'max') acc = Math.max(acc, v)
        else acc = Math.min(acc, v)
      }
      if (acc === null) return null
      if (kind === 'avg') acc /= n
      return Math.round(acc * 1000) / 1000
    }

    const bucket: MetricsBucket = {
      t: this.slotT[group[group.length - 1]], // newest slot's wall-clock stamp
      spanSeconds: group.length * METRICS_BUCKET_SECONDS,
      ingestRejectByCode: null,
    }
    // Gap flag (review #257): counters are written all-or-nothing per slot (a
    // normal bucket always carries numeric deltas >= 0), so a NaN in the
    // ingestOk column identifies an EXPLICIT gap slot — a missed-slot null
    // bucket or the post-gap bucket whose deltas were discarded. Without this
    // flag, downsampling would BLUR gaps (one valid sibling slot yields a value)
    // that the 15m/1h views correctly render as line breaks.
    if (group.some((idx) => Number.isNaN(this.slotSeries.ingestOk[idx]))) bucket.gap = true
    for (const name of ALL_SERIES) {
      if (name.startsWith('reject_')) continue // folded into ingestRejectByCode below
      bucket[name] = agg(name)
    }
    // Rejects: closed catalog → object of the NON-ZERO codes; null when the whole
    // group is a gap (mirrors the other counter fields).
    let rejects: Partial<Record<IngestRejectCode, number>> | null = null
    for (const code of INGEST_REJECT_CODES) {
      const v = agg(rejectColumn(code))
      if (v === null) continue
      rejects ??= {}
      if (v > 0) rejects[code] = v
    }
    bucket.ingestRejectByCode = rejects
    return bucket
  }
}
