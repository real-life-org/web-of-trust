/**
 * Festival-Scale-Stress — report shape + writer.
 *
 * The report is the actual PRODUCT of a run: a machine-readable JSON with fixed field
 * names plus a generated Markdown summary. Hard-gates (zero-loss / zero-error /
 * process-survived) are booleans; latencies + convergence times are BASELINE numbers
 * (reported, not gated — Anton makes the go/no-go call from the report).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { StressConfig } from './config'
import type { SpaceAuditResult } from './audit'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export interface LatencyPercentiles {
  count: number
  p50: number
  p95: number
  p99: number
  max: number
}

export interface ResourceSnapshot {
  memoryMB: number
  totalLogBytes: number
  docCount: number
  connectionCount: number
}

export interface StressReport {
  stamp: string
  mode: StressConfig['mode']
  config: StressConfig
  /** Hard gates. */
  gates: {
    processSurvived: boolean
    zeroLoss: boolean
    zeroUnexpectedErrors: boolean
    removedMemberReadsNothing: boolean
    remainingMembersWriteAfterRotation: boolean
    passed: boolean
  }
  /** Zero-loss detail per space. */
  audit: SpaceAuditResult[]
  /** Client-convergence: writeIds each online device applied within budget. */
  convergence: {
    devicesChecked: number
    devicesConverged: number
    timeToConvergeMs: number | null
  }
  /** Error-code tally across all clients (steady-state vs rotation-phase; expected classified). */
  errors: {
    byCode: Record<string, number>
    /** Errors during membership/invite setup — benign relay-whitelist churn, not gated. */
    setupByCode: Record<string, number>
    /** Errors during warm-up/burst/catch-up — gated: any unexpected code here is a real problem. */
    steadyStateByCode: Record<string, number>
    /** Errors induced by the rotation phase (delta) — classified churn, not gated. */
    rotationPhaseByCode: Record<string, number>
    /** Steady-state codes outside the expected set — must be empty to pass. */
    unexpectedByCode: Record<string, number>
    expectedCodes: string[]
  }
  /** Baseline metrics (reported, not gated). */
  baseline: {
    burstLatencyMs: LatencyPercentiles | null
    catchUpConvergeMs: number | null
    resourcesStart: ResourceSnapshot | null
    resourcesEnd: ResourceSnapshot | null
    reconnects: number
    clientEventLoopLagMaxMs: number
    clientSaturationSuspected: boolean
  }
  /** Free-form notes (realism caveats, stalls, coordination warnings). */
  notes: string[]
  wallClockMs: number
}

export function percentiles(samples: number[]): LatencyPercentiles | null {
  if (samples.length === 0) return null
  const s = [...samples].sort((a, b) => a - b)
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  return { count: s.length, p50: at(50), p95: at(95), p99: at(99), max: s[s.length - 1] }
}

export async function writeReport(artifactsDir: string, report: StressReport): Promise<{ jsonPath: string; mdPath: string }> {
  const dir = resolve(REPO_ROOT, artifactsDir)
  await mkdir(dir, { recursive: true })
  const jsonPath = resolve(dir, `stress-report-${report.stamp}.json`)
  const mdPath = resolve(dir, `stress-report-${report.stamp}.md`)
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')
  await writeFile(mdPath, renderMarkdown(report), 'utf8')
  return { jsonPath, mdPath }
}

function renderMarkdown(r: StressReport): string {
  const g = r.gates
  const yn = (b: boolean) => (b ? '✅' : '❌')
  const lat = r.baseline.burstLatencyMs
  const totalMissing = r.audit.reduce((n, a) => n + a.missingWriteIds.length, 0)
  const lines: string[] = []
  lines.push(`# Festival-Scale-Stress Report — ${r.stamp}`)
  lines.push('')
  lines.push(`**Mode:** ${r.mode}   **Relay:** \`${r.config.relayUrl}\`   **Wall-clock:** ${(r.wallClockMs / 1000).toFixed(1)}s`)
  lines.push('')
  lines.push(`**Scale:** ${r.config.users} users / ${r.config.dualDeviceUsers} dual-device / ${r.config.spaces} spaces / ${r.config.burstMsgsPerDevice} burst-msgs/device / seed ${r.config.seed}`)
  lines.push('')
  lines.push('## Hard gates')
  lines.push('')
  lines.push(`| Gate | Result |`)
  lines.push(`|---|---|`)
  lines.push(`| Process survived | ${yn(g.processSurvived)} |`)
  lines.push(`| Zero-loss (writeId completeness) | ${yn(g.zeroLoss)} (${totalMissing} missing) |`)
  lines.push(`| Zero unexpected errors | ${yn(g.zeroUnexpectedErrors)} |`)
  lines.push(`| Removed member reads nothing | ${yn(g.removedMemberReadsNothing)} |`)
  lines.push(`| Remaining members write after rotation | ${yn(g.remainingMembersWriteAfterRotation)} |`)
  lines.push(`| **OVERALL** | **${yn(g.passed)}** |`)
  lines.push('')
  lines.push('## Convergence')
  lines.push('')
  lines.push(`- Devices converged: ${r.convergence.devicesConverged}/${r.convergence.devicesChecked}`)
  lines.push(`- Time-to-converge (last write → all applied): ${r.convergence.timeToConvergeMs ?? 'n/a'} ms`)
  lines.push('')
  lines.push('## Baseline (reported, not gated)')
  lines.push('')
  if (lat) lines.push(`- Burst latency: p50 ${lat.p50}ms / p95 ${lat.p95}ms / p99 ${lat.p99}ms / max ${lat.max}ms (n=${lat.count})`)
  else lines.push(`- Burst latency: no samples`)
  lines.push(`- Offline catch-up converge: ${r.baseline.catchUpConvergeMs ?? 'n/a'} ms`)
  lines.push(`- Reconnects: ${r.baseline.reconnects}`)
  if (r.baseline.resourcesStart && r.baseline.resourcesEnd) {
    lines.push(
      `- Relay RSS: ${r.baseline.resourcesStart.memoryMB.toFixed(1)}MB → ${r.baseline.resourcesEnd.memoryMB.toFixed(1)}MB; ` +
        `log bytes: ${r.baseline.resourcesStart.totalLogBytes} → ${r.baseline.resourcesEnd.totalLogBytes}`,
    )
  }
  lines.push(`- Client event-loop lag max: ${r.baseline.clientEventLoopLagMaxMs.toFixed(0)}ms${r.baseline.clientSaturationSuspected ? ' ⚠️ CLIENT-LIMITED — treat latencies as client-saturated, not relay' : ''}`)
  lines.push('')
  lines.push('## Errors')
  lines.push('')
  lines.push(`- Expected (classified): ${r.errors.expectedCodes.join(', ') || 'none'}`)
  lines.push(`- Setup/invite (classified churn) by code: ${JSON.stringify(r.errors.setupByCode)}`)
  lines.push(`- Steady-state write-phase (gated) by code: ${JSON.stringify(r.errors.steadyStateByCode)}`)
  lines.push(`- Rotation-phase (classified churn) by code: ${JSON.stringify(r.errors.rotationPhaseByCode)}`)
  lines.push(`- **Unexpected steady-state** error frames: ${JSON.stringify(r.errors.unexpectedByCode)}`)
  lines.push('')
  lines.push('## Per-space audit')
  lines.push('')
  lines.push(`| Space | pulled | decrypted | missing writeIds | seq-gaps (expl/unexpl) | stalled |`)
  lines.push(`|---|---|---|---|---|---|`)
  for (const a of r.audit) {
    const expl = a.seqGaps.filter((x) => x.classification === 'explained').length
    const unexpl = a.seqGaps.filter((x) => x.classification === 'unexplained').length
    lines.push(`| ${a.spaceId.slice(0, 8)} | ${a.entriesPulled} | ${a.entriesDecrypted} | ${a.missingWriteIds.length} | ${expl}/${unexpl} | ${a.stalled ? 'yes' : 'no'} |`)
  }
  lines.push('')
  if (r.notes.length) {
    lines.push('## Notes')
    lines.push('')
    for (const n of r.notes) lines.push(`- ${n}`)
    lines.push('')
  }
  return lines.join('\n')
}
