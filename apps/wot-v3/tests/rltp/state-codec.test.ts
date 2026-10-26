// @vitest-environment node
// A stored holder state the library refuses (fail-closed). lib 0.9.0 refuses a state lib 0.8 wrote,
// whose types lack the `/spec/` segment, as `codec-type-uri`. The real path: the state is committed
// into the opening's own (sealed) holder store, the library's load decodes it and throws. The opening
// ends in a typed refusal that names the cause (an earlier version, a newer version, an unknown
// format, a damaged state), never a throw that reads as "open in another tab"; the namespace stays free.
// fixtures/state-v3-lib-0.8.json: trust-protocol lib/test/fixtures/state-v3-lib-0.8.json (the open
// fixture as lib 0.8.0 wrote it), copied unchanged from trust-protocol origin/main c1a2d28 (last
// changed in 517e963).
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { memoryCarrier } from '../../src/adapters/rltp/transport'
import { virtualClock } from '../../src/platform/fake'
import { loopbackDevice, LOOPBACK_PHRASES } from '../../harness/loopback'
import { secret } from '../../src/port'

const lib08 = JSON.parse(readFileSync(new URL('./fixtures/state-v3-lib-0.8.json', import.meta.url), 'utf8')) as Record<string, unknown>

const fault = vi.hoisted(() => ({ state: undefined as unknown, own: undefined as unknown }))
vi.mock('@real-life/trust-protocol', async (importOriginal) => {
  type Store = { read(): Promise<{ version: string | null; state: unknown }>; commit(v: string | null, s: unknown): Promise<{ ok: boolean }> }
  const lib = await importOriginal<{ createHolder: (o: { store: Store }, ...rest: unknown[]) => Promise<unknown> }>()
  return {
    ...lib,
    createHolder: async (o: { store: Store }, ...rest: unknown[]) => {
      if (fault.state !== undefined) {
        // the stored state of an earlier (or other) writer, in the opening's own store
        const snap = await o.store.read()
        fault.own ??= snap.state
        if (!(await o.store.commit(snap.version, fault.state)).ok) throw new Error('fixture commit')
      }
      return lib.createHolder(o, ...rest)
    },
  }
})

const CASES: readonly [string, unknown, string][] = [
  ['a state lib 0.8 wrote (codec-type-uri)', lib08, 'earlier'],
  ['a state of a newer codec (codec-newer)', { ...lib08, codec: 4 }, 'newer'],
  ['a codec that is no codec (codec-unknown)', { ...lib08, codec: -1 }, 'unknown'],
  ['a state of the wrong shape (shape)', { codec: 3 }, 'damaged'],
  ['a state that is no JSON (not-json)', '{', 'damaged'],
]

it.each(CASES)('%s: the opening answers state-unreadable with its cause, and an opening over a good state works', async (_, state, cause) => {
  const clock = virtualClock(Date.parse('2026-10-26T10:00:00Z'), 'UTC')
  const A = await loopbackDevice({ carrier: memoryCarrier(), clock, id: 'A', name: 'A', words: LOOPBACK_PHRASES[0], seed: 26090 })
  try {
    await A.port.runtime.lock('user')
    expect((await A.port.runtime.unlock.passphrase(secret('harness passphrase'))).ok).toBe(true)
    fault.state = state
    expect(await A.port.runtime.unlock.open()).toEqual({ ok: false, error: { kind: 'state-unreadable', cause } })
    expect(A.port.runtime.state.get().status).not.toBe('other-writer')
    // the namespace is free: an opening over the device's own state goes through
    fault.state = fault.own
    expect((await A.port.runtime.unlock.open()).ok).toBe(true)
    expect(A.port.runtime.state.get()).toMatchObject({ status: 'unlocked' })
  } finally {
    fault.state = undefined
    fault.own = undefined
    await A.port.runtime.lock('user')
  }
})
