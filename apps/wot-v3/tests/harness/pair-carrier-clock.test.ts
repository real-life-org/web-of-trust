// The pair harness's carrier runs on the phones' device clock, driven by the harness (#430): a
// transiently refused document comes again when the harness moves the clock to its due time, never on
// real time; a refusal that persists is driven only within a bounded stretch of device time.
import { describe, expect, it, vi } from 'vitest'
import { virtualClock } from '../../src/platform/fake'
import { memoryCarrier, REDELIVER_MS } from '../../src/adapters/rltp/transport'
import { drivenTimers, DRIVE_LIMIT_MS } from '../../harness/loopback'

describe('pair harness carrier on the device clock', () => {
  function pair(answers: ('later' | 'taken')[]) {
    const clock = virtualClock(0, 'UTC')
    const carrier = memoryCarrier(drivenTimers(clock))
    const a = carrier.endpoint('a')
    const b = carrier.endpoint('b')
    const seen: number[] = []
    a.start({ envelope: async () => 'not-mine', report() {} })
    b.start({
      envelope: async () => {
        seen.push(clock.now())
        return answers.shift() ?? 'later'
      },
      report() {},
    })
    a.submit([{ digest: 'd1', envelope: { x: 1 } } as never])
    return { clock, seen }
  }

  it('a refused document comes again at its due time on the device clock, without real waiting', async () => {
    const { clock, seen } = pair(['later', 'taken'])
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    // the second offer happened at device time REDELIVER_MS: the harness moved the clock, nobody waited
    expect(seen).toEqual([0, REDELIVER_MS])
    expect(clock.now()).toBe(REDELIVER_MS)
  })

  it('a refusal that persists is driven at most DRIVE_LIMIT_MS of device time, then waits for the harness', async () => {
    const { clock, seen } = pair([])
    await vi.waitFor(() => expect(clock.now()).toBe(DRIVE_LIMIT_MS))
    await new Promise((r) => setTimeout(r, 30))
    expect(clock.now()).toBe(DRIVE_LIMIT_MS)
    const n = seen.length
    // a move of the clock by the harness (a button, a message) lets it run again
    clock.advance(60_000)
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(n))
  })
})
