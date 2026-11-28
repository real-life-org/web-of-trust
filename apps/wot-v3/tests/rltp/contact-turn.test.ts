// The turn of the holder's joining work and the ordered attempts (contact-turn.ts): joining work runs
// together, an attempt alone; a waiting attempt goes before joining work that comes after it.
import { describe, expect, it } from 'vitest'
import { createContactTurn } from '../../src/adapters/rltp/contact-turn'

function task() {
  let end: () => void = () => undefined
  const p = new Promise<void>((r) => (end = r))
  return { p, end }
}
const turns = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('contact turn', () => {
  it('joining work runs together', async () => {
    const t = createContactTurn()
    const a = task(), b = task()
    const log: string[] = []
    const ra = t.joining(async () => (log.push('a'), await a.p))
    const rb = t.joining(async () => (log.push('b'), await b.p))
    await turns()
    expect(log).toEqual(['a', 'b'])
    a.end()
    b.end()
    await Promise.all([ra, rb])
  })

  it('an attempt waits for running joining work and runs alone; joining work that comes meanwhile waits behind it', async () => {
    const t = createContactTurn()
    const j1 = task(), at = task(), j2 = task()
    const log: string[] = []
    const r1 = t.joining(async () => (log.push('j1'), await j1.p, log.push('j1 end')))
    const ra = t.attempt(async () => (log.push('attempt'), await at.p, log.push('attempt end')))
    const r2 = t.joining(async () => (log.push('j2'), await j2.p))
    await turns()
    expect(log).toEqual(['j1'])
    j1.end()
    await turns()
    expect(log).toEqual(['j1', 'j1 end', 'attempt'])
    at.end()
    await turns()
    expect(log).toEqual(['j1', 'j1 end', 'attempt', 'attempt end', 'j2'])
    j2.end()
    await Promise.all([r1, ra, r2])
  })

  it('two attempts run one after the other; a failed one frees the turn', async () => {
    const t = createContactTurn()
    const a = task()
    const log: string[] = []
    const r1 = t.attempt(async () => {
      log.push('1')
      await a.p
      throw new Error('storage')
    })
    const r2 = t.attempt(async () => void log.push('2'))
    await turns()
    expect(log).toEqual(['1'])
    a.end()
    await expect(r1).rejects.toThrow('storage')
    await r2
    expect(log).toEqual(['1', '2'])
    await t.joining(async () => void log.push('j'))
    expect(log).toEqual(['1', '2', 'j'])
  })
})
