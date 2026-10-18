// Secret<T> at runtime (architecture §2.4, §5): the box never reveals its value by accident.
// @vitest-environment node
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { isSecret, secret } from '../src/port'

const CANARY = 'canary-3f0c2a9e-passphrase'

describe('secret()', () => {
  const s = secret(CANARY)

  it('reveals only through reveal()', () => {
    expect(s.reveal()).toBe(CANARY)
    expect(isSecret(s)).toBe(true)
    expect(isSecret({ reveal: () => CANARY })).toBe(false)
  })

  it.each([
    ['JSON.stringify', () => JSON.stringify({ s })],
    ['String()', () => String(s)],
    ['template literal', () => `${s as unknown as string}`],
    ['util.inspect', () => inspect({ s }, { depth: 5, showHidden: true })],
    ['Object.keys', () => JSON.stringify(Object.keys(s))],
    ['spread', () => JSON.stringify({ ...(s as object) })],
    ['error cause', () => inspect(new Error('x', { cause: s }))],
  ])('%s does not leak the value', (_, f) => {
    expect(f()).not.toContain(CANARY)
  })

  it('structuredClone throws', () => {
    expect(() => structuredClone(s)).toThrow()
  })
})
