// The ActError table of the real adapter covers the pinned library completely (architecture §2.6).
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ACT_ERRORS, mapActError } from '../src/adapters/rltp/errors'

describe('adapters/rltp/errors', () => {
  it('maps journal misuse to bug and encounter refusals to surface codes', () => {
    expect(mapActError('actid-conflict')).toMatchObject({ kind: 'bug' })
    expect(mapActError('gate-expired')).toEqual({ kind: 'refused', code: 'code-expired' })
    expect(mapActError('consumed-challenge')).toEqual({ kind: 'refused', code: 'code-used' })
    expect(mapActError('unknown-prompt')).toEqual({ kind: 'refused', code: 'decision-gone' })
  })

  it('has an entry for every code (compile-time: satisfies Record<ActError, …>)', () => {
    expect(Object.keys(ACT_ERRORS).length).toBeGreaterThan(30)
  })
})
