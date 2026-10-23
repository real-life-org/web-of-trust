// @vitest-environment node
// Seed 13 of the VTI mediator matrix, one seed per file: a file alone stays under 8 s (the seeds run
// real TSP and DIDComm crypto in turns). The harness, its cells and invariants are in
// transport-mediator.harness.ts, the contract in src/adapters/rltp/TRANSPORT.md.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CELLS, forced, run, SEED_TIMEOUT_MS, SEEDS_ALL, visited } from './transport-mediator.harness'

vi.mock('@real-life/trust-protocol', async (importOriginal) => (await import('./transport-mediator.lib')).mockLib(importOriginal))

describe('transport contract against the VTI mediator under wire faults, seed 13', () => {
  afterAll(() => {
    expect(forced(13).filter((c) => !visited.has(c)), 'cells the run did not hit').toEqual([])
  })
  it('the seeds together arm every cell, each exactly once', () => {
    const armed = SEEDS_ALL.flatMap(forced)
    expect([...armed].sort()).toEqual([...CELLS].sort())
  })
  it('custody, generations and the send state hold under every fault', async () => run(13), SEED_TIMEOUT_MS)
})
