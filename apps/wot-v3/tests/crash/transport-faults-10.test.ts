// @vitest-environment node
// Batch 10 of the transport fault injection (seed 19, the second part of seed 15's cells); the harness and its invariants are in
// transport-faults.harness.ts, the contract in src/adapters/rltp/TRANSPORT.md. `SEED=<n>` reruns one seed.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CELLS, forced, run, SEED_TIMEOUT_MS, SEEDS_ALL, visited } from './transport-faults.harness'

vi.mock('@real-life/trust-protocol', async (importOriginal) => (await import('./transport-faults.lib')).mockLib(importOriginal))

const ONLY = process.env.SEED ? Number(process.env.SEED) : null
const SEEDS = [19].filter((s) => ONLY === null || s === ONLY)

describe('transport adapter contract under carrier faults, batch 10', () => {
  afterAll(() => {
    if (ONLY === null) expect(SEEDS.flatMap(forced).filter((c) => !visited.has(c)), 'cells no run hit').toEqual([])
  })
  it('the seeds together arm every cell, each exactly once', () => {
    const armed = SEEDS_ALL.flatMap(forced)
    expect([...armed].sort()).toEqual([...CELLS].sort())
  })
  it.each(SEEDS)('seed %i: every fault is later, custody and generations hold', async (seed) => run(seed), SEED_TIMEOUT_MS)
})
