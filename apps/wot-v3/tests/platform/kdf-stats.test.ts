// The statistics of the unlock measurement (scripts/kdf-unlock.mjs, used by scripts/measure-kdf.mjs
// and the harness measurement page): the median of an even count is the mean of the two middle
// samples (review 434, CodeRabbit 4341015325; the measurement runs 10 times).
import { describe, expect, it } from 'vitest'
import { stats } from '../../scripts/kdf-unlock.mjs'

describe('kdf measurement stats', () => {
  it('takes the mean of the two middle samples for an even count', () => {
    expect(stats([200, 100]).median).toBe(150)
    // 10 runs, unsorted: middle samples 75 and 77
    expect(stats([90, 70, 77, 72, 80, 75, 71, 85, 74, 79])).toEqual({ median: 76, min: 70, max: 90 })
  })

  it('takes the middle sample for an odd count', () => {
    expect(stats([3, 1, 2])).toEqual({ median: 2, min: 1, max: 3 })
  })
})
