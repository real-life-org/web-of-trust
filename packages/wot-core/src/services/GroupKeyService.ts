/**
 * GroupKeyService — Manages symmetric group keys for Encrypted Spaces.
 *
 * Each space has a group key that all members share. The key can be rotated
 * (e.g., when a member is removed). Old keys are kept so that old messages
 * can still be decrypted. Keys are identified by (spaceId, generation).
 *
 * In-memory only — persistence is handled by the StorageAdapter.
 */

interface SpaceKeyState {
  keys: Uint8Array[] // index = generation
}

export type RotationImportResult = 'applied' | 'stale' | 'future'

export class GroupKeyService {
  private spaces = new Map<string, SpaceKeyState>()

  /**
   * Create a new group key for a space (generation 0).
   * Returns the generated key.
   */
  async createKey(spaceId: string): Promise<Uint8Array> {
    const key = crypto.getRandomValues(new Uint8Array(32))
    this.spaces.set(spaceId, { keys: [key] })
    return key
  }

  /**
   * Rotate the group key for a space.
   * Increments generation, old keys remain accessible.
   */
  async rotateKey(spaceId: string): Promise<Uint8Array> {
    const state = this.spaces.get(spaceId)
    if (!state) {
      throw new Error(`No key exists for space: ${spaceId}`)
    }

    const newKey = crypto.getRandomValues(new Uint8Array(32))
    state.keys.push(newKey)
    return newKey
  }

  /**
   * Get the current (latest) key for a space.
   * Returns null if space is unknown.
   */
  getCurrentKey(spaceId: string): Uint8Array | null {
    const state = this.spaces.get(spaceId)
    if (!state) return null
    return state.keys[state.keys.length - 1]
  }

  /**
   * Get the current generation number for a space.
   * Returns -1 if space is unknown.
   */
  getCurrentGeneration(spaceId: string): number {
    const state = this.spaces.get(spaceId)
    if (!state) return -1
    return state.keys.length - 1
  }

  /**
   * Get a key by generation (for decrypting old messages).
   * Returns null if space or generation is unknown.
   */
  getKeyByGeneration(spaceId: string, generation: number): Uint8Array | null {
    const state = this.spaces.get(spaceId)
    if (!state || generation < 0 || generation >= state.keys.length) return null
    return state.keys[generation]
  }

  /**
   * Import a key for a space at a specific generation.
   * Used when receiving a group key from an invite.
   */
  importKey(spaceId: string, key: Uint8Array, generation: number): void {
    let state = this.spaces.get(spaceId)
    if (!state) {
      state = { keys: [] }
      this.spaces.set(spaceId, state)
    }
    // Ensure array is large enough
    while (state.keys.length <= generation) {
      state.keys.push(new Uint8Array(0)) // placeholder
    }
    state.keys[generation] = key
  }

  /**
   * Apply a key-rotation message only if it is exactly the next generation.
   */
  importRotationKey(spaceId: string, key: Uint8Array, generation: number): RotationImportResult {
    const currentGeneration = this.getCurrentGeneration(spaceId)
    if (generation <= currentGeneration) return 'stale'
    if (generation > currentGeneration + 1) return 'future'

    this.importKey(spaceId, key, generation)
    return 'applied'
  }
}
