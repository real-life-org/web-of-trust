/**
 * AutomergeOutboxStore - OutboxStore backed by Personal Automerge Doc
 *
 * Replaces EvoluOutboxStore. Stores pending messages in doc.outbox.
 */
import type {
  OutboxStore,
  OutboxEntry,
} from '@real-life/wot-core'
import type { MessageEnvelope } from '@real-life/wot-core'
import type { Subscribable } from '@real-life/wot-core'
import {
  getPersonalDoc as defaultGetPersonalDoc,
  changePersonalDoc as defaultChangePersonalDoc,
  onPersonalDocChange as defaultOnPersonalDocChange,
} from './PersonalDocManager'
import type { PersonalDoc } from './PersonalDocManager'

export interface PersonalDocFunctions {
  getPersonalDoc: () => PersonalDoc
  changePersonalDoc: (fn: (doc: PersonalDoc) => void, options?: { background?: boolean }) => PersonalDoc
  onPersonalDocChange: (callback: () => void) => () => void
}

export class AutomergeOutboxStore implements OutboxStore {
  private getPersonalDoc: () => PersonalDoc
  private changePersonalDoc: (fn: (doc: PersonalDoc) => void, options?: { background?: boolean }) => PersonalDoc
  private onPersonalDocChange: (callback: () => void) => () => void

  constructor(fns?: PersonalDocFunctions) {
    this.getPersonalDoc = fns?.getPersonalDoc ?? defaultGetPersonalDoc
    this.changePersonalDoc = fns?.changePersonalDoc ?? defaultChangePersonalDoc
    this.onPersonalDocChange = fns?.onPersonalDocChange ?? defaultOnPersonalDocChange
  }

  async enqueue(envelope: MessageEnvelope): Promise<void> {
    const exists = await this.has(envelope.id)
    if (exists) return

    this.changePersonalDoc(doc => {
      doc.outbox[envelope.id] = {
        envelopeJson: JSON.stringify(envelope),
        createdAt: new Date().toISOString(),
        retryCount: 0,
      }
    })
  }

  async dequeue(envelopeId: string): Promise<void> {
    this.changePersonalDoc(doc => {
      delete doc.outbox[envelopeId]
    })
  }

  async getPending(): Promise<OutboxEntry[]> {
    const doc = this.getPersonalDoc()
    return Object.entries(doc.outbox)
      .map(([_id, entry]) => ({
        envelope: JSON.parse(entry.envelopeJson) as MessageEnvelope,
        createdAt: entry.createdAt,
        retryCount: entry.retryCount,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async has(envelopeId: string): Promise<boolean> {
    const doc = this.getPersonalDoc()
    return envelopeId in doc.outbox
  }

  async incrementRetry(envelopeId: string): Promise<void> {
    this.changePersonalDoc(doc => {
      if (doc.outbox[envelopeId]) {
        doc.outbox[envelopeId].retryCount += 1
      }
    })
  }

  async count(): Promise<number> {
    const doc = this.getPersonalDoc()
    return Object.keys(doc.outbox).length
  }

  watchPendingCount(): Subscribable<number> {
    const self = this
    const getSnapshot = (): number => {
      const doc = self.getPersonalDoc()
      return Object.keys(doc.outbox).length
    }

    let snapshot = getSnapshot()

    return {
      subscribe: (callback) => {
        return self.onPersonalDocChange(() => {
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
