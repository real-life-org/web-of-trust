import { describe, expect, it } from 'vitest'
import {
  compareSyncHeads,
  deriveSyncStartSeq,
  evaluateSyncResponseDisposition,
} from '../src/protocol'

describe('WoT sync heads disposition', () => {
  it('derives seq 0 for a missing device head and seq N+1 for a known head', () => {
    const heads = {
      'device-alpha': 0,
      'device-beta': 41,
    }

    expect(deriveSyncStartSeq(heads, 'device-missing')).toBe(0)
    expect(deriveSyncStartSeq(heads, 'device-alpha')).toBe(1)
    expect(deriveSyncStartSeq(heads, 'device-beta')).toBe(42)
  })

  it('treats empty heads as missing every opaque deviceId key', () => {
    expect(deriveSyncStartSeq({}, 'did:key:z6MkNotAUuid#device')).toBe(0)
    expect(deriveSyncStartSeq({}, '../opaque/device/id')).toBe(0)
  })

  it.each([
    ['negative integer', -1],
    ['fractional number', 1.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid known head values: %s', (_name, value) => {
    expect(() => deriveSyncStartSeq({ 'device-alpha': value }, 'device-alpha')).toThrow(
      'Invalid sync head seq',
    )
  })

  it('rejects deriving a next seq beyond Number.MAX_SAFE_INTEGER', () => {
    expect(() => deriveSyncStartSeq({ 'device-alpha': Number.MAX_SAFE_INTEGER }, 'device-alpha')).toThrow(
      'Sync head seq overflow',
    )
  })

  it('classifies truncated sync responses as requiring another request', () => {
    expect(evaluateSyncResponseDisposition({ truncated: true })).toBe('request-next-page')
    expect(evaluateSyncResponseDisposition({ truncated: false })).toBe('complete')
  })

  it('compares identical heads as consistent', () => {
    expect(compareSyncHeads({
      'device-alpha': 0,
      'device-beta': 9,
    }, {
      'device-beta': 9,
      'device-alpha': 0,
    })).toBe('consistent')
  })

  it('compares different head values as divergent', () => {
    expect(compareSyncHeads({
      'device-alpha': 4,
      'device-beta': 9,
    }, {
      'device-alpha': 5,
      'device-beta': 9,
    })).toBe('divergent')
  })

  it('compares missing or extra device keys as divergent', () => {
    expect(compareSyncHeads({
      'device-alpha': 4,
    }, {
      'device-alpha': 4,
      'device-beta': 0,
    })).toBe('divergent')

    expect(compareSyncHeads({
      'device-alpha': 4,
      'device-beta': 0,
    }, {
      'device-alpha': 4,
    })).toBe('divergent')
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
