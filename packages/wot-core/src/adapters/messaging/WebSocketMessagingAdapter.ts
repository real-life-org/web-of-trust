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
  private readonly HEARTBEAT_INTERVAL_MS: number
  private readonly HEARTBEAT_TIMEOUT_MS: number
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
      /** Heartbeat ping cadence (default 15 000 ms). Tunable for tests. */
      heartbeatIntervalMs?: number
      /** Grace window for a pong before the socket is judged dead (default 5 000 ms). */
      heartbeatTimeoutMs?: number
    },
  ) {
    // Sync 003 requires a canonical lowercase UUID-v4 deviceId on register.
    // Callers SHOULD pass a stable per-device id; we generate an ephemeral one
    // as a runtime fallback so consumers that have not yet wired a stable
    // source still emit a valid frame.
    this.deviceId = options?.deviceId ?? crypto.randomUUID()
    this.signBrokerAuthTranscript = options?.signBrokerAuthTranscript ?? null
    this.SEND_TIMEOUT_MS = options?.sendTimeoutMs ?? 10_000
    this.HEARTBEAT_INTERVAL_MS = options?.heartbeatIntervalMs ?? 15_000
    this.HEARTBEAT_TIMEOUT_MS = options?.heartbeatTimeoutMs ?? 5_000
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
  /**
   * Settles the in-flight connect() promise. disconnect() (e.g. the multiplexer's
   * dial timeout) rejects it deterministically — after the teardown the socket's
   * events are dead (instance guard below), so nothing else would ever settle it.
   */
  private pendingConnect: { resolve: () => void; reject: (err: Error) => void } | null = null

  async connect(myDid: string): Promise<void> {
    // Idempotent: if already connected with the same DID, skip reconnect
    if (this.state === 'connected' && this.connectedDid === myDid) {
      return
    }
    if (this.state === 'connected') {
      await this.disconnect()
    }
    // A connect() superseding a still-dialing connect(): settle the old attempt and
    // close its socket so it cannot linger half-registered on the relay side.
    this.pendingConnect?.reject(new Error('connect() superseded by a newer connect()'))
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.setState('connecting')

    return new Promise<void>((resolve, reject) => {
      // Socket-instance safety (#251 re-review): every handler below captures THIS
      // socket. After a teardown + redial this.ws holds the NEXT socket — a late
      // event from this one must neither mutate adapter state nor write frames onto
      // the new socket. Guard everywhere: `this.ws !== ws` → this event is stale.
      // All sends inside the handlers go through the captured `ws`, never this.ws.
      const ws = new WebSocket(this.relayUrl)
      this.ws = ws

      const settle = {
        resolve: () => {
          if (this.pendingConnect === settle) this.pendingConnect = null
          resolve()
        },
        reject: (err: Error) => {
          if (this.pendingConnect === settle) this.pendingConnect = null
          reject(err)
        },
      }
      this.pendingConnect = settle

      const sendRegister = () => {
        ws.send(JSON.stringify({ type: 'register', did: myDid, deviceId: this.deviceId }))
      }

      ws.onopen = () => {
        if (this.ws !== ws) return
        if (ws.readyState === WebSocket.OPEN) {
          sendRegister()
        } else {
          // Rare timing edge: onopen fired but readyState not yet OPEN
          const checkAndSend = () => {
            if (this.ws !== ws) return
            if (ws.readyState === WebSocket.OPEN) {
              sendRegister()
            } else if (ws.readyState === WebSocket.CONNECTING) {
              setTimeout(checkAndSend, 10)
            } else {
              settle.reject(new Error('WebSocket closed before registration'))
            }
          }
          setTimeout(checkAndSend, 10)
        }
      }

      ws.onmessage = (event) => {
        if (this.ws !== ws) return
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
                  // Async gap: the adapter may have been torn down / redialed while
                  // signing — this response belongs to THIS socket's nonce only.
                  if (this.ws !== ws) return
                  const signature = formatBrokerChallengeResponseSignature(signatureBytes)
                  ws.send(
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
                  if (this.ws !== ws) return
                  this.setState('error')
                  settle.reject(
                    new Error(
                      `Broker-auth transcript signing failed: ${err instanceof Error ? err.message : String(err)}`,
                    ),
                  )
                })
            } else {
              // No signer provided — reject (relay requires auth)
              this.setState('error')
              settle.reject(
                new Error(
                  'Relay requires Sync 003 broker-auth signing but no signBrokerAuthTranscript function provided',
                ),
              )
            }
            break

          case 'registered':
            // Late-success safety (#251 dual-broker): after disconnect() — e.g. the
            // multiplexer's dial timeout — or a redial, a still-in-flight
            // 'registered' from THIS socket must NOT flip the adapter to
            // 'connected'. The instance guard at the top of onmessage covers both
            // the torn-down (this.ws === null) and the replaced-socket case.
            this.connectedDid = myDid
            this.peerCount = typeof msg.peers === 'number' ? msg.peers : 0
            this.setState('connected')
            // Bind the heartbeat to THIS socket instance (not this.ws): after a
            // teardown+redial a stale timer must never probe or kill the next
            // socket (#251 socket-instance safety).
            this.startHeartbeat(ws)
            settle.resolve()
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
              settle.reject(new Error(`Relay error: ${msg.message}`))
            } else {
              this.handleControlFrameError(msg)
            }
            break
        }
      }

      ws.onerror = () => {
        if (this.ws !== ws) return
        if (this.state === 'connecting') {
          this.setState('error')
          settle.reject(new Error(`WebSocket connection failed to ${this.relayUrl}`))
        }
      }

      ws.onclose = () => {
        // A late close from a replaced socket must not flip the CURRENT
        // connection's state to 'disconnected' (the outbox timer and the
        // multiplexer's reconnect loop key off this state).
        if (this.ws !== ws) return
        // Stop the heartbeat AFTER the instance guard: a live socket's close must
        // stop its own timer immediately (so no stale pong-timeout survives into
        // the next redial), but a stale close from a replaced socket returns above
        // and must NOT touch the live socket's heartbeat.
        this.stopHeartbeat()
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
    // Settle an in-flight connect() NOW: after this teardown its socket's events
    // are dead (instance guard), so the promise would otherwise hang forever —
    // the multiplexer's dial timeout relies on this rejection to mark the child.
    this.pendingConnect?.reject(new Error('WebSocket disconnected before registration'))
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

  /**
   * Transport-liveness heartbeat, bound to a SINGLE socket instance (`ws`), not to
   * `this.ws`. All three failure modes the DWeb-Camp field bug exposed are handled
   * here:
   *
   *  (a) CLOSING/CLOSED-Erkennung: a half-open socket wedged in CLOSING while the
   *      state still reads 'connected' (Android WebView initiates close on a
   *      network flap, the TCP close-handshake never completes) is a DEAD
   *      transport. The old code returned early on `readyState !== OPEN` → no ping,
   *      no timeout, state lied 'connected' for minutes until TCP gave up. We now
   *      tear it down on the very next tick so the reconnect loop fires.
   *  (b) Instanz-Bindung: the pong-timeout closes the captured `ws`, never
   *      `this.ws`. After a redial `this.ws` is the NEXT socket — a stale timeout
   *      must not kill it (killSocket's instance guard enforces this).
   *  (c) Eine Teardown-Quelle: death is funnelled through killSocket() — a
   *      DELIBERATE direct teardown, not "call ws.close() and let onclose finish".
   *      We choose direct teardown because the primary death mode is a socket stuck
   *      in CLOSING, where the browser's close-handshake is already wedged and
   *      onclose may not fire for minutes — flipping state here is the only prompt
   *      path. onclose stays instance-guarded and idempotent for the other paths.
   *
   * NOTE (documented limit, post-camp): the ping is PRE-AUTH at the relay — it
   * proves TRANSPORT liveness, not SESSION liveness. A socket that is open but whose
   * registration was dropped server-side still answers pong, so this heartbeat will
   * NOT detect that class of half-open. Session-level liveness is a separate,
   * deferred concern.
   */
  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat()
    this.heartbeatInterval = setInterval(() => {
      // Instance + state guard: a redial replaced this.ws, or we are no longer
      // connected → this interval is orphaned, stop it.
      if (this.ws !== ws || this.state !== 'connected') {
        this.stopHeartbeat()
        return
      }
      // (a) CLOSING/CLOSED while 'connected' = dead transport → tear down NOW.
      if (ws.readyState !== WebSocket.OPEN) {
        this.killSocket(ws)
        return
      }
      // Doppel-Ping/Timeout-Guard (Codex-Nit): a ping is already outstanding
      // (its pong-timeout is armed). Do NOT stack a second ping/timeout — matters
      // when interval <= timeout, where the next tick would otherwise overwrite
      // this.heartbeatTimeout and leak the first timer. handlePong clears it.
      if (this.heartbeatTimeout) return
      // Send the ping over the CAPTURED socket, never this.ws.
      ws.send(JSON.stringify({ type: 'ping' }))
      this.heartbeatTimeout = setTimeout(() => {
        // No pong within the window — the transport is dead. (b) Bound to THIS
        // socket: killSocket's instance guard makes a stale timeout after a redial
        // a no-op on the new socket.
        this.killSocket(ws)
      }, this.HEARTBEAT_TIMEOUT_MS)
    }, this.HEARTBEAT_INTERVAL_MS)
  }

  /**
   * (c) The single teardown path for a heartbeat-detected dead socket. Direct and
   * instance-guarded: only acts if `ws` is still the live socket, so a late kill
   * from a replaced socket never touches the new connection. Sets state directly
   * (rather than waiting for onclose) because a CLOSING socket's onclose may never
   * fire promptly — this is the whole point of the fix. The subsequent onclose (if
   * any) is caught by its own `this.ws !== ws` guard and does nothing.
   */
  private killSocket(ws: WebSocket): void {
    if (this.ws !== ws) return
    this.stopHeartbeat()
    try {
      ws.close()
    } catch {
      // Already closing/closed — closing again is a spec no-op; ignore.
    }
    this.ws = null
    this.setState('disconnected')
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
  private handleControlFrameError(msg: { thid?: unknown; code?: unknown; message?: unknown; currentGeneration?: unknown }): void {
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
            currentGeneration: typeof msg.currentGeneration === 'number' ? msg.currentGeneration : undefined,
          }),
        )
      } else {
        waiter.reject(new Error(`Control frame rejected: ${typeof msg.message === 'string' ? msg.message : 'unknown'}`))
      }
      return
    }
    // #236 (TC4): a write-path reject correlates to an in-flight send() by
    // thid === envelope.id (the relay sets thid = messageId for the log-entry
    // reject family). Settle that pending send promise NOW with a typed
    // 'failed' receipt instead of letting it run into the receipt timeout —
    // the timeout used to feed the outbox false-enqueues and cost 15s per
    // reject. Resolving (not rejecting) reuses the DeliveryReceipt 'failed'
    // semantics and cannot trigger any wrapper's catch-and-queue path. Errors
    // WITHOUT a thid (JWS-verify AUTH_INVALID, whitelist MALFORMED, internal)
    // stay timeout-driven — no heuristic matching. The registered callback
    // clears the send timer itself.
    if (docId) {
      const pendingSend = this.pendingReceipts.get(docId)
      if (pendingSend) {
        this.pendingReceipts.delete(docId)
        pendingSend({
          messageId: docId,
          status: 'failed',
          timestamp: new Date().toISOString(),
          reason: typeof code === 'string' ? code : 'write-path-rejected',
        })
      }
    }
    // The frame STILL fans out to the message callbacks exactly once (the same
    // path the in-process broker uses); routeWritePathError matches the thid to
    // an in-flight write and drives the coordinator — semantic ownership
    // (supersede / re-emit / terminal retire) stays there. An error that
    // correlates to nothing is harmlessly ignored downstream.
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
