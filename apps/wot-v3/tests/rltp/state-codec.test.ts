// @vitest-environment node
// A stored holder state the library refuses (lib 0.9.0: a 0.8 state names its types without the
// `/spec/` segment and `decodeState` refuses it as `codec-type-uri`, fail-closed). The opening ends
// with a typed refusal the unlock flow shows (recovery or delete), never a throw that reads as
// "open in another tab"; the namespace is left free for the next attempt.
import { expect, it, vi } from 'vitest'
import { memoryCarrier } from '../../src/adapters/rltp/transport'
import { virtualClock } from '../../src/platform/fake'
import { loopbackDevice, LOOPBACK_PHRASES } from '../../harness/loopback'
import { secret } from '../../src/port'

const fault = vi.hoisted(() => ({ code: null as null | string }))
vi.mock('@real-life/trust-protocol', async (importOriginal) => {
  const lib = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<unknown>; StateCodecError: new (code: string, message: string) => Error }>()
  return {
    ...lib,
    createHolder: async (...args: unknown[]) => {
      if (fault.code) throw new lib.StateCodecError(fault.code, 'stored state refused')
      return lib.createHolder(...args)
    },
  }
})

it('an opening over a state the library refuses answers state-unreadable, and the next opening works', async () => {
  const clock = virtualClock(Date.parse('2026-10-26T10:00:00Z'), 'UTC')
  const A = await loopbackDevice({ carrier: memoryCarrier(), clock, id: 'A', name: 'A', words: LOOPBACK_PHRASES[0], seed: 26090 })
  try {
    await A.port.runtime.lock('user')
    expect((await A.port.runtime.unlock.passphrase(secret('harness passphrase'))).ok).toBe(true)
    fault.code = 'codec-type-uri'
    expect(await A.port.runtime.unlock.open()).toEqual({ ok: false, error: { kind: 'infra', code: 'state-unreadable', retryable: false } })
    expect(A.port.runtime.state.get().status).not.toBe('other-writer')
    fault.code = null
    expect((await A.port.runtime.unlock.open()).ok).toBe(true)
    expect(A.port.runtime.state.get()).toMatchObject({ status: 'unlocked' })
  } finally {
    fault.code = null
    await A.port.runtime.lock('user')
  }
})
