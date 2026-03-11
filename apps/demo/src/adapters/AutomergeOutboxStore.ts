/**
 * AutomergeOutboxStore - OutboxStore backed by Personal Automerge Doc
 *
 * Replaces EvoluOutboxStore. Stores pending messages in doc.outbox.
 */
import type {
  OutboxStore,
  OutboxEntry,
  MessageEnvelope,
  Subscribable,
} from '@real-life/wot-core'
import {
  getPersonalDoc,
  changePersonalDoc,
  onPersonalDocChange,
} from '../personalDocManager'

export class AutomergeOutboxStore implements OutboxStore {

  async enqueue(envelope: MessageEnvelope): Promise<void> {
    const exists = await this.has(envelope.id)
    if (exists) return

    changePersonalDoc(doc => {
      doc.outbox[envelope.id] = {
        envelopeJson: JSON.stringify(envelope),
        createdAt: new Date().toISOString(),
        retryCount: 0,
      }
    })
  }

  async dequeue(envelopeId: string): Promise<void> {
    changePersonalDoc(doc => {
      delete doc.outbox[envelopeId]
    })
  }

  async getPending(): Promise<OutboxEntry[]> {
    const doc = getPersonalDoc()
    return Object.entries(doc.outbox)
      .map(([_id, entry]) => ({
        envelope: JSON.parse(entry.envelopeJson) as MessageEnvelope,
        createdAt: entry.createdAt,
        retryCount: entry.retryCount,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async has(envelopeId: string): Promise<boolean> {
    const doc = getPersonalDoc()
    return envelopeId in doc.outbox
  }

  async incrementRetry(envelopeId: string): Promise<void> {
    changePersonalDoc(doc => {
      if (doc.outbox[envelopeId]) {
        doc.outbox[envelopeId].retryCount += 1
      }
    })
  }

  async count(): Promise<number> {
    const doc = getPersonalDoc()
    return Object.keys(doc.outbox).length
  }

  watchPendingCount(): Subscribable<number> {
    const getSnapshot = (): number => {
      const doc = getPersonalDoc()
      return Object.keys(doc.outbox).length
    }

    let snapshot = getSnapshot()

    return {
      subscribe: (callback) => {
        return onPersonalDocChange(() => {
          const next = getSnapshot()
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
