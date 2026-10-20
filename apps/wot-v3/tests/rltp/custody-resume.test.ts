// @vitest-environment node
// A failed resume hands nothing over (Delivery RLTP-DEL-6130, 6135; lib 0.6.0 pendingTransport
// answers not-resumed until a resume of the opening completed). Review 421 R7-1: a failed tick or
// resume at opening must not let a kept copy go out.
import { expect, it, vi } from 'vitest'
import { DAY, counting, isAck, pair } from './pair'

const fault = vi.hoisted(() => ({ resume: false, tick: false }))
// the core library is the adapter's alone (architecture §0.1): the test sees it only through the mock
interface HolderLike { resume(when: number): Promise<unknown>; tick(when: number): Promise<unknown>; readonly closed: boolean }
vi.mock('@real-life/trust-protocol', async (importOriginal) => {
  const lib = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<HolderLike>; InfraError: new (code: string, message: string) => Error }>()
  return {
    ...lib,
    createHolder: async (...args: unknown[]) => {
      const h = await lib.createHolder(...args)
      // the holder is frozen: a wrapper with the same methods, resume and tick switchable
      const w: HolderLike = {
        ...h,
        resume: (when: number) => (fault.resume ? Promise.reject(new lib.InfraError('storage', 'injected')) : h.resume(when)),
        tick: (when: number) => (fault.tick ? Promise.reject(new lib.InfraError('storage', 'injected')) : h.tick(when)),
        get closed() {
          return h.closed
        },
      }
      return w
    },
  }
})

it('resume failing at opening: nothing goes out until a resume completes, then the holder decides (resume fails)', async () => {
  const seen: { digest: string; type: string }[] = []
  const p = await pair(counting(seen))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const doc = seen.find((o) => !isAck(o))!.digest
    fault.resume = true
    await p.reopen(true)
    p.carrier.setOnline('A', true)
    await p.rounds(5)
    expect(count(seen, doc)).toBe(1)
    expect(p.B().models()!.decisions).toHaveLength(0)
    fault.resume = false
    await p.rounds(5)
    expect(count(seen, doc)).toBe(2)
    expect(p.B().models()!.decisions).toHaveLength(1)
  } finally { fault.resume = false; await p.close() }
})

it('tick and resume failing after the deadline passed while closed: the expired copy never goes out (421 R7-1)', async () => {
  const seen: { digest: string; type: string }[] = []
  const p = await pair(counting(seen))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    const doc = seen.find((o) => !isAck(o))!.digest
    await p.shutdownA()
    p.clock.advance(8 * DAY)
    fault.resume = true
    fault.tick = true
    await p.reopen(true)
    p.carrier.setOnline('A', true)
    await p.rounds(3)
    fault.resume = false
    fault.tick = false
    await p.rounds(3)
    expect(count(seen, doc)).toBe(1)
    expect(p.B().models()!.decisions).toHaveLength(0)
  } finally { fault.resume = false; fault.tick = false; await p.close() }
})

function count(seen: { digest: string }[], d: string) {
  return seen.filter((x) => x.digest === d).length
}
