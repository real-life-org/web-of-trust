import type {
  SpaceStorageAdapter,
  PersistedSpace,
  PersistedGroupKey,
} from '../interfaces/SpaceStorageAdapter'

/**
 * In-memory implementation of SpaceStorageAdapter for testing.
 */
export class InMemorySpaceStorageAdapter implements SpaceStorageAdapter {
  private spaces = new Map<string, PersistedSpace>()
  private groupKeys = new Map<string, PersistedGroupKey[]>()

  async saveSpace(space: PersistedSpace): Promise<void> {
    this.spaces.set(space.info.id, space)
  }

  async loadSpace(spaceId: string): Promise<PersistedSpace | null> {
    return this.spaces.get(spaceId) ?? null
  }

  async loadAllSpaces(): Promise<PersistedSpace[]> {
    return Array.from(this.spaces.values())
  }

  async deleteSpace(spaceId: string): Promise<void> {
    this.spaces.delete(spaceId)
  }

  async saveGroupKey(key: PersistedGroupKey): Promise<void> {
    const keys = this.groupKeys.get(key.spaceId) ?? []
    // Replace existing generation or append
    const idx = keys.findIndex(k => k.generation === key.generation)
    if (idx >= 0) {
      keys[idx] = key
    } else {
      keys.push(key)
    }
    this.groupKeys.set(key.spaceId, keys)
  }

  async loadGroupKeys(spaceId: string): Promise<PersistedGroupKey[]> {
    return this.groupKeys.get(spaceId) ?? []
  }

  async deleteGroupKeys(spaceId: string): Promise<void> {
    this.groupKeys.delete(spaceId)
  }
}
