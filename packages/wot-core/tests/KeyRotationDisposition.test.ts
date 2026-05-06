import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluateKeyRotationDisposition } from '../src/protocol'
import type { EvaluateKeyRotationDispositionInput, KeyRotationDisposition } from '../src/protocol'

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')

function loadSpecVector(relativePath: string): any {
  const url = new URL(relativePath, import.meta.url)
  const path = url.protocol === 'file:' ? fileURLToPath(url) : resolve(process.cwd(), url.pathname.slice(1))
  return JSON.parse(readFileSync(path, 'utf8'))
}

function evaluate(input: EvaluateKeyRotationDispositionInput): KeyRotationDisposition {
  return evaluateKeyRotationDisposition(input)
}

describe('key-rotation generation disposition invariants', () => {
  it('ignores stale rotations whose generation is lower than the local generation', () => {
    expect(evaluate({ localGeneration: 4, incomingGeneration: 3 })).toBe('ignore-stale-or-duplicate')
  })

  it('ignores duplicate/current rotations whose generation equals the local generation', () => {
    expect(evaluate({ localGeneration: 4, incomingGeneration: 4 })).toBe('ignore-stale-or-duplicate')
  })

  it('applies only the exactly next rotation generation', () => {
    expect(evaluate({ localGeneration: 4, incomingGeneration: 5 })).toBe('apply')
  })

  it('buffers future rotations that skip beyond the next generation', () => {
    expect(evaluate({ localGeneration: 4, incomingGeneration: 6 })).toBe('future-buffer')
  })

  it('matches the phase-1 key_rotation_body.generation example as local+1', () => {
    const generation = phase1.space_membership_messages.key_rotation_body.generation

    expect(evaluate({ localGeneration: generation - 1, incomingGeneration: generation })).toBe('apply')
  })

  it.each([
    { localGeneration: -1, incomingGeneration: 1 },
    { localGeneration: 1.5, incomingGeneration: 2 },
    { localGeneration: Number.NaN, incomingGeneration: 2 },
    { localGeneration: Number.POSITIVE_INFINITY, incomingGeneration: 2 },
    { localGeneration: Number.MAX_SAFE_INTEGER + 1, incomingGeneration: 2 },
    { localGeneration: 1, incomingGeneration: -1 },
    { localGeneration: 1, incomingGeneration: 1.5 },
    { localGeneration: 1, incomingGeneration: Number.NaN },
    { localGeneration: 1, incomingGeneration: Number.POSITIVE_INFINITY },
    { localGeneration: 1, incomingGeneration: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects non-unambiguous numeric input %#', (input) => {
    expect(() => evaluate(input)).toThrow('Invalid key-rotation generation')
  })
})
