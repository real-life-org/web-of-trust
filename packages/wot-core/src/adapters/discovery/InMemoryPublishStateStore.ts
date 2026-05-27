import type { PublishStateField, PublishStateStore } from '../../ports/PublishStateStore'

/**
 * In-memory implementation of PublishStateStore.
 *
 * Useful for tests. Data is lost on page reload.
 */
export class InMemoryPublishStateStore implements PublishStateStore {
  private dirty = new Map<string, Set<PublishStateField>>()

  async markDirty(did: string, field: PublishStateField): Promise<void> {
    const fields = this.dirty.get(did) ?? new Set()
    fields.add(field)
    this.dirty.set(did, fields)
  }

  async clearDirty(did: string, field: PublishStateField): Promise<void> {
    const fields = this.dirty.get(did)
    if (fields) {
      fields.delete(field)
      if (fields.size === 0) this.dirty.delete(did)
    }
  }

  async getDirtyFields(did: string): Promise<Set<PublishStateField>> {
    return new Set(this.dirty.get(did) ?? [])
  }
}
