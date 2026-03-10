import type { StorageAdapterInterface } from '@automerge/automerge-repo'

type StorageKey = string[]
type Chunk = { key: StorageKey; data: Uint8Array }

/**
 * In-memory implementation of automerge-repo's StorageAdapterInterface.
 * Used for testing — persists documents across Repo restarts within the same process.
 */
export class InMemoryRepoStorageAdapter implements StorageAdapterInterface {
  private data = new Map<string, Uint8Array>()

  private keyToString(key: StorageKey): string {
    return key.join('/')
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.data.get(this.keyToString(key))
  }

  async save(key: StorageKey, binary: Uint8Array): Promise<void> {
    this.data.set(this.keyToString(key), binary)
  }

  async remove(key: StorageKey): Promise<void> {
    this.data.delete(this.keyToString(key))
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const prefix = this.keyToString(keyPrefix)
    const result: Chunk[] = []
    for (const [key, data] of this.data.entries()) {
      if (key.startsWith(prefix)) {
        result.push({ key: key.split('/'), data })
      }
    }
    return result
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    const prefix = this.keyToString(keyPrefix)
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) {
        this.data.delete(key)
      }
    }
  }
}
