// @vitest-environment node
// Batch 9 of the transport fault injection (seed 16, the second half of seed 1's cells); the harness and its invariants are in
// transport-faults.harness.ts, the contract in src/adapters/rltp/TRANSPORT.md. `SEED=<n>` reruns one seed.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CELLS, forced, run, SEED_TIMEOUT_MS, SEEDS_ALL, visited } from './transport-faults.harness'

vi.mock('@real-life/trust-protocol', async (importOriginal) => (await import('./transport-faults.lib')).mockLib(importOriginal))

const ONLY = process.env.SEED ? Number(process.env.SEED) : null
const SEEDS = [16].filter((s) => ONLY === null || s === ONLY)

describe('transport adapter contract under carrier faults, batch 9', () => {
  afterAll(() => {
    if (ONLY === null) expect(SEEDS.flatMap(forced).filter((c) => !visited.has(c)), 'cells no run hit').toEqual([])
  })
  it('the seeds together arm every cell, each exactly once', () => {
    const armed = SEEDS_ALL.flatMap(forced)
    expect([...armed].sort()).toEqual([...CELLS].sort())
  })
  it.each(SEEDS)('seed %i: every fault is later, custody and generations hold', async (seed) => run(seed), SEED_TIMEOUT_MS)
})
