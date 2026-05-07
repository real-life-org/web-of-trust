import type { MessageEnvelope } from '../../types/messaging'
import type { OutboxStore, OutboxEntry } from '../../ports/OutboxStore'

export class InMemoryOutboxStore implements OutboxStore {
  private entries = new Map<string, OutboxEntry>()

  async enqueue(envelope: MessageEnvelope): Promise<void> {
    if (this.entries.has(envelope.id)) return // idempotent
    this.entries.set(envelope.id, {
      envelope,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    })
  }

  async dequeue(envelopeId: string): Promise<void> {
    this.entries.delete(envelopeId)
  }

  async getPending(): Promise<OutboxEntry[]> {
    return [...this.entries.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async has(envelopeId: string): Promise<boolean> {
    return this.entries.has(envelopeId)
  }

  async incrementRetry(envelopeId: string): Promise<void> {
    const entry = this.entries.get(envelopeId)
    if (entry) entry.retryCount++
  }

  async count(): Promise<number> {
    return this.entries.size
  }
}
