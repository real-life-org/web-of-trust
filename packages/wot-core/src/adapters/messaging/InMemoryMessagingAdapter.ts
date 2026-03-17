import type { MessagingAdapter } from '../interfaces/MessagingAdapter'
import type {
  MessageEnvelope,
  DeliveryReceipt,
  MessagingState,
} from '../../types/messaging'

/**
 * In-memory messaging adapter for testing.
 *
 * Uses a shared static registry so two instances (Alice + Bob) in the same
 * process can exchange messages. Supports offline queuing: messages sent
 * to a DID that is not yet connected are queued and delivered on connect.
 */
export class InMemoryMessagingAdapter implements MessagingAdapter {
  // Shared state across all instances (same process)
  private static registry = new Map<string, InMemoryMessagingAdapter>()
  private static offlineQueue = new Map<string, MessageEnvelope[]>()
  private static transportMap = new Map<string, string>()

  private myDid: string | null = null
  private state: MessagingState = 'disconnected'
  private messageCallbacks = new Set<(envelope: MessageEnvelope) => void | Promise<void>>()
  private receiptCallbacks = new Set<(receipt: DeliveryReceipt) => void>()
  private stateCallbacks = new Set<(state: MessagingState) => void>()

  onStateChange(callback: (state: MessagingState) => void): () => void {
    this.stateCallbacks.add(callback)
    return () => { this.stateCallbacks.delete(callback) }
  }

  private notifyStateChange(newState: MessagingState): void {
    this.state = newState
    for (const cb of this.stateCallbacks) {
      cb(newState)
    }
  }

  async connect(myDid: string): Promise<void> {
    this.myDid = myDid
    this.notifyStateChange('connected')
    InMemoryMessagingAdapter.registry.set(myDid, this)

    // Deliver queued messages
    const queued = InMemoryMessagingAdapter.offlineQueue.get(myDid)
    if (queued && queued.length > 0) {
      InMemoryMessagingAdapter.offlineQueue.delete(myDid)
      for (const envelope of queued) {
        await this.deliverToSelf(envelope)
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.myDid) {
      InMemoryMessagingAdapter.registry.delete(this.myDid)
    }
    this.myDid = null
    this.notifyStateChange('disconnected')
  }

  getState(): MessagingState {
    return this.state
  }

  async send(envelope: MessageEnvelope): Promise<DeliveryReceipt> {
    if (this.state !== 'connected' || !this.myDid) {
      throw new Error('MessagingAdapter: must call connect() before send()')
    }

    const now = new Date().toISOString()

    // Try to deliver to connected recipient
    const recipient = InMemoryMessagingAdapter.registry.get(envelope.toDid)
    if (recipient) {
      await recipient.deliverToSelf(envelope)

      // Notify sender of delivered receipt
      const deliveredReceipt: DeliveryReceipt = {
        messageId: envelope.id,
        status: 'delivered',
        timestamp: now,
      }
      for (const cb of this.receiptCallbacks) {
        cb(deliveredReceipt)
      }

      return {
        messageId: envelope.id,
        status: 'accepted',
        timestamp: now,
      }
    }

    // Recipient not online — queue for later
    const queue = InMemoryMessagingAdapter.offlineQueue.get(envelope.toDid) ?? []
    queue.push(envelope)
    InMemoryMessagingAdapter.offlineQueue.set(envelope.toDid, queue)

    return {
      messageId: envelope.id,
      status: 'accepted',
      timestamp: now,
    }
  }

  onMessage(callback: (envelope: MessageEnvelope) => void | Promise<void>): () => void {
    this.messageCallbacks.add(callback)
    return () => {
      this.messageCallbacks.delete(callback)
    }
  }

  onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void {
    this.receiptCallbacks.add(callback)
    return () => {
      this.receiptCallbacks.delete(callback)
    }
  }

  async registerTransport(did: string, transportAddress: string): Promise<void> {
    InMemoryMessagingAdapter.transportMap.set(did, transportAddress)
  }

  async resolveTransport(did: string): Promise<string | null> {
    return InMemoryMessagingAdapter.transportMap.get(did) ?? null
  }

  /** Reset all shared state. Call in afterEach() for test isolation. */
  static resetAll(): void {
    // Disconnect all instances
    for (const adapter of InMemoryMessagingAdapter.registry.values()) {
      adapter.myDid = null
      adapter.state = 'disconnected'
    }
    InMemoryMessagingAdapter.registry.clear()
    InMemoryMessagingAdapter.offlineQueue.clear()
    InMemoryMessagingAdapter.transportMap.clear()
  }

  private async deliverToSelf(envelope: MessageEnvelope): Promise<void> {
    for (const cb of this.messageCallbacks) {
      try {
        await cb(envelope)
      } catch (err) {
        console.error('Message callback error:', err)
      }
    }
  }
}
