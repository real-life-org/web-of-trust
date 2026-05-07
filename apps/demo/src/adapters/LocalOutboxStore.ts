/**
 * LocalOutboxStore — OutboxStore backed by LocalCacheStore (IndexedDB).
 *
 * Device-local — outbox messages should NOT be synced to other devices
 * (that would cause duplicate sends). Each write is immediately persisted
 * to IndexedDB, so no data is lost on reload.
 *
 * Keys: `outbox::{envelope.id}` in the LocalCacheStore.
 */

import type { OutboxStore, OutboxEntry, Subscribable } from '@web_of_trust/core/ports'
import type { MessageEnvelope } from '@web_of_trust/core/types'
import type { LocalCacheStore } from './LocalCacheStore'

const PREFIX = 'outbox::'

interface StoredEntry {
  envelopeJson: string
  createdAt: string
  retryCount: number
}

export class LocalOutboxStore implements OutboxStore {
  constructor(private store: LocalCacheStore) {}

  async enqueue(envelope: MessageEnvelope): Promise<void> {
    const exists = await this.has(envelope.id)
    if (exists) return

    const entry: StoredEntry = {
      envelopeJson: JSON.stringify(envelope),
      createdAt: new Date().toISOString(),
      retryCount: 0,
    }
    await this.store.set(PREFIX + envelope.id, entry)
  }

  async dequeue(envelopeId: string): Promise<void> {
    await this.store.delete(PREFIX + envelopeId)
  }

  async getPending(): Promise<OutboxEntry[]> {
    const all = await this.store.getByPrefix<StoredEntry>(PREFIX)
    return all
      .map(({ value }) => ({
        envelope: JSON.parse(value.envelopeJson) as MessageEnvelope,
        createdAt: value.createdAt,
        retryCount: value.retryCount,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async has(envelopeId: string): Promise<boolean> {
    const entry = await this.store.get(PREFIX + envelopeId)
    return entry !== null
  }

  async incrementRetry(envelopeId: string): Promise<void> {
    const entry = await this.store.get<StoredEntry>(PREFIX + envelopeId)
    if (entry) {
      entry.retryCount += 1
      await this.store.set(PREFIX + envelopeId, entry)
    }
  }

  async count(): Promise<number> {
    const all = await this.store.getByPrefix(PREFIX)
    return all.length
  }

  watchPendingCount(): Subscribable<number> {
    const self = this
    let snapshot = 0

    // Initialize
    self.count().then(c => { snapshot = c })

    return {
      subscribe: (callback) => {
        return self.store.onChange(async () => {
          const next = await self.count()
          if (next !== snapshot) {
            snapshot = next
            callback(snapshot)
          }
        })
      },
      getValue: () => snapshot,
    }
  }
}
