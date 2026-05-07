import type {
  SpaceMetadataStorage,
  PersistedSpaceMetadata,
  PersistedGroupKey,
} from '../../ports/SpaceMetadataStorage'

/**
 * In-memory implementation of SpaceMetadataStorage for testing.
 */
export class InMemorySpaceMetadataStorage implements SpaceMetadataStorage {
  private spaces = new Map<string, PersistedSpaceMetadata>()
  private groupKeys = new Map<string, PersistedGroupKey[]>()

  async saveSpaceMetadata(meta: PersistedSpaceMetadata): Promise<void> {
    this.spaces.set(meta.info.id, meta)
  }

  async loadSpaceMetadata(spaceId: string): Promise<PersistedSpaceMetadata | null> {
    return this.spaces.get(spaceId) ?? null
  }

  async loadAllSpaceMetadata(): Promise<PersistedSpaceMetadata[]> {
    return Array.from(this.spaces.values())
  }

  async deleteSpaceMetadata(spaceId: string): Promise<void> {
    this.spaces.delete(spaceId)
  }

  async saveGroupKey(key: PersistedGroupKey): Promise<void> {
    const keys = this.groupKeys.get(key.spaceId) ?? []
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

  async clearAll(): Promise<void> {
    this.spaces.clear()
    this.groupKeys.clear()
  }
}
