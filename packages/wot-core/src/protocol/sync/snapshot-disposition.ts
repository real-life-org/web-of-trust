export type SnapshotKeyMaterialStatus = 'available' | 'missing' | 'unavailable' | 'future'

export type SnapshotDispositionStatus =
  | 'rejected'
  | 'blocked-by-key'
  | 'crdt-merge-helper-only'
  | 'catch-up-optimization-eligible'

export type SnapshotDispositionReason =
  | 'invalid-key-generation'
  | 'doc-id-mismatch'
  | 'key-generation-mismatch'
  | 'missing-key-material'
  | 'unavailable-key-material'
  | 'future-key-material'
  | 'missing-coverage-metadata'
  | 'matching-metadata-with-coverage'

export type SnapshotDispositionAction =
  | 'durable-buffer-or-retry'
  | 'key-catch-up'
  | 'do-not-mark-processed'
  | 'crdt-merge-only'
  | 'sync-request-log-catch-up'
  | 'crdt-merge'
  | 'log-head-coverage-optimization'

export interface SnapshotCoverageHeads {
  readonly [deviceId: string]: number
}

export interface SnapshotMetadata {
  readonly docId: string
  readonly keyGeneration: number
  readonly heads?: SnapshotCoverageHeads
}

export interface SnapshotLogSafetyGuidance {
  readonly nonAuthoritativeOverKnownValidLogEntries: true
  readonly noRollbackKnownValidLogEntries: true
  readonly noOverwriteKnownValidLogEntries: true
  readonly notAppendOnlyLogReplacement: true
}

export interface SnapshotDisposition {
  readonly status: SnapshotDispositionStatus
  readonly reason: SnapshotDispositionReason
  readonly mergeEligible: boolean
  readonly markSnapshotProcessed: false
  readonly actions: readonly SnapshotDispositionAction[]
  readonly logSafety?: SnapshotLogSafetyGuidance
}

export interface ClassifySnapshotDispositionInput {
  readonly expectedDocId: string
  readonly expectedKeyGeneration: number
  readonly keyMaterial: SnapshotKeyMaterialStatus
  readonly snapshot: SnapshotMetadata
}

const blockedByKeyActions = [
  'durable-buffer-or-retry',
  'key-catch-up',
  'do-not-mark-processed',
] as const satisfies readonly SnapshotDispositionAction[]

const logSafety: SnapshotLogSafetyGuidance = {
  nonAuthoritativeOverKnownValidLogEntries: true,
  noRollbackKnownValidLogEntries: true,
  noOverwriteKnownValidLogEntries: true,
  notAppendOnlyLogReplacement: true,
}

// Sync 002 "Snapshot- und Full-State-Optimierungen": metadata safety classification only.
export function classifySnapshotDisposition(input: ClassifySnapshotDispositionInput): SnapshotDisposition {
  const { snapshot } = input

  if (!isNonNegativeSafeInteger(snapshot.keyGeneration) || !isNonNegativeSafeInteger(input.expectedKeyGeneration)) {
    return rejected('invalid-key-generation')
  }

  if (snapshot.docId !== input.expectedDocId) return rejected('doc-id-mismatch')
  if (snapshot.keyGeneration !== input.expectedKeyGeneration) return rejected('key-generation-mismatch')

  if (input.keyMaterial !== 'available') {
    return {
      status: 'blocked-by-key',
      reason: keyMaterialReason(input.keyMaterial),
      mergeEligible: false,
      markSnapshotProcessed: false,
      actions: blockedByKeyActions,
    }
  }

  if (snapshot.heads === undefined) {
    return {
      status: 'crdt-merge-helper-only',
      reason: 'missing-coverage-metadata',
      mergeEligible: true,
      markSnapshotProcessed: false,
      actions: ['crdt-merge-only', 'sync-request-log-catch-up'],
      logSafety,
    }
  }

  return {
    status: 'catch-up-optimization-eligible',
    reason: 'matching-metadata-with-coverage',
    mergeEligible: true,
    markSnapshotProcessed: false,
    actions: ['crdt-merge', 'log-head-coverage-optimization'],
    logSafety,
  }
}

function rejected(reason: Extract<
  SnapshotDispositionReason,
  'invalid-key-generation' | 'doc-id-mismatch' | 'key-generation-mismatch'
>): SnapshotDisposition {
  return {
    status: 'rejected',
    reason,
    mergeEligible: false,
    markSnapshotProcessed: false,
    actions: [],
  }
}

function keyMaterialReason(keyMaterial: Exclude<SnapshotKeyMaterialStatus, 'available'>): SnapshotDispositionReason {
  if (keyMaterial === 'missing') return 'missing-key-material'
  if (keyMaterial === 'unavailable') return 'unavailable-key-material'
  return 'future-key-material'
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
