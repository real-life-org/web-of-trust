import type { MessagingAdapter } from '../interfaces/MessagingAdapter'
import type {
  MessageEnvelope,
  DeliveryReceipt,
  MessagingState,
} from '../../types/messaging'

/**
 * WebSocket-based messaging adapter that connects to a relay server.
 *
 * Uses the browser-native WebSocket API (no `ws` dependency needed).
 * The relay is blind — it only forwards envelopes without inspecting payloads.
 *
 * Protocol:
 * - Client sends: { type: 'register', did } | { type: 'send', envelope } | { type: 'ack', messageId }
 * - Relay sends:  { type: 'registered', did } | { type: 'message', envelope }
 *                 | { type: 'receipt', receipt } | { type: 'error', code, message }
 */
export class WebSocketMessagingAdapter implements MessagingAdapter {
  private ws: WebSocket | null = null
  private state: MessagingState = 'disconnected'
  private messageCallbacks = new Set<(envelope: MessageEnvelope) => void | Promise<void>>()
  private receiptCallbacks = new Set<(receipt: DeliveryReceipt) => void>()
  private stateCallbacks = new Set<(state: MessagingState) => void>()
  private transportMap = new Map<string, string>()
  private pendingReceipts = new Map<string, (receipt: DeliveryReceipt) => void>()
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly HEARTBEAT_INTERVAL_MS = 15_000
  private readonly HEARTBEAT_TIMEOUT_MS = 5_000
  private readonly SEND_TIMEOUT_MS: number

  constructor(private relayUrl: string, options?: { sendTimeoutMs?: number }) {
    this.SEND_TIMEOUT_MS = options?.sendTimeoutMs ?? 10_000
  }

  private setState(newState: MessagingState) {
    this.state = newState
    for (const cb of this.stateCallbacks) {
      cb(newState)
    }
  }

  onStateChange(callback: (state: MessagingState) => void): () => void {
    this.stateCallbacks.add(callback)
    return () => { this.stateCallbacks.delete(callback) }
  }

  private connectedDid: string | null = null

  async connect(myDid: string): Promise<void> {
    // Idempotent: if already connected with the same DID, skip reconnect
    if (this.state === 'connected' && this.connectedDid === myDid) {
      return
    }
    if (this.state === 'connected') {
      await this.disconnect()
    }

    this.setState('connecting')

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.relayUrl)

      this.ws.onopen = () => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'register', did: myDid }))
        } else {
          // Rare timing edge: onopen fired but readyState not yet OPEN
          const ws = this.ws!
          const checkAndSend = () => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'register', did: myDid }))
            } else if (ws.readyState === WebSocket.CONNECTING) {
              setTimeout(checkAndSend, 10)
            } else {
              reject(new Error('WebSocket closed before registration'))
            }
          }
          setTimeout(checkAndSend, 10)
        }
      }

      this.ws.onmessage = (event) => {
        let msg: any
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
        } catch {
          console.warn('[WebSocket] Received malformed JSON, ignoring')
          return
        }

        switch (msg.type) {
          case 'registered':
            this.connectedDid = myDid
            this.setState('connected')
            this.startHeartbeat()
            resolve()
            break

          case 'message':
            this.handleIncomingMessage(msg.envelope as MessageEnvelope)
            break

          case 'receipt': {
            const receipt = msg.receipt as DeliveryReceipt
            // Resolve pending send() promise if waiting
            const pending = this.pendingReceipts.get(receipt.messageId)
            if (pending) {
              this.pendingReceipts.delete(receipt.messageId)
              pending(receipt)
            }
            // Notify receipt callbacks
            for (const cb of this.receiptCallbacks) {
              cb(receipt)
            }
            break
          }

          case 'pong':
            this.handlePong()
            break

          case 'error':
            if (this.state === 'connecting') {
              this.setState('error')
              reject(new Error(`Relay error: ${msg.message}`))
            }
            break
        }
      }

      this.ws.onerror = () => {
        if (this.state === 'connecting') {
          this.setState('error')
          reject(new Error(`WebSocket connection failed to ${this.relayUrl}`))
        }
      }

      this.ws.onclose = () => {
        this.setState('disconnected')
      }
    })
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat()
    this.connectedDid = null
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setState('disconnected')
  }

  getState(): MessagingState {
    return this.state
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatInterval = setInterval(() => {
      if (this.state !== 'connected' || !this.ws) {
        this.stopHeartbeat()
        return
      }
      // Send ping and start timeout
      this.ws.send(JSON.stringify({ type: 'ping' }))
      this.heartbeatTimeout = setTimeout(() => {
        // No pong received — connection is dead
        this.stopHeartbeat()
        if (this.ws) {
          this.ws.close()
          this.ws = null
        }
        this.setState('disconnected')
      }, this.HEARTBEAT_TIMEOUT_MS)
    }, this.HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = null
    }
  }

  /**
   * Process incoming message: await all callbacks, then ACK.
   * Extracted from onmessage handler so callbacks can be async.
   */
  private async handleIncomingMessage(envelope: MessageEnvelope): Promise<void> {
    let processed = false
    for (const cb of this.messageCallbacks) {
      try {
        await cb(envelope)
        processed = true
      } catch (err) {
        console.error('Message callback error:', err)
      }
    }
    // ACK: tell relay we processed the message (only after all callbacks resolved)
    if (processed && this.ws) {
      this.ws.send(JSON.stringify({ type: 'ack', messageId: envelope.id }))
    }
  }

  private handlePong(): void {
    // Pong received — connection is alive, clear timeout
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = null
    }
  }

  async send(envelope: MessageEnvelope): Promise<DeliveryReceipt> {
    if (this.state !== 'connected' || !this.ws) {
      throw new Error('WebSocketMessagingAdapter: must call connect() before send()')
    }

    return new Promise<DeliveryReceipt>((resolve, reject) => {
      const timer = this.SEND_TIMEOUT_MS > 0
        ? setTimeout(() => {
            this.pendingReceipts.delete(envelope.id)
            reject(new Error(`Send timeout: no receipt from relay after ${this.SEND_TIMEOUT_MS}ms`))
          }, this.SEND_TIMEOUT_MS)
        : null

      // Register pending receipt handler
      this.pendingReceipts.set(envelope.id, (receipt) => {
        if (timer) clearTimeout(timer)
        resolve(receipt)
      })

      // Send to relay
      this.ws!.send(JSON.stringify({ type: 'send', envelope }))
    })
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
    this.transportMap.set(did, transportAddress)
  }

  async resolveTransport(did: string): Promise<string | null> {
    return this.transportMap.get(did) ?? null
  }
}
