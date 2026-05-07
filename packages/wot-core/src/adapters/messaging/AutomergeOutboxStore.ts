/**
 * PersonalDocOutboxStore - OutboxStore backed by a Personal CRDT Doc
 *
 * CRDT-agnostic — works with any PersonalDoc implementation (Automerge, Yjs)
 * via injected doc functions.
 */
import type {
  OutboxStore,
  OutboxEntry,
} from '../../ports/OutboxStore'
import type { MessageEnvelope } from '../../types/messaging'
import type { Subscribable } from '../../ports/Subscribable'

export interface PersonalDocFunctions {
  getPersonalDoc: () => any
  changePersonalDoc: (fn: (doc: any) => void, options?: { background?: boolean }) => any
  onPersonalDocChange: (callback: () => void) => () => void
}

export class PersonalDocOutboxStore implements OutboxStore {
  private getPersonalDoc: () => any
  private changePersonalDoc: (fn: (doc: any) => void, options?: { background?: boolean }) => any
  private onPersonalDocChange: (callback: () => void) => () => void

  constructor(fns: PersonalDocFunctions) {
    this.getPersonalDoc = fns.getPersonalDoc
    this.changePersonalDoc = fns.changePersonalDoc
    this.onPersonalDocChange = fns.onPersonalDocChange
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
      .map(([_id, entry]: [string, any]) => ({
        envelope: JSON.parse(entry.envelopeJson) as MessageEnvelope,
        createdAt: entry.createdAt as string,
        retryCount: entry.retryCount as number,
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
