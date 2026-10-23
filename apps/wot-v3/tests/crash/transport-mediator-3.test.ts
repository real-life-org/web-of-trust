// @vitest-environment node
// Batch 3 of the VTI mediator matrix (seeds 5 and 6); the harness, its cells and invariants are in
// transport-mediator.harness.ts, the contract in src/adapters/rltp/TRANSPORT.md. `SEED=<n>` reruns one seed.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { forced, run, SEED_TIMEOUT_MS, visited } from './transport-mediator.harness'

vi.mock('@real-life/trust-protocol', async (importOriginal) => (await import('./transport-mediator.lib')).mockLib(importOriginal))

const ONLY = process.env.SEED ? Number(process.env.SEED) : null
const SEEDS = [5, 6].filter((s) => ONLY === null || s === ONLY)

describe('transport contract against the VTI mediator under wire faults, batch 3', () => {
  afterAll(() => {
    if (ONLY === null) expect(SEEDS.flatMap(forced).filter((c) => !visited.has(c)), 'cells no run hit').toEqual([])
  })
  it.each(SEEDS)('seed %i: custody, generations and the send state hold under every fault', async (seed) => run(seed), SEED_TIMEOUT_MS)
})
