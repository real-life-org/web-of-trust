import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyLogEntryKeyDisposition } from '../src/protocol'

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')

function loadSpecVector(relativePath: string): any {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

describe('log-entry key disposition', () => {
  it('returns process-decrypt when the log entry key generation is locally available', () => {
    expect(classifyLogEntryKeyDisposition({
      keyGeneration: 3,
      availableKeyGenerations: [1, 3, 4],
    })).toBe('process-decrypt')
  })

  it('returns blocked-by-key when the log entry key generation is unknown locally', () => {
    expect(classifyLogEntryKeyDisposition({
      keyGeneration: 5,
      availableKeyGenerations: [3, 4],
    })).toBe('blocked-by-key')
  })

  it('returns blocked-by-key when no local key generations are available', () => {
    expect(classifyLogEntryKeyDisposition({
      keyGeneration: 0,
      availableKeyGenerations: [],
    })).toBe('blocked-by-key')
  })

  it('validates the log entry keyGeneration as a non-negative safe integer', () => {
    const invalidKeyGenerations = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]

    for (const keyGeneration of invalidKeyGenerations) {
      expect(() => classifyLogEntryKeyDisposition({
        keyGeneration,
        availableKeyGenerations: [0],
      })).toThrow('keyGeneration must be a non-negative safe integer')
    }
  })

  it('validates available key generations as non-negative safe integers', () => {
    const invalidAvailableKeyGenerations = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]

    for (const availableKeyGeneration of invalidAvailableKeyGenerations) {
      expect(() => classifyLogEntryKeyDisposition({
        keyGeneration: 0,
        availableKeyGenerations: [availableKeyGeneration],
      })).toThrow('availableKeyGenerations must contain only non-negative safe integers')
    }
  })

  it('treats duplicate available key generations deterministically', () => {
    expect(classifyLogEntryKeyDisposition({
      keyGeneration: 2,
      availableKeyGenerations: [2, 2, 3],
    })).toBe('process-decrypt')
  })

  it('matches the phase-1 log_entry_jws payload keyGeneration example', () => {
    const keyGeneration = phase1.log_entry_jws.payload.keyGeneration
    expect(keyGeneration).toBe(3)

    expect(classifyLogEntryKeyDisposition({
      keyGeneration,
      availableKeyGenerations: [3],
    })).toBe('process-decrypt')
    expect(classifyLogEntryKeyDisposition({
      keyGeneration,
      availableKeyGenerations: [2],
    })).toBe('blocked-by-key')
  })
})
