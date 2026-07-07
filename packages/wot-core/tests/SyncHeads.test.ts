import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  compareSyncHeads,
  deriveSyncStartSeq,
  evaluateSyncResponseDisposition,
} from '../src/protocol'
import type { SyncHeads, SyncResponseDisposition, SyncHeadsComparison } from '../src/protocol'

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')
const vectors = phase1.sync_heads_disposition

function loadSpecVector(relativePath: string): any {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

function expectVectorError(expectedError: string, run: () => unknown): void {
  if (expectedError === 'invalid-head-seq') {
    expect(run).toThrow('Invalid sync head seq')
    return
  }
  if (expectedError === 'sync-head-seq-overflow') {
    expect(run).toThrow('Sync head seq overflow')
    return
  }
  throw new Error(`Unknown sync heads vector error: ${expectedError}`)
}

describe('WoT sync heads disposition', () => {
  it.each(vectors.derive_start_seq_cases)('derives start seq vector case $name', (testCase) => {
    expect(deriveSyncStartSeq(testCase.heads as SyncHeads, testCase.deviceId)).toBe(
      testCase.expected_start_seq,
    )
  })

  it('treats empty heads as missing every opaque deviceId key', () => {
    expect(deriveSyncStartSeq({}, 'did:key:z6MkNotAUuid#device')).toBe(0)
    expect(deriveSyncStartSeq({}, '../opaque/device/id')).toBe(0)
  })

  it.each(vectors.invalid_head_seq_cases)('rejects invalid head seq vector case $name', (testCase) => {
    expectVectorError(testCase.expected_error, () =>
      deriveSyncStartSeq(testCase.heads as SyncHeads, testCase.deviceId),
    )
  })

  it.each(vectors.derive_start_seq_overflow_cases)(
    'rejects start seq overflow vector case $name',
    (testCase) => {
      expectVectorError(testCase.expected_error, () =>
        deriveSyncStartSeq(testCase.heads as SyncHeads, testCase.deviceId),
      )
    },
  )

  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects non-JSON invalid known head values: %s', (_name, value) => {
    expect(() => deriveSyncStartSeq({ 'device-alpha': value }, 'device-alpha')).toThrow(
      'Invalid sync head seq',
    )
  })

  it.each(vectors.response_truncation_cases)(
    'classifies response truncation vector case $name',
    (testCase) => {
      expect(evaluateSyncResponseDisposition(testCase.response)).toBe(
        testCase.expected_disposition as SyncResponseDisposition,
      )
    },
  )

  it.each(vectors.heads_comparison_cases)('compares heads vector case $name', (testCase) => {
    expect(compareSyncHeads(testCase.left as SyncHeads, testCase.right as SyncHeads)).toBe(
      testCase.expected_disposition as SyncHeadsComparison,
    )
  })

  it.each([
    ['left map invalid', { 'device-alpha': Number.NaN }, { 'device-alpha': 1 }],
    ['right map invalid', { 'device-alpha': 1 }, { 'device-alpha': Number.POSITIVE_INFINITY }],
    ['negative seq', { 'device-alpha': -1 }, { 'device-alpha': 1 }],
    ['fractional seq', { 'device-alpha': 1 }, { 'device-alpha': 1.5 }],
    ['unsafe integer seq', { 'device-alpha': 1 }, { 'device-alpha': Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects invalid head values in compareSyncHeads: %s', (_name, left, right) => {
    expect(() =>
      compareSyncHeads(left as Record<string, number>, right as Record<string, number>),
    ).toThrow('Invalid sync head seq')
  })

  it('treats device IDs as opaque map keys without UUID validation', () => {
    const opaqueDidLikeKey = 'did:key:z6MkExample#phone/primary'
    const opaquePathLikeKey = '../not/a/uuid'
    const heads = {
      [opaqueDidLikeKey]: 2,
      [opaquePathLikeKey]: 7,
    }

    expect(deriveSyncStartSeq(heads, opaqueDidLikeKey)).toBe(3)
    expect(compareSyncHeads(heads, { ...heads })).toBe('consistent')
  })
})
