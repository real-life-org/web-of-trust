// @vitest-environment node
// The request to the groups' members when a device opens (web-of-trust#534): a failure is tried again
// by the opening's timer, with a growing pause, without a new foreground; and a resume that failed
// first does not skip it.
import { describe, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ sync: 0, resume: 0, calls: 0 }))
vi.mock('@real-life/trust-protocol', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown> & { createHolder: (...a: unknown[]) => Promise<Record<string, (...x: unknown[]) => unknown>> }>()
  return {
    ...real,
    createHolder: async (...a: unknown[]) => {
      const h = await real.createHolder(...a)
      // the holder is frozen: a wrapper that inherits every other method
      const w = Object.create(h, {
        syncGroups: {
          value: async (...x: unknown[]) => {
            fault.calls++
            if (fault.sync > 0) { fault.sync--; throw new Error('storage unavailable') }
            return h.syncGroups!(...x)
          },
        },
        resume: {
          value: async (...x: unknown[]) => {
            if (fault.resume > 0) { fault.resume--; throw new Error('storage unavailable') }
            return h.resume!(...x)
          },
        },
      }) as Record<string, (...x: unknown[]) => unknown>
      return w
    },
  }
})

import { pair } from './pair'

const step = async (p: Awaited<ReturnType<typeof pair>>, ms: number) => {
  p.clock.advance(ms)
  await p.settle()
}

describe('group catch-up at opening', () => {
  it('a failed request is tried again after a second, then after five; once it went through nothing more is asked', async () => {
    Object.assign(fault, { sync: 2, resume: 0, calls: 0 })
    const p = await pair()
    // the request of each of the two openings failed
    expect(fault.calls).toBe(2)
    await step(p, 1000)
    // both ask again after a second, with no foreground in between, and get through
    expect(fault.calls).toBe(4)
    await step(p, 60_000)
    await step(p, 60_000)
    expect(fault.calls).toBe(4)
    await p.close()
  })

  it('the pause grows: a second failure waits five seconds', async () => {
    // A and B fail at opening, and both fail again at the first retry
    Object.assign(fault, { sync: 4, resume: 0, calls: 0 })
    const p = await pair()
    expect(fault.calls).toBe(2)
    await step(p, 1000)
    expect(fault.calls).toBe(4)
    await step(p, 1000)
    expect(fault.calls).toBe(4)
    await step(p, 4000)
    expect(fault.calls).toBe(6)
    await p.close()
  })

  it('a resume that failed first does not skip the request: it follows the resume that completes', async () => {
    Object.assign(fault, { sync: 0, resume: 2, calls: 0 })
    const p = await pair()
    expect(fault.calls).toBe(0)
    await step(p, 1000)
    expect(fault.calls).toBe(2)
    await p.close()
  })
})
