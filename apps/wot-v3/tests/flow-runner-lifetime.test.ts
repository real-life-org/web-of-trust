// The flow runner owns the lifetime of each effect (hooks/flow-runner.ts): every effect gets the signal of
// the lifetime it was started in; a state that leaves that lifetime (by default a new run) and the end of the
// flow abort it. The machine still drops a result of an older run.
import { describe, expect, it } from 'vitest'
import { createFlowRunner } from '../src/hooks/flow-runner'
import type { Machine } from '../src/flows/machine'

type S = { readonly name: 'a' | 'b' | 'c'; readonly run: number }
type E = { readonly type: 'next' } | { readonly type: 'rename' } | { readonly type: 'twice' }
type F = { readonly id: 'wait' | 'other'; readonly run: number }

const machine: Machine<S, E, F> = {
  name: 'lifetime-test',
  table: [],
  sensitive: () => false,
  transition: (s, e) => {
    if (e.type === 'next') return { state: { name: 'b', run: s.run + 1 }, effects: [{ id: 'wait', run: s.run + 1 }], row: null }
    if (e.type === 'rename') return { state: { name: 'c', run: s.run }, effects: [], row: null }
    if (e.type === 'twice') return { state: { name: 'b', run: s.run + 1 }, effects: [{ id: 'wait', run: s.run + 1 }, { id: 'other', run: s.run + 1 }], row: null }
    // a result of the current run moves on to the next one, up to run 4
    if ((e as { type: string }).type === 'result' && (e as unknown as { run: number }).run === s.run && s.run < 4) return { state: { name: 'b', run: s.run + 1 }, effects: [{ id: 'wait', run: s.run + 1 }], row: null }
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

describe('the flow runner: an effect runs only with the signal of the transition that asked for it', () => {
  /** every started effect: its run and its signal */
  const started = () => {
    const list: { run: number; id: string; signal: AbortSignal }[] = []
    const exec = (f: F, signal: AbortSignal) => {
      list.push({ run: f.run, id: f.id, signal })
      return new Promise<{ ok: boolean }>(() => undefined)
    }
    return { list, exec }
  }
  const at = (run: number) => ({ state: { name: 'a' as const, run }, effects: [], row: null })

  it('a subscriber that moves on synchronously while it is told: the overtaken effect does not start, none holds a later signal', () => {
    const { list, exec } = started()
    const r = createFlowRunner(machine, at(1), exec)
    r.subscribe(() => {
      if (r.get().run === 2) r.send({ type: 'next' })
    })
    r.send({ type: 'next' })
    expect(r.get().run).toBe(3)
    expect(list.map((x) => x.run)).toEqual([3])
    expect(list.every((x) => !x.signal.aborted)).toBe(true)
  })

  it('several stages in one notification (run 2 → 3 → 4): only the last one\'s effect starts', () => {
    const { list, exec } = started()
    const r = createFlowRunner(machine, at(1), exec)
    r.subscribe(() => {
      if (r.get().run < 4) r.send({ type: 'next' })
    })
    r.send({ type: 'next' })
    expect(r.get().run).toBe(4)
    expect(list.map((x) => x.run)).toEqual([4])
    expect(list[0]?.signal.aborted).toBe(false)
  })

  it('dispose from a subscriber: no effect starts', () => {
    const { list, exec } = started()
    const r = createFlowRunner(machine, at(1), exec)
    r.subscribe(() => r.dispose())
    r.send({ type: 'next' })
    expect(list).toEqual([])
  })

  it('an effect whose result at once moves the state on: each runs with its own run\'s signal, the earlier ones end', async () => {
    const list: { run: number; signal: AbortSignal }[] = []
    const exec = (f: F, signal: AbortSignal) => {
      list.push({ run: f.run, signal })
      return Promise.resolve({ ok: true })
    }
    const r = createFlowRunner(machine, at(1), exec)
    r.send({ type: 'next' })
    await r.idle()
    expect(r.get().run).toBe(4)
    expect(list.map((x) => x.run)).toEqual([2, 3, 4])
    expect(list.map((x) => x.signal.aborted)).toEqual([true, true, false])
  })

  it('several effects of one transition, the first moves the state on while it starts: the others do not start', () => {
    const list: { run: number; id: string; signal: AbortSignal }[] = []
    let r: ReturnType<typeof createFlowRunner<S, E, F>> | null = null
    const exec = (f: F, signal: AbortSignal) => {
      list.push({ run: f.run, id: f.id, signal })
      if (f.id === 'wait' && f.run === 2) r?.send({ type: 'next' })
      return new Promise<{ ok: boolean }>(() => undefined)
    }
    r = createFlowRunner(machine, at(1), exec)
    r.send({ type: 'twice' })
    expect(r.get().run).toBe(3)
    expect(list.map((x) => `${x.id}@${x.run}`)).toEqual(['wait@2', 'wait@3'])
    expect(list[0]?.signal.aborted).toBe(true)
    expect(list[1]?.signal.aborted).toBe(false)
  })
})

describe('the flow runner: a transition that ends a lifetime whose abort moves the state on at once', () => {
  /** a machine whose `next` emits one effect per run, `to:<name>` moves by name within lifetimes of its own */
  type S2 = { readonly name: string; readonly run: number }
  type E2 = { readonly type: 'next' } | { readonly type: 'to'; readonly name: string }
  type F2 = { readonly id: 'wait'; readonly run: number; readonly tag: string }
  const m2: Machine<S2, E2, F2> = {
    name: 'nested-test',
    table: [],
    sensitive: () => false,
    transition: (s, e) => {
      if (e.type === 'next') return { state: { name: s.name, run: s.run + 1 }, effects: [{ id: 'wait', run: s.run + 1, tag: `run${s.run + 1}` }], row: null }
      if (e.type === 'to') return { state: { name: e.name, run: s.run }, effects: [{ id: 'wait', run: s.run, tag: e.name }], row: null }
      return { state: s, effects: [], row: null }
    },
  }
  const recorder = () => {
    const list: { tag: string; signal: AbortSignal }[] = []
    const onStart: ((f: F2, signal: AbortSignal) => void)[] = []
    const exec = (f: F2, signal: AbortSignal) => {
      list.push({ tag: f.tag, signal })
      for (const h of onStart) h(f, signal)
      return new Promise<{ ok: boolean }>(() => undefined)
    }
    return { list, exec, onStart }
  }
  const start = { state: { name: 'a', run: 1 }, effects: [{ id: 'wait' as const, run: 1, tag: 'run1' }], row: null }

  it('the abort of run 1 moves to run 3 at once: only the effects of runs 1 and 3 start', async () => {
    const { list, exec, onStart } = recorder()
    const r = createFlowRunner(m2, start, exec)
    onStart.push((f, signal) => {
      if (f.tag === 'run1') signal.addEventListener('abort', () => r.send({ type: 'next' }), { once: true })
    })
    await Promise.resolve()
    await Promise.resolve()
    r.send({ type: 'next' })
    expect(r.get().run).toBe(3)
    expect(list.map((x) => x.tag)).toEqual(['run1', 'run3'])
    expect(list.map((x) => x.signal.aborted)).toEqual([true, false])
    expect(r.lifetimes()).toEqual(['3'])
  })

  it('over several stages (abort → run 3 → run 4): only runs 1 and 4 start', async () => {
    const { list, exec, onStart } = recorder()
    const r = createFlowRunner(m2, start, exec)
    onStart.push((f, signal) => {
      if (f.tag === 'run1') signal.addEventListener('abort', () => r.send({ type: 'next' }), { once: true })
    })
    r.subscribe(() => {
      if (r.get().run === 3) r.send({ type: 'next' })
    })
    await Promise.resolve()
    await Promise.resolve()
    r.send({ type: 'next' })
    expect(r.get().run).toBe(4)
    expect(list.map((x) => x.tag)).toEqual(['run1', 'run4'])
    expect(list[1]?.signal.aborted).toBe(false)
    expect(r.lifetimes()).toEqual(['4'])
  })

  it('back into a lifetime of the same name (A → B → A, a lifetime of its own): the outer A starts nothing, the inner A with a live signal', async () => {
    const { list, exec, onStart } = recorder()
    const r = createFlowRunner(m2, { state: { name: 'start', run: 1 }, effects: [{ id: 'wait', run: 1, tag: 'start' }], row: null }, exec, null, { lifetime: (s) => s.name })
    let step = 0
    onStart.push((f, signal) => {
      if (f.tag === 'start') signal.addEventListener('abort', () => {
        step++
        r.send({ type: 'to', name: 'B' })
        r.send({ type: 'to', name: 'A' })
      }, { once: true })
    })
    await Promise.resolve()
    await Promise.resolve()
    r.send({ type: 'to', name: 'A' })
    expect(step).toBe(1)
    expect(r.get().name).toBe('A')
    // started: the first, B (ended by the inner A), the inner A; never the outer A
    expect(list.map((x) => x.tag)).toEqual(['start', 'B', 'A'])
    expect(list.map((x) => x.signal.aborted)).toEqual([true, true, false])
    expect(r.lifetimes()).toEqual(['A'])
  })

  it('dispose from an abort listener: nothing starts, nothing stays', async () => {
    const { list, exec, onStart } = recorder()
    const r = createFlowRunner(m2, start, exec)
    onStart.push((f, signal) => {
      if (f.tag === 'run1') signal.addEventListener('abort', () => r.dispose(), { once: true })
    })
    await Promise.resolve()
    await Promise.resolve()
    r.send({ type: 'next' })
    expect(list.map((x) => x.tag)).toEqual(['run1'])
    expect(r.lifetimes()).toEqual([])
  })

  it('an abort listener and a subscriber both move on in the same transition: only the last run starts', async () => {
    const { list, exec, onStart } = recorder()
    const r = createFlowRunner(m2, start, exec)
    onStart.push((f, signal) => {
      if (f.tag === 'run1') signal.addEventListener('abort', () => r.send({ type: 'next' }), { once: true })
    })
    r.subscribe(() => {
      if (r.get().run === 2) r.send({ type: 'next' })
      if (r.get().run === 3) r.send({ type: 'next' })
    })
    await Promise.resolve()
    await Promise.resolve()
    r.send({ type: 'next' })
    expect(list.map((x) => x.tag)).toEqual(['run1', `run${r.get().run}`])
    expect(list[1]?.signal.aborted).toBe(false)
    expect(r.lifetimes()).toEqual([String(r.get().run)])
    // a later transition ends only what started
    r.send({ type: 'next' })
    expect(list[1]?.signal.aborted).toBe(true)
    expect(r.lifetimes()).toEqual([String(r.get().run)])
  })
})
