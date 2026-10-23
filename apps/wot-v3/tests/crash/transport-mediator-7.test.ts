// @vitest-environment node
// Seed 7 of the VTI mediator matrix, one seed per file: a file alone stays under 8 s (the seeds run
// real TSP and DIDComm crypto in turns). The harness, its cells and invariants are in
// transport-mediator.harness.ts, the contract in src/adapters/rltp/TRANSPORT.md.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { forced, run, SEED_TIMEOUT_MS, visited } from './transport-mediator.harness'

vi.mock('@real-life/trust-protocol', async (importOriginal) => (await import('./transport-mediator.lib')).mockLib(importOriginal))

describe('transport contract against the VTI mediator under wire faults, seed 7', () => {
  afterAll(() => {
    expect(forced(7).filter((c) => !visited.has(c)), 'cells the run did not hit').toEqual([])
  })
  it('custody, generations and the send state hold under every fault', async () => run(7), SEED_TIMEOUT_MS)
})
