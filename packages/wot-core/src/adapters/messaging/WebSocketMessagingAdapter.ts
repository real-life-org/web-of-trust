import type { MessagingAdapter, WireMessage } from '../../ports/MessagingAdapter'
import type {
  DeliveryReceipt,
  MessagingState,
} from '../../types/messaging'
import { isDidcommMessage } from '../../protocol/messaging/inbox-message'
import {
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
} from '../../protocol/sync/broker-auth-transcript'
import { formatBrokerChallengeResponseSignature } from '../../protocol/sync/broker-challenge-response-frame'
import {
  ControlFrameRejectedError,
  type ControlFrame,
  type ControlFrameReceipt,
} from '../../protocol/sync/control-frame-transport'
import { isKnownBrokerErrorCode } from '../../protocol/sync/broker-error'
import { controlFrameDocId } from '../../protocol/sync/control-frame-doc-id'
import { SYNC_REQUEST_MESSAGE_TYPE } from '../../protocol/sync/sync-messages'

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
  private messageCallbacks = new Set<(envelope: WireMessage) => void | Promise<void>>()
  private receiptCallbacks = new Set<(receipt: DeliveryReceipt) => void>()
  private stateCallbacks = new Set<(state: MessagingState) => void>()
  private transportMap = new Map<string, string>()
  private pendingReceipts = new Map<string, (receipt: DeliveryReceipt) => void>()
  /**
   * VE-9/VE-11 control-frame waiters, keyed by the docId the frame targets (the
   * relay's receipt `messageId == docId`). The LogSyncCoordinator serializes
   * control frames per (socket, docId), so at most one waiter per docId exists at
   * a time — the docId key is therefore unambiguous here.
   */
  private pendingControlFrames = new Map<
    string,
    { resolve: (receipt: ControlFrameReceipt) => void; reject: (err: Error) => void }
  >()
  /**
   * CONCERN-2: per-docId serialization tail for control frames. The receipt
   * correlation is keyed by docId and `pendingControlFrames` holds ONE waiter per
   * docId, so two control frames for the SAME docId in flight at once (e.g. a
   * coordinator present-capability racing an out-of-band space-rotate) would
   * overwrite each other's waiter → a spurious timeout. Chaining same-docId frames
   * on this tail guarantees at most one is in flight per docId, independent of
   * which caller path sent it. Different docIds still run concurrently.
   */
  private controlFrameTails = new Map<string, Promise<unknown>>()
  /** Buffer for messages that arrive before any onMessage handler is registered */
  private earlyMessageBuffer: WireMessage[] = []
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly HEARTBEAT_INTERVAL_MS = 15_000
  private readonly HEARTBEAT_TIMEOUT_MS = 5_000
  private readonly SEND_TIMEOUT_MS: number

  // Mutable: a VE-11 restore-clone re-binds it to a fresh deviceId via rebindDeviceId().
  private deviceId: string
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
            this.handleIncomingMessage(msg.envelope as WireMessage)
            break

          case 'receipt': {
            const receipt = msg.receipt as DeliveryReceipt
            // VE-9: a control-frame waiter (keyed by docId == receipt.messageId)
            // resolves first, if present. Otherwise this is a normal send() receipt.
            const controlWaiter = this.pendingControlFrames.get(receipt.messageId)
            if (controlWaiter && receipt.status === 'delivered') {
              this.pendingControlFrames.delete(receipt.messageId)
              controlWaiter.resolve({
                messageId: receipt.messageId,
                status: 'delivered',
                timestamp: receipt.timestamp,
              })
            } else {
              // Resolve pending send() promise if waiting
              const pending = this.pendingReceipts.get(receipt.messageId)
              if (pending) {
                this.pendingReceipts.delete(receipt.messageId)
                pending(receipt)
              }
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
            } else {
              this.handleControlFrameError(msg)
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
    for (const waiter of this.pendingControlFrames.values()) {
      waiter.reject(new Error('WebSocket disconnected before control-frame receipt'))
    }
    this.pendingControlFrames.clear()
    this.controlFrameTails.clear()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setState('disconnected')
  }

  /**
   * VE-11: re-bind to a NEW deviceId for the same identity and re-register it on a
   * FRESH socket (the relay forbids re-register on an existing socket). Resolves
   * only once the new device is `registered` — connect() resolves on the
   * `registered` frame, so awaiting it gives the caller the exact "now registered"
   * signal the restore-clone write-pause waits for. If not currently connected, the
   * new id is adopted and the next connect() registers with it.
   */
  async rebindDeviceId(newDeviceId: string): Promise<void> {
    const did = this.connectedDid
    if (did === null) {
      this.deviceId = newDeviceId
      return
    }
    const oldDeviceId = this.deviceId
    await this.disconnect()
    this.deviceId = newDeviceId
    try {
      await this.connect(did)
    } catch (err) {
      // The fresh socket failed to register the new deviceId → ROLL BACK, so the
      // adapter is never left split-brained (deviceId mutated but unregistered, which
      // would make every subsequent write reject DEVICE_NOT_REGISTERED). The caller
      // (logRestoreClone → coordinator.restoreClone) sees the throw and abandons the
      // restore; the coordinator never advanced its deviceId either, so both stay on
      // the OLD id and the restore re-triggers on the next reconnect/catch-up.
      this.deviceId = oldDeviceId
      throw err
    }
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
   * Process incoming message: await all callbacks, then ACK (Old-World only).
   * If no handlers are registered yet, buffer the message for later delivery.
   */
  private async handleIncomingMessage(envelope: WireMessage): Promise<void> {
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
    // K1 (Sync 003 Z.613-622): DIDComm-Inbox-Nachrichten werden NICHT auto-geACKt —
    // ACK-Ownership liegt beim Inbox-Reception-Host nach evaluierter Ack-Disposition
    // (Anwendung erfolgt ODER durabel gepuffert). Old-World-CRDT-Sync behält Auto-ACK.
    // Eine ueber handleControlFrameError hierher gefaechelte write-path-`error`-Frame
    // ist kein zustellbarer Content (und traegt keine `id`) — sie wird NICHT geACKt.
    if (
      processed &&
      !isDidcommMessage(envelope) &&
      (envelope as { type?: unknown }).type !== 'error' &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
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

  async send(envelope: WireMessage): Promise<DeliveryReceipt> {
    if (this.state !== 'connected' || !this.ws) {
      throw new Error('WebSocketMessagingAdapter: must call connect() before send()')
    }

    // VE-11 wire-contract: a `sync-request/1.0` is a ONE-WAY request. The relay
    // never answers it with a `receipt` — it answers asynchronously with a
    // `sync-response/1.0` MESSAGE (routed to onMessage; the LogSyncCoordinator
    // correlates it by thid) or, on a gate failure, an `error` frame. Awaiting a
    // receipt here would therefore always time out. Send fire-and-forget and
    // resolve immediately with an `accepted` acknowledgement; the coordinator's
    // own pending-sync-request waiter resolves when the sync-response arrives.
    if ((envelope as { type?: string }).type === SYNC_REQUEST_MESSAGE_TYPE) {
      if (this.ws.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket not open')
      }
      this.ws.send(JSON.stringify({ type: 'send', envelope }))
      return { messageId: envelope.id, status: 'accepted', timestamp: new Date().toISOString() }
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

  /**
   * VE-9/VE-11: send a CLOSED top-level control frame and await its receipt. The
   * frame is sent verbatim (NOT wrapped in a `send` envelope). The relay answers
   * with `{ type:'receipt', receipt:{ messageId:<docId>, status:'delivered' } }`
   * (resolve) or `{ type:'error', code, message }` (reject with
   * ControlFrameRejectedError). Correlation is by the frame's docId; the caller
   * serializes control frames per (socket, docId), so only one is in flight per
   * docId.
   */
  async sendControlFrame(frame: ControlFrame): Promise<ControlFrameReceipt> {
    const docId = controlFrameDocId(frame)
    if (!docId) {
      throw new Error('WebSocketMessagingAdapter: control frame has no docId for receipt correlation')
    }
    // CONCERN-2: serialize control frames per docId so a same-docId race (e.g. an
    // out-of-band space-rotate vs. a present-capability) never overwrites the
    // single per-docId receipt waiter. When NO same-docId frame is in flight, send
    // immediately (preserving the VE-9 single-in-flight timing the callers rely
    // on). When one IS in flight, chain behind it; the prior's rejection does not
    // poison the next.
    const prior = this.controlFrameTails.get(docId)
    const run = prior
      ? prior.then(
          () => this.sendControlFrameNow(frame, docId),
          () => this.sendControlFrameNow(frame, docId),
        )
      : this.sendControlFrameNow(frame, docId)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.controlFrameTails.set(docId, tail)
    void tail.then(() => {
      if (this.controlFrameTails.get(docId) === tail) this.controlFrameTails.delete(docId)
    })
    return run
  }

  /** Send one control frame and await its receipt (the per-docId-serialized body). */
  private async sendControlFrameNow(frame: ControlFrame, docId: string): Promise<ControlFrameReceipt> {
    if (this.state !== 'connected' || !this.ws) {
      throw new Error('WebSocketMessagingAdapter: must call connect() before sendControlFrame()')
    }

    return new Promise<ControlFrameReceipt>((resolve, reject) => {
      const timer = this.SEND_TIMEOUT_MS > 0
        ? setTimeout(() => {
            this.pendingControlFrames.delete(docId)
            reject(new Error(`Control-frame timeout: no receipt from relay after ${this.SEND_TIMEOUT_MS}ms`))
          }, this.SEND_TIMEOUT_MS)
        : null

      this.pendingControlFrames.set(docId, {
        resolve: (receipt) => {
          if (timer) clearTimeout(timer)
          resolve(receipt)
        },
        reject: (err) => {
          if (timer) clearTimeout(timer)
          reject(err)
        },
      })

      if (this.ws!.readyState !== WebSocket.OPEN) {
        if (timer) clearTimeout(timer)
        this.pendingControlFrames.delete(docId)
        reject(new Error('WebSocket not open'))
        return
      }
      // The control frame is the top-level message (closed frame), NOT a `send` envelope.
      this.ws!.send(JSON.stringify(frame))
    })
  }

  /**
   * Handle a relay `error` frame. A `thid` matching a pending CONTROL frame (keyed by
   * docId) rejects that waiter — the original present-capability / space-register /
   * space-rotate behaviour. Otherwise the `thid` is a SENT log-entry envelope id, i.e.
   * a WRITE-PATH reject (KEY_GENERATION_STALE, SEQ_COLLISION_DETECTED, a routed
   * CAPABILITY/DEVICE reject, …): forward it to the message-callback path so the
   * replication adapter routes it to the owning coordinator's onWritePathErrorFrame
   * (VE-4 reject-disposition / VE-C2 re-emit). Without this fan-out a write-path error
   * frame would be SILENTLY DROPPED over the real socket — it matches no control-frame
   * waiter — so the coordinator never acts on the reject (the in-process broker feeds
   * the same path as `message`, which is why it was masked in unit tests).
   */
  private handleControlFrameError(msg: { thid?: unknown; code?: unknown; message?: unknown }): void {
    const docId = typeof msg.thid === 'string' ? msg.thid : undefined
    const code = msg.code
    const waiter = docId ? this.pendingControlFrames.get(docId) : undefined
    if (waiter && docId) {
      this.pendingControlFrames.delete(docId)
      if (isKnownBrokerErrorCode(code)) {
        waiter.reject(
          new ControlFrameRejectedError({
            code,
            message: typeof msg.message === 'string' ? msg.message : code,
          }),
        )
      } else {
        waiter.reject(new Error(`Control frame rejected: ${typeof msg.message === 'string' ? msg.message : 'unknown'}`))
      }
      return
    }
    // No pending control frame for this thid → a write-path reject. Deliver the raw
    // error frame ({ type:'error', thid, code, message }) to the message callbacks
    // (the same path the in-process broker uses); routeWritePathError matches the
    // thid to an in-flight write and drives the coordinator. An error that correlates
    // to nothing is harmlessly ignored downstream.
    void this.handleIncomingMessage(msg as unknown as WireMessage)
  }

  onMessage(callback: (envelope: WireMessage) => void | Promise<void>): () => void {
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
