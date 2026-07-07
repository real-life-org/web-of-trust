import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import {
  RelayMetrics,
  toIngestRejectCode,
  readMeminfo,
  readCpuTempC,
  readDisk,
  readNetDev,
  METRICS_RING_SLOTS,
  METRICS_BUCKET_SECONDS,
  INGEST_REJECT_CODES,
} from '../src/metrics.js'

// Relay-Metriken Stufe 1 — unit tests for the in-memory ring: monotone counters →
// per-bucket DELTAS, ring rotation, downsampling semantics per series kind
// (sum/max/min/avg + spanSeconds), clock-gap handling (null buckets, never a giant
// delta), the sqlite p95 reservoir, the closed reject-code catalog, and the
// best-effort host readers (path injection → value; bogus path → null, no throw).

const NO_HOST = { meminfo: '/nonexistent/meminfo', netDev: '/nonexistent/netdev', cpuTemp: '/nonexistent/temp' }
const GAUGES = { connections: 0, queuePendingTotal: 0 }
const T0 = Date.parse('2026-07-07T12:00:00Z')
const BUCKET_MS = METRICS_BUCKET_SECONDS * 1000

function makeMetrics(overrides: Partial<ConstructorParameters<typeof RelayMetrics>[0]> = {}): RelayMetrics {
  return new RelayMetrics({ hostPaths: NO_HOST, diskDir: null, eventLoopMonitor: false, ...overrides })
}

describe('toIngestRejectCode — closed catalog', () => {
  it('maps every known code to itself', () => {
    for (const code of INGEST_REJECT_CODES) expect(toIngestRejectCode(code)).toBe(code)
  })
  it("folds an unknown wire code into 'OTHER' (hard-bounded cardinality)", () => {
    expect(toIngestRejectCode('SOME_FUTURE_CODE')).toBe('OTHER')
    expect(toIngestRejectCode('')).toBe('OTHER')
  })
})

describe('MetricsRing — counters are monotone, buckets carry deltas', () => {
  it('snapshot-diffs the accumulator into per-bucket deltas', () => {
    const m = makeMetrics()
    m.countIngestOk()
    m.countIngestOk()
    m.countIngestOk()
    m.countIngestReject('CAPABILITY_REQUIRED')
    m.flush(T0, GAUGES)
    m.countIngestOk()
    m.countIngestOk()
    m.flush(T0 + BUCKET_MS, GAUGES)

    const { buckets } = m.query('15m', T0 + BUCKET_MS)
    expect(buckets).toHaveLength(2)
    expect(buckets[0].ingestOk).toBe(3)
    expect(buckets[0].ingestRejectByCode).toEqual({ CAPABILITY_REQUIRED: 1 })
    expect(buckets[1].ingestOk).toBe(2)
    expect(buckets[1].ingestRejectByCode).toEqual({})
    // The accumulator itself is MONOTONE (never reset by flush).
    expect(m.snapshotCounters().ingestOk).toBe(5)
    expect(m.snapshotCounters().ingestRejects.CAPABILITY_REQUIRED).toBe(1)
  })

  it('counts inbox/ws/receipt/error series into their own columns', () => {
    const m = makeMetrics()
    m.countRawWsConnect()
    m.countWsConnect()
    m.countWsDisconnect()
    m.countReceipt('delivered')
    m.countReceipt('accepted')
    m.countErrorFrame()
    m.countInboxEnqueued()
    m.countInboxDelivered(3)
    m.countAck()
    m.flush(T0, GAUGES)
    const b = m.query('15m', T0).buckets[0]
    expect(b.rawWsConnects).toBe(1)
    expect(b.wsConnects).toBe(1)
    expect(b.wsDisconnects).toBe(1)
    expect(b.receiptsDelivered).toBe(1)
    expect(b.receiptsAccepted).toBe(1)
    expect(b.errorFramesSent).toBe(1)
    expect(b.inboxEnqueued).toBe(1)
    expect(b.inboxDeliveredEntries).toBe(3)
    expect(b.acks).toBe(1)
  })
})

describe('MetricsRing — ring rotation (24h cap)', () => {
  it('drops the oldest slots once the ring is full', () => {
    const m = makeMetrics()
    const extra = 5
    for (let i = 0; i < METRICS_RING_SLOTS + extra; i++) {
      m.flush(T0 + i * BUCKET_MS, GAUGES)
    }
    const nowMs = T0 + (METRICS_RING_SLOTS + extra - 1) * BUCKET_MS
    const { buckets } = m.query('24h', nowMs)
    // 8640 retained slots at merge factor 24 → exactly 360 points.
    expect(buckets).toHaveLength(360)
    expect(buckets[0].spanSeconds).toBe(24 * METRICS_BUCKET_SECONDS)
    // The first `extra` flushes were overwritten — no bucket reaches back to T0.
    expect(buckets[0].t).toBeGreaterThan(T0 + (extra - 1) * BUCKET_MS)
  }, 30_000)
})

describe('MetricsRing — downsampling semantics per series kind', () => {
  afterEach(() => vi.restoreAllMocks())

  it('merges counters=sum, connections=max, sqliteP95=max, memAvailable=min, loadavg=avg; spanSeconds honest', () => {
    const tmp = mkdtempSync(join(os.tmpdir(), 'wot-metrics-'))
    try {
      const meminfoPath = join(tmp, 'meminfo')
      const loadavgSpy = vi.spyOn(os, 'loadavg')
      const m = makeMetrics({ hostPaths: { ...NO_HOST, meminfo: meminfoPath } })

      // 12 buckets at 10s spacing; every per-bucket value is controlled.
      for (let i = 1; i <= 12; i++) {
        m.countIngestOk() // +1 per bucket
        m.recordSqliteWriteMs(i) // single sample → p95 = i
        loadavgSpy.mockReturnValue([i, 0, 0])
        writeFileSync(meminfoPath, `MemTotal: 16384000 kB\nMemAvailable: ${(1300 - i * 100) * 1024} kB\n`)
        m.flush(T0 + i * BUCKET_MS, { connections: i, queuePendingTotal: 0 })
      }

      // 6h window → wanted 2160 buckets → mergeFactor 6 → two merged points.
      const { buckets, bucketSeconds } = m.query('6h', T0 + 12 * BUCKET_MS)
      expect(bucketSeconds).toBe(METRICS_BUCKET_SECONDS)
      expect(buckets).toHaveLength(2)
      const [a, b] = buckets
      expect(a.spanSeconds).toBe(60)
      expect(b.spanSeconds).toBe(60)
      // counters → SUM
      expect(a.ingestOk).toBe(6)
      expect(b.ingestOk).toBe(6)
      // connections → MAX
      expect(a.connections).toBe(6)
      expect(b.connections).toBe(12)
      // sqliteWriteP95Ms → MAX
      expect(a.sqliteWriteP95Ms).toBe(6)
      expect(b.sqliteWriteP95Ms).toBe(12)
      // memAvailableMB → MIN (scarcest moment; buckets 1..6 → 1200..700, min 700)
      expect(a.memAvailableMB).toBe(700)
      expect(b.memAvailableMB).toBe(100)
      // loadavg1 → AVG (1..6 → 3.5; 7..12 → 9.5)
      expect(a.loadavg1).toBe(3.5)
      expect(b.loadavg1).toBe(9.5)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('does not downsample small windows (15m/1h stay at 10s buckets)', () => {
    const m = makeMetrics()
    for (let i = 0; i < 5; i++) m.flush(T0 + i * BUCKET_MS, GAUGES)
    const { buckets } = m.query('15m', T0 + 4 * BUCKET_MS)
    expect(buckets).toHaveLength(5)
    for (const b of buckets) expect(b.spanSeconds).toBe(METRICS_BUCKET_SECONDS)
  })

  it('downsampling PRESERVES gaps: a merged bucket containing a gap slot carries gap:true (review #257)', () => {
    const m = makeMetrics()
    // 6 normal buckets...
    for (let i = 1; i <= 6; i++) {
      m.countIngestOk()
      m.flush(T0 + i * BUCKET_MS, GAUGES)
    }
    // ...then the relay sleeps 50s → 4 null slots + a post-gap bucket (delta discarded)...
    m.countIngestOk()
    m.flush(T0 + 6 * BUCKET_MS + 50_000, GAUGES)
    // ...then one normal bucket again (12 slots total).
    m.countIngestOk()
    m.flush(T0 + 6 * BUCKET_MS + 60_000, GAUGES)

    // 6h window → mergeFactor 6 → two merged points.
    const { buckets } = m.query('6h', T0 + 6 * BUCKET_MS + 60_000)
    expect(buckets).toHaveLength(2)
    // The older group (6 normal slots): no gap flag, full sum.
    expect(buckets[0].gap).toBeUndefined()
    expect(buckets[0].ingestOk).toBe(6)
    // The newer group contains gap slots → FLAGGED, even though a valid sibling
    // slot contributed a value (exactly the blur the flag fixes — 15m/1h break
    // the line there, so 6h/24h must show the gap too).
    expect(buckets[1].gap).toBe(true)
    expect(buckets[1].ingestOk).toBe(1) // only the post-recovery normal bucket
  })
})

describe('MetricsRing — clock gaps (sleep / clock jump)', () => {
  it('forward gap > 2 buckets → missed slots become NULL buckets, deltas are DISCARDED (no giant bucket)', () => {
    const m = makeMetrics()
    m.flush(T0, { connections: 1, queuePendingTotal: 0 })
    m.countIngestOk()
    m.countIngestOk()
    m.countIngestOk()
    m.countIngestOk()
    // 50s pass (5 bucket widths) — e.g. the Pi was suspended.
    m.flush(T0 + 50_000, { connections: 7, queuePendingTotal: 0 })

    const { buckets } = m.query('15m', T0 + 50_000)
    // t0 bucket + 4 missed null slots + the post-gap bucket.
    expect(buckets).toHaveLength(6)
    // NO bucket claims the accumulated delta of 4 (that would be the lying bucket).
    for (const b of buckets) expect(b.ingestOk === null || b.ingestOk === 0).toBe(true)
    // Missed slots are fully null.
    expect(buckets[2].ingestOk).toBeNull()
    expect(buckets[2].connections).toBeNull()
    // The post-gap bucket: counters null (discarded), but GAUGES are sampled
    // (instantaneous values are valid at flush time regardless of the gap).
    const last = buckets[buckets.length - 1]
    expect(last.ingestOk).toBeNull()
    expect(last.connections).toBe(7)
    // Normal operation resumes on the next flush; the accumulator never lost counts.
    m.countIngestOk()
    m.flush(T0 + 60_000, { connections: 7, queuePendingTotal: 0 })
    const after = m.query('15m', T0 + 60_000).buckets
    expect(after[after.length - 1].ingestOk).toBe(1)
    expect(m.snapshotCounters().ingestOk).toBe(5)
  })

  it('backward clock jump → flush dropped ENTIRELY; query t stays STRICTLY monotonic (review #257)', () => {
    const m = makeMetrics()
    m.flush(T0, GAUGES) // written bucket at t = T0
    m.countIngestOk()
    // Clock jumps BACK 30s: NO slot is written (a write would emit an
    // out-of-order t into query()'s insertion-ordered output).
    m.flush(T0 - 30_000, { connections: 2, queuePendingTotal: 0 })
    expect(m.query('15m', T0).buckets).toHaveLength(1)
    m.countIngestOk()
    // elapsed is +10s now, but the clock is STILL behind the last WRITTEN bucket
    // (T0) — dropped as well (the durable lastWrittenT guard, not just elapsed<=0).
    m.flush(T0 - 20_000, GAUGES)
    expect(m.query('15m', T0).buckets).toHaveLength(1)
    m.countIngestOk()
    // Clock recovered past T0: forward-gap path — the projected missed slots at
    // T0-10s/T0 are clamped away (still at-or-behind lastWrittenT), the current
    // bucket lands at T0+10s as a gap bucket (anomaly-spanning deltas discarded).
    m.flush(T0 + 10_000, GAUGES)
    m.countIngestOk()
    m.flush(T0 + 20_000, GAUGES) // normal again

    const { buckets } = m.query('15m', T0 + 20_000)
    expect(buckets.map((b) => b.t)).toEqual([T0, T0 + 10_000, T0 + 20_000])
    // The review assertion: strictly monotonically increasing t.
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].t).toBeGreaterThan(buckets[i - 1].t)
    }
    // Anomaly-spanning counts never landed in any bucket (discarded, flagged gap)...
    expect(buckets[1].ingestOk).toBeNull()
    expect(buckets[1].gap).toBe(true)
    expect(buckets[2].ingestOk).toBe(1)
    expect(buckets[2].gap).toBeUndefined()
    // ...while the monotone accumulator kept everything.
    expect(m.snapshotCounters().ingestOk).toBe(4)
  })
})

describe('MetricsRing — sqlite p95 reservoir', () => {
  it('computes p95 per bucket and resets between buckets', () => {
    const m = makeMetrics()
    for (let v = 1; v <= 100; v++) m.recordSqliteWriteMs(v)
    m.flush(T0, GAUGES)
    m.flush(T0 + BUCKET_MS, GAUGES) // no samples in this bucket
    const { buckets } = m.query('15m', T0 + BUCKET_MS)
    expect(buckets[0].sqliteWriteP95Ms).toBe(95) // sorted[ceil(0.95*100)-1] = 95
    expect(buckets[1].sqliteWriteP95Ms).toBeNull()
  })
})

describe('Host readers — best-effort with path injection', () => {
  const NETDEV_FIXTURE = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
  eth0:    5000      50    0    0    0     0          0         0     3000      30    0    0    0     0       0          0
 wlan0:     100       1    0    0    0     0          0         0      200       2    0    0    0     0       0          0
`

  it('meminfo: parses MB values; bogus path → null (no throw)', () => {
    const tmp = mkdtempSync(join(os.tmpdir(), 'wot-metrics-'))
    try {
      const p = join(tmp, 'meminfo')
      writeFileSync(p, 'MemTotal: 2048000 kB\nMemFree: 100 kB\nMemAvailable: 1024000 kB\n')
      expect(readMeminfo(p)).toEqual({ availableMB: 1000, totalMB: 2000 })
      expect(readMeminfo('/nonexistent/meminfo')).toBeNull()
      writeFileSync(p, 'garbage')
      expect(readMeminfo(p)).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('cpu temp: milli-°C → °C; bogus path / non-Pi → null', () => {
    const tmp = mkdtempSync(join(os.tmpdir(), 'wot-metrics-'))
    try {
      const p = join(tmp, 'temp')
      writeFileSync(p, '48234\n')
      expect(readCpuTempC(p)).toBeCloseTo(48.234)
      expect(readCpuTempC('/nonexistent/temp')).toBeNull()
      writeFileSync(p, 'not-a-number')
      expect(readCpuTempC(p)).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('disk: statfs on a real dir yields totals; bogus dir / null → null', () => {
    const d = readDisk(os.tmpdir())
    expect(d).not.toBeNull()
    expect(d!.totalMB).toBeGreaterThan(0)
    expect(d!.freeMB).toBeGreaterThanOrEqual(0)
    expect(readDisk('/nonexistent/dir/for/sure')).toBeNull()
    expect(readDisk(null)).toBeNull()
  })

  it('net: first non-lo by default, explicit interface override wins; bogus path → null', () => {
    const tmp = mkdtempSync(join(os.tmpdir(), 'wot-metrics-'))
    try {
      const p = join(tmp, 'netdev')
      writeFileSync(p, NETDEV_FIXTURE)
      expect(readNetDev(p, null)).toEqual({ iface: 'eth0', rxBytes: 5000, txBytes: 3000 })
      expect(readNetDev(p, 'wlan0')).toEqual({ iface: 'wlan0', rxBytes: 100, txBytes: 200 })
      // Unknown override falls back to first non-lo.
      expect(readNetDev(p, 'does-not-exist')?.iface).toBe('eth0')
      expect(readNetDev('/nonexistent/netdev', null)).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('net BYTE COUNTERS: bucket = delta of the cumulative counters; first bucket + counter reset → null', () => {
    const tmp = mkdtempSync(join(os.tmpdir(), 'wot-metrics-'))
    try {
      const p = join(tmp, 'netdev')
      const fixtureAt = (rx: number, tx: number) =>
        NETDEV_FIXTURE.replace('    5000', String(rx).padStart(8)).replace('     3000', String(tx).padStart(9))
      writeFileSync(p, fixtureAt(5000, 3000))
      const m = makeMetrics({ hostPaths: { ...NO_HOST, netDev: p } })
      m.flush(T0, GAUGES) // first reading — no previous → null
      writeFileSync(p, fixtureAt(7000, 3500))
      m.flush(T0 + BUCKET_MS, GAUGES)
      writeFileSync(p, fixtureAt(100, 100)) // counter RESET (reboot/iface restart)
      m.flush(T0 + 2 * BUCKET_MS, GAUGES)
      const { buckets } = m.query('15m', T0 + 2 * BUCKET_MS)
      expect(buckets[0].netRxBytes).toBeNull()
      expect(buckets[1].netRxBytes).toBe(2000)
      expect(buckets[1].netTxBytes).toBe(500)
      expect(buckets[2].netRxBytes).toBeNull() // negative delta → gap, never negative
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('flush with ALL host sources missing yields null host gauges, never throws', () => {
    const m = makeMetrics()
    m.flush(T0, GAUGES)
    const b = m.query('15m', T0).buckets[0]
    expect(b.memAvailableMB).toBeNull()
    expect(b.memTotalMB).toBeNull()
    expect(b.diskFreeMB).toBeNull()
    expect(b.diskTotalMB).toBeNull()
    expect(b.cpuTempC).toBeNull()
    expect(b.netRxBytes).toBeNull()
    // Process gauges are always available.
    expect(b.rssMB).toBeGreaterThan(0)
    expect(b.heapUsedMB).toBeGreaterThan(0)
    // loadavg comes from os.loadavg() (host-wide, works in containers).
    expect(typeof b.loadavg1).toBe('number')
  })
})
