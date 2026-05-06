import { describe, expect, it } from 'vitest'
import { classifySnapshotDisposition } from '../src/protocol'
import type {
  ClassifySnapshotDispositionInput,
  SnapshotDisposition,
  SnapshotMetadata,
} from '../src/protocol'

const DOC_ID = '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b'
const OTHER_DOC_ID = '9a8b7c6d-5e4f-4321-9876-123456789abc'

const COVERAGE_HEADS = {
  '550e8400-e29b-41d4-a716-446655440000': 12,
  '6f9619ff-8b86-d011-b42d-00cf4fc964ff': 7,
}

function snapshot(overrides: Partial<SnapshotMetadata> = {}): SnapshotMetadata {
  return {
    docId: DOC_ID,
    keyGeneration: 4,
    heads: COVERAGE_HEADS,
    ...overrides,
  }
}

function classify(
  overrides: Partial<ClassifySnapshotDispositionInput> = {},
): SnapshotDisposition {
  return classifySnapshotDisposition({
    expectedDocId: DOC_ID,
    expectedKeyGeneration: 4,
    keyMaterial: 'available',
    snapshot: snapshot(),
    ...overrides,
  })
}

function expectNoRollbackGuidance(disposition: SnapshotDisposition): void {
  expect(disposition.mergeEligible).toBe(true)
  expect(disposition.logSafety).toEqual({
    nonAuthoritativeOverKnownValidLogEntries: true,
    noRollbackKnownValidLogEntries: true,
    noOverwriteKnownValidLogEntries: true,
    notAppendOnlyLogReplacement: true,
  })
}

describe('sync snapshot disposition', () => {
  it('allows merge consideration when docId and keyGeneration match the caller expectations', () => {
    const disposition = classify()

    expect(disposition.status).toBe('catch-up-optimization-eligible')
    expect(disposition.reason).toBe('matching-metadata-with-coverage')
    expect(disposition.mergeEligible).toBe(true)
  })

  it('rejects merge eligibility when snapshot docId differs from the expected docId', () => {
    const disposition = classify({
      snapshot: snapshot({ docId: OTHER_DOC_ID }),
    })

    expect(disposition).toMatchObject({
      status: 'rejected',
      reason: 'doc-id-mismatch',
      mergeEligible: false,
      markSnapshotProcessed: false,
    })
  })

  it('rejects merge eligibility when snapshot keyGeneration differs from the expected keyGeneration', () => {
    const disposition = classify({
      snapshot: snapshot({ keyGeneration: 3 }),
    })

    expect(disposition).toMatchObject({
      status: 'rejected',
      reason: 'key-generation-mismatch',
      mergeEligible: false,
      markSnapshotProcessed: false,
    })
  })

  it('rejects invalid keyGeneration metadata deterministically', () => {
    const invalidValues = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]

    for (const keyGeneration of invalidValues) {
      expect(classify({
        snapshot: snapshot({ keyGeneration }),
      })).toMatchObject({
        status: 'rejected',
        reason: 'invalid-key-generation',
        mergeEligible: false,
        markSnapshotProcessed: false,
      })
    }
  })

  it('rejects invalid expectedKeyGeneration metadata deterministically', () => {
    const invalidValues = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]

    for (const expectedKeyGeneration of invalidValues) {
      expect(classify({ expectedKeyGeneration })).toMatchObject({
        status: 'rejected',
        reason: 'invalid-key-generation',
        mergeEligible: false,
        markSnapshotProcessed: false,
      })
    }
  })

  it('blocks snapshots when required key material is missing or unavailable', () => {
    for (const keyMaterial of ['missing', 'unavailable'] as const) {
      const disposition = classify({ keyMaterial })

      expect(disposition).toMatchObject({
        status: 'blocked-by-key',
        reason: keyMaterial === 'missing' ? 'missing-key-material' : 'unavailable-key-material',
        mergeEligible: false,
        markSnapshotProcessed: false,
      })
      expect(disposition.actions).toEqual([
        'durable-buffer-or-retry',
        'key-catch-up',
        'do-not-mark-processed',
      ])
    }
  })

  it('blocks snapshots that reference future key material', () => {
    const disposition = classify({
      expectedKeyGeneration: 5,
      snapshot: snapshot({ keyGeneration: 5 }),
      keyMaterial: 'future',
    })

    expect(disposition).toMatchObject({
      status: 'blocked-by-key',
      reason: 'future-key-material',
      mergeEligible: false,
      markSnapshotProcessed: false,
    })
    expect(disposition.actions).toContain('durable-buffer-or-retry')
    expect(disposition.actions).toContain('key-catch-up')
    expect(disposition.actions).toContain('do-not-mark-processed')
  })

  it('classifies snapshots without coverage metadata as CRDT merge helpers only', () => {
    const disposition = classify({
      snapshot: snapshot({ heads: undefined }),
    })

    expect(disposition).toMatchObject({
      status: 'crdt-merge-helper-only',
      reason: 'missing-coverage-metadata',
      mergeEligible: true,
      markSnapshotProcessed: false,
    })
    expect(disposition.actions).toEqual(['crdt-merge-only', 'sync-request-log-catch-up'])
    expectNoRollbackGuidance(disposition)
  })

  it('classifies snapshots with coverage metadata as catch-up optimization eligible', () => {
    const disposition = classify()

    expect(disposition).toMatchObject({
      status: 'catch-up-optimization-eligible',
      reason: 'matching-metadata-with-coverage',
      mergeEligible: true,
      markSnapshotProcessed: false,
    })
    expect(disposition.actions).toEqual(['crdt-merge', 'log-head-coverage-optimization'])
    expectNoRollbackGuidance(disposition)
  })

  it('keeps explicit no-rollback and no-overwrite guidance on every merge-eligible disposition', () => {
    const dispositions = [
      classify(),
      classify({ snapshot: snapshot({ heads: undefined }) }),
    ]

    for (const disposition of dispositions) {
      expectNoRollbackGuidance(disposition)
      expect(disposition.logSafety.notAppendOnlyLogReplacement).toBe(true)
    }
  })
})
