import { describe, it, expect, afterEach } from 'vitest'
import { loadConfig } from '../stress/config'

// The offline storm NEEDS a non-empty online cohort writing during the window —
// OFFLINE_COHORT_PCT ≥ 100 would take every device offline and silently test
// nothing. The config fail-fasts instead (operator error, not a quiet no-op run).
//
// Note: the numeric knobs are read via process.env (intEnv), so the tests set
// process.env directly and restore it afterwards.

describe('Festival-Scale-Stress config validation', () => {
  const now = new Date('2026-07-04T12:00:00.000Z')
  const load = () => loadConfig(process.env, now)

  afterEach(() => {
    delete process.env.OFFLINE_COHORT_PCT
  })

  it('rejects OFFLINE_COHORT_PCT >= 100 with a clear operator error', () => {
    process.env.OFFLINE_COHORT_PCT = '100'
    expect(load).toThrow(/0\.\.99/)
    process.env.OFFLINE_COHORT_PCT = '150'
    expect(load).toThrow(/ONLINE cohort/)
  })

  it('accepts the 0..99 range (bounds + default)', () => {
    process.env.OFFLINE_COHORT_PCT = '0'
    expect(load().offlineCohortPct).toBe(0)
    process.env.OFFLINE_COHORT_PCT = '99'
    expect(load().offlineCohortPct).toBe(99)
    delete process.env.OFFLINE_COHORT_PCT
    expect(load().offlineCohortPct).toBe(30)
  })
})
