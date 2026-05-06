/**
 * Spec refs:
 * - 03-wot-sync/002-sync-protokoll.md#key-rotation-und-generation-gaps
 * - 03-wot-sync/005-gruppen.md#key-rotation-invarianten-muss
 * These sections define apply, stale/duplicate ignore, and future-buffer semantics.
 */
export type KeyRotationDisposition = 'apply' | 'ignore-stale-or-duplicate' | 'future-buffer'

export interface EvaluateKeyRotationDispositionInput {
  localGeneration: number
  incomingGeneration: number
}

export function evaluateKeyRotationDisposition(
  input: EvaluateKeyRotationDispositionInput,
): KeyRotationDisposition {
  assertNonNegativeInteger(input.localGeneration)
  assertNonNegativeInteger(input.incomingGeneration)

  if (input.incomingGeneration <= input.localGeneration) return 'ignore-stale-or-duplicate'
  if (input.incomingGeneration === input.localGeneration + 1) return 'apply'
  return 'future-buffer'
}

function assertNonNegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid key-rotation generation')
  }
}
