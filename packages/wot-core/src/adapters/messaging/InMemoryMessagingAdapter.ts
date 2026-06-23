import type { MessagingAdapter, WireMessage } from '../../ports/MessagingAdapter'
import { wireMessageRecipient } from '../../ports/MessagingAdapter'
import { isDidcommMessage } from '../../protocol/messaging/inbox-message'
import { ACK_MESSAGE_TYPE } from '../../protocol/sync/ack-message'
import type {
  DeliveryReceipt,
  MessagingState,
} from '../../types/messaging'
import type { ControlFrame, ControlFrameReceipt } from '../../protocol/sync/control-frame-transport'
import type { InProcessLogBroker } from './InProcessLogBroker'

/**
 * In-memory messaging adapter for testing.
 *
 * Uses a shared static registry so two instances (Alice + Bob) in the same
 * process can exchange messages. Supports offline queuing: messages sent
 * to a DID that is not yet connected are queued and delivered on connect.
 *
 * Multi-device: multiple instances can connect with the same DID.
 * Messages sent to that DID are delivered to ALL connected instances.
 */
export class InMemoryMessagingAdapter implements MessagingAdapter {
  // Shared state across all instances (same process)
  private static registry = new Map<string, Set<InMemoryMessagingAdapter>>()
  private static offlineQueue = new Map<string, WireMessage[]>()
  private static transportMap = new Map<string, string>()

  private myDid: string | null = null
  private state: MessagingState = 'disconnected'
  private messageCallbacks = new Set<(envelope: WireMessage) => void | Promise<void>>()
  private receiptCallbacks = new Set<(receipt: DeliveryReceipt) => void>()
  private stateCallbacks = new Set<(state: MessagingState) => void>()

  /**
   * VE-9/VE-11 test transport: when a broker is wired, control frames go to it
   * and log-entry/sync-request envelopes are ingest-gated by it (the rest still
   * peer-routes). `socketId` models a distinct relay connection (a new socket =
   * empty scope cache). `sentControlFrames` lets tests assert order (Test 2).
   */
  private readonly broker: InProcessLogBroker | null
  readonly socketId: string
  readonly sentControlFrames: ControlFrame[] = []

  constructor(options?: { broker?: InProcessLogBroker; socketId?: string }) {
    this.broker = options?.broker ?? null
    this.socketId = options?.socketId ?? globalThis.crypto.randomUUID()
  }

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

    // Register in multi-device set
    let devices = InMemoryMessagingAdapter.registry.get(myDid)
    if (!devices) {
      devices = new Set()
      InMemoryMessagingAdapter.registry.set(myDid, devices)
    }
    devices.add(this)

    // Register this socket with the log broker (if wired).
    if (this.broker) {
      this.broker.registerSocket({
        socketId: this.socketId,
        did: myDid,
        deliver: (message) => this.deliverToSelf(message),
      })
    }

    // Deliver queued messages to THIS newly connected device only
    // (other already-connected devices received them at send time)
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
      const devices = InMemoryMessagingAdapter.registry.get(this.myDid)
      if (devices) {
        devices.delete(this)
        if (devices.size === 0) {
          InMemoryMessagingAdapter.registry.delete(this.myDid)
        }
      }
    }
    if (this.broker) this.broker.unregisterSocket(this.socketId)
    this.myDid = null
    this.notifyStateChange('disconnected')
  }

  /**
   * VE-9/VE-11: send a CLOSED top-level control frame to the broker and resolve
   * with its receipt (or reject with a ControlFrameRejectedError). Records the
   * frame for test ordering assertions.
   */
  async sendControlFrame(frame: ControlFrame): Promise<ControlFrameReceipt> {
    if (this.state !== 'connected' || !this.myDid) {
      throw new Error('MessagingAdapter: must call connect() before sendControlFrame()')
    }
    if (!this.broker) {
      throw new Error('InMemoryMessagingAdapter: no broker wired for control frames')
    }
    this.sentControlFrames.push(frame)
    return this.broker.handleControlFrame(this.socketId, frame)
  }

  getState(): MessagingState {
    return this.state
  }

  async send(envelope: WireMessage): Promise<DeliveryReceipt> {
    if (this.state !== 'connected' || !this.myDid) {
      throw new Error('MessagingAdapter: must call connect() before send()')
    }

    const now = new Date().toISOString()

    // VE-2/VE-4: when a broker is wired, log-entry / sync-request envelopes are
    // ingest-gated by it (verify → device-active → capability → seq-collision →
    // accept+broadcast / sync-response). It returns true when it handled the
    // message, so we do NOT also peer-route it (relay parity + LOOP-GUARD: the
    // broker never echoes to the author socket).
    if (this.broker && this.myDid) {
      const handled = await this.broker.handleSend(
        { socketId: this.socketId, did: this.myDid, deliver: (m) => this.deliverToSelf(m) },
        envelope,
      )
      if (handled) {
        return { messageId: envelope.id, status: 'accepted', timestamp: now }
      }
    }

    // Relay-Parität (Sync 003 ack/1.0): ein Inbox-ACK ist an den Broker gerichtet —
    // er räumt den Store-and-Forward-Slot der referenzierten Nachricht und wird
    // nicht geroutet.
    if (isDidcommMessage(envelope) && envelope.type === ACK_MESSAGE_TYPE) {
      const messageId = (envelope.body as Record<string, unknown>).messageId
      for (const [did, queue] of InMemoryMessagingAdapter.offlineQueue) {
        const next = queue.filter((queued) => queued.id !== messageId)
        if (next.length > 0) InMemoryMessagingAdapter.offlineQueue.set(did, next)
        else InMemoryMessagingAdapter.offlineQueue.delete(did)
      }
      return { messageId: envelope.id, status: 'delivered', timestamp: now }
    }

    // VE-8: Old-World routet über toDid, DIDComm über to[0] (wie das Relay).
    const toDid = wireMessageRecipient(envelope)
    if (!toDid) {
      throw new Error('MessagingAdapter: envelope has no recipient (toDid / to[0])')
    }

    // Deliver to all currently connected devices of recipient
    const recipients = InMemoryMessagingAdapter.registry.get(toDid)
    if (recipients && recipients.size > 0) {
      for (const device of recipients) {
        await device.deliverToSelf(envelope)
      }

      // Notify sender of delivered receipt (async callback, like real relay)
      const deliveredReceipt: DeliveryReceipt = {
        messageId: envelope.id,
        status: 'delivered',
        timestamp: now,
      }
      for (const cb of this.receiptCallbacks) {
        cb(deliveredReceipt)
      }
    }

    // Also queue for future devices that may connect later (multi-device).
    // The real relay does store-and-forward: delivered messages are kept until ACK.
    // On connect(), queued messages are delivered to newly connected device.
    const queue = InMemoryMessagingAdapter.offlineQueue.get(toDid) ?? []
    queue.push(envelope)
    InMemoryMessagingAdapter.offlineQueue.set(toDid, queue)

    return {
      messageId: envelope.id,
      status: 'accepted',
      timestamp: now,
    }
  }

  onMessage(callback: (envelope: WireMessage) => void | Promise<void>): () => void {
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
    for (const devices of InMemoryMessagingAdapter.registry.values()) {
      for (const adapter of devices) {
        adapter.myDid = null
        adapter.state = 'disconnected'
      }
    }
    InMemoryMessagingAdapter.registry.clear()
    InMemoryMessagingAdapter.offlineQueue.clear()
    InMemoryMessagingAdapter.transportMap.clear()
  }

  private async deliverToSelf(envelope: WireMessage): Promise<void> {
    for (const cb of this.messageCallbacks) {
      try {
        await cb(envelope)
      } catch (err) {
        console.error('Message callback error:', err)
      }
    }
  }
}
