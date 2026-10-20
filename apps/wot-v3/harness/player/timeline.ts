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
