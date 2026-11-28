// The flow runner owns the lifetime of each effect (hooks/flow-runner.ts): every effect gets the signal of
// the lifetime it was started in; a state that leaves that lifetime (by default a new run) and the end of the
// flow abort it. The machine still drops a result of an older run.
import { describe, expect, it } from 'vitest'
import { createFlowRunner } from '../src/hooks/flow-runner'
import type { Machine } from '../src/flows/machine'

type S = { readonly name: 'a' | 'b' | 'c'; readonly run: number }
type E = { readonly type: 'next' } | { readonly type: 'rename' }
type F = { readonly id: 'wait'; readonly run: number }

const machine: Machine<S, E, F> = {
  name: 'lifetime-test',
  table: [],
  sensitive: () => false,
  transition: (s, e) => {
    if (e.type === 'next') return { state: { name: 'b', run: s.run + 1 }, effects: [{ id: 'wait', run: s.run + 1 }], row: null }
    if (e.type === 'rename') return { state: { name: 'c', run: s.run }, effects: [], row: null }
    return { state: s, effects: [], row: null }
  },
}

describe('the flow runner and the lifetime of effects', () => {
  it('a new run aborts the signal of the effects of the run before; closing the flow aborts the rest', async () => {
    const signals: AbortSignal[] = []
    const exec = (_f: F, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<{ ok: boolean }>(() => undefined)
    }
    const r = createFlowRunner(machine, { state: { name: 'a', run: 1 }, effects: [{ id: 'wait', run: 1 }], row: null }, exec)
    await Promise.resolve()
    await Promise.resolve()
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
    r.send({ type: 'next' })
    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    r.dispose()
    expect(signals[1]?.aborted).toBe(true)
  })

  it('a lifetime of its own: a change of state within the run ends the effects when the flow says so', async () => {
    const signals: AbortSignal[] = []
    const exec = (_f: F, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<{ ok: boolean }>(() => undefined)
    }
    const r = createFlowRunner(machine, { state: { name: 'a', run: 1 }, effects: [], row: null }, exec, null, { lifetime: (s) => `${s.run}:${s.name}` })
    r.send({ type: 'next' })
    expect(signals[0]?.aborted).toBe(false)
    r.send({ type: 'rename' })
    expect(signals[0]?.aborted).toBe(true)
  })
})
