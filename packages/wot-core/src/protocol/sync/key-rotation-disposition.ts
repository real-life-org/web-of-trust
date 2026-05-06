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
