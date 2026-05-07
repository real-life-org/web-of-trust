/**
 * GroupKeyService — Manages symmetric group keys for Encrypted Spaces.
 *
 * Each space has a group key that all members share. The key can be rotated
 * (e.g., when a member is removed). Old keys are kept so that old messages
 * can still be decrypted. Keys are identified by (spaceId, generation).
 *
 * In-memory only — persistence is handled by the StorageAdapter.
 */
export type RotationImportResult = 'applied' | 'stale' | 'future';
export declare class GroupKeyService {
    private spaces;
    /**
     * Create a new group key for a space (generation 0).
     * Returns the generated key.
     */
    createKey(spaceId: string): Promise<Uint8Array>;
    /**
     * Rotate the group key for a space.
     * Increments generation, old keys remain accessible.
     */
    rotateKey(spaceId: string): Promise<Uint8Array>;
    /**
     * Get the current (latest) key for a space.
     * Returns null if space is unknown.
     */
    getCurrentKey(spaceId: string): Uint8Array | null;
    /**
     * Get the current generation number for a space.
     * Returns -1 if space is unknown.
     */
    getCurrentGeneration(spaceId: string): number;
    /**
     * Get a key by generation (for decrypting old messages).
     * Returns null if space or generation is unknown.
     */
    getKeyByGeneration(spaceId: string, generation: number): Uint8Array | null;
    /**
     * Import a key for a space at a specific generation.
     * Used when receiving a group key from an invite.
     */
    importKey(spaceId: string, key: Uint8Array, generation: number): void;
    /**
     * Apply a key-rotation message only if it is exactly the next generation.
     */
    importRotationKey(spaceId: string, key: Uint8Array, generation: number): RotationImportResult;
}
//# sourceMappingURL=GroupKeyService.d.ts.map