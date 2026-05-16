/**
 * Spec refs:
 * - 03-wot-sync/002-sync-protokoll.md#key-rotation-und-generation-gaps
 * - 03-wot-sync/005-gruppen.md#key-rotation-invarianten-muss
 * These sections define apply, stale/duplicate ignore, and future-buffer semantics.
 */
export type KeyRotationDisposition = 'apply' | 'ignore-stale-or-duplicate' | 'future-buffer';
export interface EvaluateKeyRotationDispositionInput {
    localGeneration: number;
    incomingGeneration: number;
}
export declare function evaluateKeyRotationDisposition(input: EvaluateKeyRotationDispositionInput): KeyRotationDisposition;
//# sourceMappingURL=key-rotation-disposition.d.ts.map