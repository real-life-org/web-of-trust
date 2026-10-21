// @vitest-environment node
// Batch 2 of the transport fault injection (seeds 3 to 4); the harness and its invariants are in
// transport-faults.harness.ts, the contract in src/adapters/rltp/TRANSPORT.md. `SEED=<n>` reruns one seed.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { forced, run, visited } from './transport-faults.harness'

vi.mock('@real-life/trust-protocol', async (importOriginal) => (await import('./transport-faults.lib')).mockLib(importOriginal))

const ONLY = process.env.SEED ? Number(process.env.SEED) : null
const SEEDS = [3, 4].filter((s) => ONLY === null || s === ONLY)

describe('transport adapter contract under carrier faults, batch 2', () => {
  afterAll(() => {
    if (ONLY === null) expect(SEEDS.flatMap(forced).filter((c) => !visited.has(c)), 'cells no run hit').toEqual([])
  })
  it.each(SEEDS)('seed %i: every fault is later, custody and generations hold', async (seed) => run(seed), 60_000)
})
