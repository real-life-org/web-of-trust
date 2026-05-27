import type { MessagingAdapter } from '../../ports/MessagingAdapter'
import type {
  MessageEnvelope,
  DeliveryReceipt,
  MessagingState,
} from '../../types/messaging'
import {
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
} from '../../protocol/sync/broker-auth-transcript'
import { formatBrokerChallengeResponseSignature } from '../../protocol/sync/broker-challenge-response-frame'

/**
 * Signs the JCS-canonicalized Broker-Auth-Transcript bytes for Sync 003
 * `challenge-response`. Returns the raw 64-byte Ed25519 signature; the adapter
 * encodes it as canonical unpadded Base64URL via the protocol helper.
 */
export type SignBrokerAuthTranscriptFn = (transcriptBytes: Uint8Array) => Promise<Uint8Array>

/**
 * WebSocket-based messaging adapter that connects to a Sync 003 broker.
 *
 * Auth flow (Sync 003 Broker-Auth-Transcript):
 * 1. Client → { type: 'register', did, deviceId }
 * 2. Relay  → { type: 'challenge', nonce }   // canonical unpadded Base64URL
 * 3. Client → { type: 'challenge-response', did, deviceId, nonce, signature }
 *                                            // signature over JCS(transcript)
 * 4. Relay  → { type: 'registered', did, deviceId, isNewDevice, peers }
 */
export class WebSocketMessagingAdapter implements MessagingAdapter {
  private ws: WebSocket | null = null
  private state: MessagingState = 'disconnected'
  private messageCallbacks = new Set<(envelope: MessageEnvelope) => void | Promise<void>>()
  private receiptCallbacks = new Set<(receipt: DeliveryReceipt) => void>()
  private stateCallbacks = new Set<(state: MessagingState) => void>()
  private transportMap = new Map<string, string>()
  private pendingReceipts = new Map<string, (receipt: DeliveryReceipt) => void>()
  /** Buffer for messages that arrive before any onMessage handler is registered */
  private earlyMessageBuffer: MessageEnvelope[] = []
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly HEARTBEAT_INTERVAL_MS = 15_000
  private readonly HEARTBEAT_TIMEOUT_MS = 5_000
  private readonly SEND_TIMEOUT_MS: number

  private readonly deviceId: string
  private readonly signBrokerAuthTranscript: SignBrokerAuthTranscriptFn | null

  constructor(
    private relayUrl: string,
    options?: {
      deviceId?: string
      signBrokerAuthTranscript?: SignBrokerAuthTranscriptFn
      sendTimeoutMs?: number
    },
  ) {
    // Sync 003 requires a canonical lowercase UUID-v4 deviceId on register.
    // Callers SHOULD pass a stable per-device id; we generate an ephemeral one
    // as a runtime fallback so consumers that have not yet wired a stable
    // source still emit a valid frame.
    this.deviceId = options?.deviceId ?? crypto.randomUUID()
    this.signBrokerAuthTranscript = options?.signBrokerAuthTranscript ?? null
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
  private peerCount = 0

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

      const sendRegister = () => {
        this.ws?.send(JSON.stringify({ type: 'register', did: myDid, deviceId: this.deviceId }))
      }

      this.ws.onopen = () => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          sendRegister()
        } else {
          // Rare timing edge: onopen fired but readyState not yet OPEN
          const ws = this.ws!
          const checkAndSend = () => {
            if (ws.readyState === WebSocket.OPEN) {
              sendRegister()
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
          case 'challenge':
            // Sync 003: sign the JCS-canonicalized Broker-Auth-Transcript bytes,
            // not the raw nonce string.
            if (this.signBrokerAuthTranscript) {
              const transcript = buildBrokerAuthTranscript({
                did: myDid,
                deviceId: this.deviceId,
                nonce: msg.nonce,
              })
              const signingBytes = createBrokerAuthTranscriptSigningBytes(transcript)
              this.signBrokerAuthTranscript(signingBytes)
                .then((signatureBytes) => {
                  const signature = formatBrokerChallengeResponseSignature(signatureBytes)
                  this.ws?.send(
                    JSON.stringify({
                      type: 'challenge-response',
                      did: myDid,
                      deviceId: this.deviceId,
                      nonce: msg.nonce,
                      signature,
                    }),
                  )
                })
                .catch((err) => {
                  this.setState('error')
                  reject(
                    new Error(
                      `Broker-auth transcript signing failed: ${err instanceof Error ? err.message : String(err)}`,
                    ),
                  )
                })
            } else {
              // No signer provided — reject (relay requires auth)
              this.setState('error')
              reject(
                new Error(
                  'Relay requires Sync 003 broker-auth signing but no signBrokerAuthTranscript function provided',
                ),
              )
            }
            break

          case 'registered':
            this.connectedDid = myDid
            this.peerCount = typeof msg.peers === 'number' ? msg.peers : 0
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
    this.earlyMessageBuffer.length = 0
    this.pendingReceipts.clear()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setState('disconnected')
  }

  getState(): MessagingState {
    return this.state
  }

  getPeerCount(): number {
    return this.peerCount
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatInterval = setInterval(() => {
      if (this.state !== 'connected' || !this.ws) {
        this.stopHeartbeat()
        return
      }
      // Send ping and start timeout
      if (this.ws.readyState !== WebSocket.OPEN) return
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
   * If no handlers are registered yet, buffer the message for later delivery.
   */
  private async handleIncomingMessage(envelope: MessageEnvelope): Promise<void> {
    if (this.messageCallbacks.size === 0) {
      // No handlers yet — buffer for delivery when first handler registers
      this.earlyMessageBuffer.push(envelope)
      return
    }

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
    if (processed && this.ws && this.ws.readyState === WebSocket.OPEN) {
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
      if (this.ws!.readyState !== WebSocket.OPEN) {
        if (timer) clearTimeout(timer)
        this.pendingReceipts.delete(envelope.id)
        reject(new Error('WebSocket not open'))
        return
      }
      this.ws!.send(JSON.stringify({ type: 'send', envelope }))
    })
  }

  onMessage(callback: (envelope: MessageEnvelope) => void | Promise<void>): () => void {
    this.messageCallbacks.add(callback)

    // Flush buffered messages that arrived before any handler was registered
    if (this.earlyMessageBuffer.length > 0) {
      const buffered = this.earlyMessageBuffer.splice(0)
      for (const envelope of buffered) {
        void this.handleIncomingMessage(envelope)
      }
    }

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
