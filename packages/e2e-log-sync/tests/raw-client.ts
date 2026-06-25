/**
 * Slice A / VE-11 — RAW authenticated relay client + capability helpers.
 *
 * A minimal hand-rolled client (register → challenge → challenge-response, then
 * present-capability / log-entry / sync-request) driven by a real identity. The
 * adapters always present a VALID capability, so the gate / capability-origin /
 * expiry tests use this raw client to present EXACTLY the capability under test.
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  createSpaceCapabilityJws,
  createPresentCapabilityControlFrame,
  encodeBase64Url,
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
  formatBrokerChallengeResponseSignature,
  createSpaceRegisterMessageWithSigner,
  createLogEntryMessage,
  createSyncRequestMessage,
  createSyncResponseMessage,
  encryptLogPayload,
  createLogEntryJwsWithSigner,
  DIDCOMM_PLAINTEXT_TYP,
} from '@web_of_trust/core/protocol'
import type { PublicIdentitySession } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'

export const helperCrypto = new WebCryptoProtocolCryptoAdapter()

export async function makeSpaceKeypair(): Promise<{ signingSeed: Uint8Array; verificationKey: string }> {
  const signingSeed = crypto.getRandomValues(new Uint8Array(32))
  const pub = await helperCrypto.ed25519PublicKeyFromSeed(signingSeed)
  return { signingSeed, verificationKey: encodeBase64Url(pub) }
}

export async function mintSpaceCap(params: {
  signingSeed: Uint8Array
  spaceId: string
  audience: string
  permissions: Array<'read' | 'write'>
  generation?: number
  validUntil?: string
}): Promise<string> {
  return createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: params.spaceId,
      audience: params.audience,
      permissions: params.permissions,
      generation: params.generation ?? 0,
      issuedAt: '2026-01-01T00:00:00Z',
      validUntil: params.validUntil ?? '2099-01-01T00:00:00Z',
    },
    signingSeed: params.signingSeed,
  })
}

/**
 * A relay `error` frame as it appears on the wire (Sync 003 / relay.ts:40):
 * `{ type:'error', thid?, code, message }`. The gate's KEY_GENERATION_STALE frame
 * carries `thid == messageId` (relay.ts:1780); MALFORMED_MESSAGE frames carry NO
 * thid. Slice SR Criterion 2/4 assert on these exact fields off the REAL socket.
 */
export interface RawErrorFrame {
  code: string
  thid?: string
  message?: string
}

/** Outcome of a raw send: a relay `receipt` OR a structured `error` frame. */
export type RawOutcome =
  | { kind: 'receipt'; receipt: Record<string, unknown> }
  | { kind: 'error'; error: RawErrorFrame }

export class RawRelayClient {
  private ws: WebSocket | null = null
  private outcomeWaiters: Array<(o: Record<string, unknown> | { error: string }) => void> = []
  private messageWaiters: Array<(env: Record<string, unknown>) => void> = []
  private messageBuffer: Record<string, unknown>[] = []
  /**
   * Slice SR (Criterion 2/4): waiters that receive the FULL outcome frame instead
   * of just the error CODE — so a test can assert `thid == messageId`. These are
   * fed by the SAME message handler (case 'receipt'/'error') as `outcomeWaiters`,
   * but only one waiter family is registered per send (raw* methods use these).
   */
  private rawOutcomeWaiters: Array<(o: RawOutcome) => void> = []
  readonly deviceId = randomUUID()

  constructor(private url: string, private identity: PublicIdentitySession) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.on('open', () => ws.send(JSON.stringify({ type: 'register', did: this.identity.getDid(), deviceId: this.deviceId })))
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        switch (msg.type) {
          case 'challenge': {
            const transcript = buildBrokerAuthTranscript({ did: this.identity.getDid(), deviceId: this.deviceId, nonce: msg.nonce })
            const bytes = createBrokerAuthTranscriptSigningBytes(transcript)
            this.identity.signEd25519(bytes)
              .then((sig) => ws.send(JSON.stringify({
                type: 'challenge-response',
                did: this.identity.getDid(),
                deviceId: this.deviceId,
                nonce: msg.nonce,
                signature: formatBrokerChallengeResponseSignature(sig),
              })))
              .catch(reject)
            break
          }
          case 'registered': resolve(); break
          case 'message': {
            const w = this.messageWaiters.shift()
            if (w) w(msg.envelope); else this.messageBuffer.push(msg.envelope)
            break
          }
          case 'receipt': {
            // The CODE-only waiters (existing API) and the FULL-frame waiters (raw*)
            // are mutually exclusive per send, so dispatch to whichever is queued.
            this.outcomeWaiters.shift()?.(msg.receipt)
            this.rawOutcomeWaiters.shift()?.({ kind: 'receipt', receipt: msg.receipt })
            break
          }
          case 'error': {
            this.outcomeWaiters.shift()?.({ error: msg.code })
            this.rawOutcomeWaiters.shift()?.({
              kind: 'error',
              error: { code: msg.code, thid: msg.thid, message: msg.message },
            })
            break
          }
        }
      })
      ws.on('error', reject)
    })
  }

  /** Resolve with the NEXT full outcome frame (receipt or error incl. thid). */
  private nextRawOutcome(): Promise<RawOutcome> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout waiting for raw outcome')), 5000)
      this.rawOutcomeWaiters.push((o) => {
        clearTimeout(t)
        resolve(o)
      })
    })
  }

  private nextOutcome(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout waiting for outcome')), 3000)
      this.outcomeWaiters.push((o) => {
        clearTimeout(t)
        if ('error' in o) reject(new Error(String((o as { error: string }).error)))
        else resolve(o as Record<string, unknown>)
      })
    })
  }

  private rawSend(frame: Record<string, unknown>): void {
    this.ws!.send(JSON.stringify(frame))
  }

  async sendSpaceRegister(params: { spaceId: string; verificationKey: string; adminDids: string[] }): Promise<Record<string, unknown>> {
    const frame = await createSpaceRegisterMessageWithSigner({
      spaceId: params.spaceId,
      spaceCapabilityVerificationKey: params.verificationKey,
      adminDids: params.adminDids,
      kid: `${this.identity.getDid()}#sig-0`,
      sign: (b) => this.identity.signEd25519(b),
    })
    this.rawSend(frame as unknown as Record<string, unknown>)
    return this.nextOutcome()
  }

  async presentCapability(capabilityJws: string): Promise<Record<string, unknown>> {
    this.rawSend(createPresentCapabilityControlFrame({ capabilityJws }) as unknown as Record<string, unknown>)
    return this.nextOutcome()
  }

  /**
   * Slice SR (Criterion 2 setup): send a top-level control-frame (e.g. an admin
   * `space-rotate`) and resolve with the FULL outcome frame so a test can branch on
   * receipt vs. error without throwing. Used to drive the durable rotation that puts
   * the space at a higher generation than another socket's cached scope.
   */
  async sendControlFrameRaw(frame: Record<string, unknown>): Promise<RawOutcome> {
    this.rawSend(frame)
    return this.nextRawOutcome()
  }

  async sendLogEntry(params: { spaceId: string; seq: number; plaintext: string }): Promise<Record<string, unknown>> {
    const spaceContentKey = await helperCrypto.sha256(new TextEncoder().encode(`raw-sck|${params.spaceId}`))
    const enc = await encryptLogPayload({
      crypto: helperCrypto,
      spaceContentKey,
      deviceId: this.deviceId,
      seq: params.seq,
      plaintext: new TextEncoder().encode(params.plaintext),
    })
    const entryJws = await createLogEntryJwsWithSigner({
      payload: {
        seq: params.seq,
        deviceId: this.deviceId,
        docId: params.spaceId,
        authorKid: `${this.identity.getDid()}#sig-0`,
        keyGeneration: 0,
        data: enc.blobBase64Url,
        timestamp: new Date().toISOString(),
      },
      sign: (b) => this.identity.signEd25519(b),
    })
    const message = createLogEntryMessage({
      id: randomUUID(),
      from: this.identity.getDid(),
      to: [this.identity.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      entry: entryJws,
    })
    this.rawSend({ type: 'send', envelope: message as unknown as Record<string, unknown> })
    return this.nextOutcome()
  }

  /**
   * Send a sync-request and resolve with the NEXT inbound frame, whatever it is: a
   * `sync-response` MESSAGE (success) or an `error` (gate failure). Both waiters are
   * mutually-cancelling so the unfired one cannot leak into a later call.
   */
  private sendSyncRequestRaw(spaceId: string): Promise<{ message?: Record<string, unknown>; error?: string }> {
    const req = createSyncRequestMessage({
      id: randomUUID(),
      from: this.identity.getDid(),
      createdTime: Math.floor(Date.now() / 1000),
      body: { docId: spaceId, heads: {} },
    })
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout waiting for sync-request answer')), 3000)
      const outcome = (o: Record<string, unknown> | { error: string }) => {
        clearTimeout(t)
        const i = this.messageWaiters.indexOf(message)
        if (i >= 0) this.messageWaiters.splice(i, 1)
        resolve('error' in o ? { error: String((o as { error: string }).error) } : {})
      }
      const message = (env: Record<string, unknown>) => {
        clearTimeout(t)
        const i = this.outcomeWaiters.indexOf(outcome)
        if (i >= 0) this.outcomeWaiters.splice(i, 1)
        resolve({ message: env })
      }
      this.outcomeWaiters.push(outcome)
      this.messageWaiters.push(message)
      this.rawSend({ type: 'send', envelope: req as unknown as Record<string, unknown> })
    })
  }

  async sendSyncRequest(spaceId: string): Promise<Record<string, unknown>> {
    const r = await this.sendSyncRequestRaw(spaceId)
    if (r.error) throw new Error(r.error)
    return r.message!
  }

  async sendSyncRequestExpectResponse(spaceId: string): Promise<Record<string, unknown>> {
    const r = await this.sendSyncRequestRaw(spaceId)
    if (r.error) throw new Error(`sync-request rejected: ${r.error}`)
    return r.message!
  }

  // ── Slice SR raw senders (Criterion 2/3/4) ─────────────────────────────────

  /**
   * Slice SR Criterion 2/3: send a log-entry over the REAL socket but, unlike
   * {@link sendLogEntry}, (a) accept an explicit `keyGeneration` (default 0 — the
   * stale case under a rotated space; pass >= space.generation for the >=-acceptance
   * case) and (b) RETURN the transport envelope id alongside the FULL outcome frame,
   * so a test can assert `errorFrame.thid === sentMessageId` (the P4 relay change).
   */
  async sendLogEntryRaw(params: {
    spaceId: string
    seq: number
    plaintext: string
    keyGeneration?: number
  }): Promise<{ sentMessageId: string; outcome: RawOutcome }> {
    const spaceContentKey = await helperCrypto.sha256(new TextEncoder().encode(`raw-sck|${params.spaceId}`))
    const enc = await encryptLogPayload({
      crypto: helperCrypto,
      spaceContentKey,
      deviceId: this.deviceId,
      seq: params.seq,
      plaintext: new TextEncoder().encode(params.plaintext),
    })
    const entryJws = await createLogEntryJwsWithSigner({
      payload: {
        seq: params.seq,
        deviceId: this.deviceId,
        docId: params.spaceId,
        authorKid: `${this.identity.getDid()}#sig-0`,
        keyGeneration: params.keyGeneration ?? 0,
        data: enc.blobBase64Url,
        timestamp: new Date().toISOString(),
      },
      sign: (b) => this.identity.signEd25519(b),
    })
    const sentMessageId = randomUUID()
    const message = createLogEntryMessage({
      id: sentMessageId,
      from: this.identity.getDid(),
      to: [this.identity.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      entry: entryJws,
    })
    this.rawSend({ type: 'send', envelope: message as unknown as Record<string, unknown> })
    const outcome = await this.nextRawOutcome()
    return { sentMessageId, outcome }
  }

  /**
   * Slice SR Criterion 4b: a CLIENT-originated `sync-response/1.0` addressed to a
   * recipient. Only the broker may emit sync-response, so the relay-whitelist MUST
   * reject this MALFORMED_MESSAGE (relay.ts:1546) — it never reaches generic routing,
   * so `applySyncResponse` on the recipient is never invoked. Returns the outcome
   * frame (expected: error MALFORMED_MESSAGE, NO thid).
   */
  async sendForgedSyncResponse(params: { docId: string; recipientDid: string }): Promise<RawOutcome> {
    const forged = createSyncResponseMessage({
      id: randomUUID(),
      from: this.identity.getDid(),
      to: [params.recipientDid],
      createdTime: Math.floor(Date.now() / 1000),
      thid: randomUUID(),
      body: { docId: params.docId, entries: [], heads: {}, truncated: false },
    })
    this.rawSend({ type: 'send', envelope: forged as unknown as Record<string, unknown> })
    return this.nextRawOutcome()
  }

  /**
   * Slice SR Criterion 4a: the DEPRECATED old-world `content` MessageEnvelope
   * (`v:1`/`fromDid`/`toDid`, NO DIDComm `typ`) — exactly the un-gated pipe a removed
   * member could abuse to push old-content-key ciphertext live. The relay-whitelist
   * rejects it MALFORMED_MESSAGE on type and NEITHER relays NOR queues it. Returns
   * the outcome frame (expected: error MALFORMED_MESSAGE, NO thid).
   */
  async sendDeprecatedContentEnvelope(params: { recipientDid: string }): Promise<RawOutcome> {
    const oldWorld = {
      v: 1,
      id: randomUUID(),
      type: 'content',
      fromDid: this.identity.getDid(),
      toDid: params.recipientDid,
      createdAt: '2026-01-01T00:00:00.000Z',
      encoding: 'json',
      payload: '{}',
      signature: '',
    }
    this.rawSend({ type: 'send', envelope: oldWorld })
    return this.nextRawOutcome()
  }

  /**
   * Slice SR Criterion 4 (positive control): a whitelisted ECIES Inbox envelope
   * (space-invite/1.0 here) MUST stay queue/relay-eligible (cold-start not broken).
   * The body is opaque to the relay (it never decrypts), so a minimal shape suffices
   * to exercise routing/queueing. Returns the outcome frame (expected: receipt).
   */
  async sendInboxEnvelope(params: { recipientDid: string }): Promise<RawOutcome> {
    const envelope = {
      id: randomUUID(),
      typ: DIDCOMM_PLAINTEXT_TYP,
      type: 'https://web-of-trust.de/protocols/space-invite/1.0',
      from: this.identity.getDid(),
      to: [params.recipientDid],
      created_time: Math.floor(Date.now() / 1000),
      body: { opaque: 'ecies-ciphertext-placeholder' },
    }
    this.rawSend({ type: 'send', envelope })
    return this.nextRawOutcome()
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws) return resolve()
      this.ws.on('close', () => resolve())
      this.ws.close()
      this.ws = null
    })
  }
}
