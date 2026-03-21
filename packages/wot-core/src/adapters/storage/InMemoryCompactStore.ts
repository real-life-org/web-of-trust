/**
 * In-memory implementation of CompactStorageManager for testing.
 * Same interface as CompactStorageManager but without IndexedDB.
 */
export class InMemoryCompactStore {
  private data = new Map<string, Uint8Array>()

  async open(): Promise<void> {}

  async save(docId: string, binary: Uint8Array): Promise<void> {
    this.data.set(docId, binary)
  }

  async load(docId: string): Promise<Uint8Array | null> {
    return this.data.get(docId) ?? null
  }

  async delete(docId: string): Promise<void> {
    this.data.delete(docId)
  }

  async list(): Promise<string[]> {
    return Array.from(this.data.keys())
  }

  close(): void {
    // no-op
  }

  /** Test helper: check if a snapshot exists */
  has(docId: string): boolean {
    return this.data.has(docId)
  }

  /** Test helper: get snapshot size */
  size(docId: string): number {
    return this.data.get(docId)?.length ?? 0
  }
}
