// Timeline of a scenario (architecture §7.1 `timeline`): offsets in virtual time and the line the
// player's step list shows for each step. Phones are numbered from 1 for people, from 0 in data.
import type { Step } from '../scenario'

const UNIT: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** '+2s', '+5m', '+1h', '+1d' → milliseconds. */
export function parseOffset(at: string): number {
  const m = /^\+(\d+)([smhd])$/.exec(at)
  const unit = m ? UNIT[m[2] ?? ''] : undefined
  if (!m || unit === undefined) throw new Error(`timeline: bad offset ${JSON.stringify(at)} (expected +<n>s|m|h|d)`)
  return Number(m[1]) * unit
}

export function describeStep(step: Step): string {
  if (step.note) return step.note
  if ('send' in step) return `phone ${step.send.from + 1} → phone ${step.send.to + 1}: “${step.send.text}”`
  if ('fault' in step) {
    return `fault: ${Object.entries(step.fault)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(', ')}`
  }
  const target = `phone ${(step.phone ?? 0) + 1}`
  return 'key' in step.world ? `${target}: ${step.world.type} ${step.world.key}` : `${target}: ${step.world.type}`
}

/** Offset of `tz` at the instant `at` in ms (local − UTC). */
function zoneOffset(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at / 1000) * 1000
}

/** A wall time 'YYYY-MM-DDTHH:mm' in the time zone `tz`, resolved with the offset valid on that
 *  date (summer or winter time), as epoch ms; NaN for an unreadable value. */
export function zonedWallTime(local: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
  if (!m) return Number.NaN
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  const first = asUtc - zoneOffset(asUtc, tz)
  return asUtc - zoneOffset(first, tz)
}
