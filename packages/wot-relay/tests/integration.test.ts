import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { DeliveryReceipt } from '@web_of_trust/core/types'
import { createResourceRef } from '@web_of_trust/core/types'
import { protocol } from '@web_of_trust/core'

// End-to-end test of the relay's generic delivery mechanics (routing, offline
// queue, receipts, multi-recipient) driven by a thin transport client over a real
// WebSocket. The vehicle is a whitelisted DIDComm Inbox envelope (inbox/1.0):
// after the Sync 003 relay-whitelist (VE-R2) the deprecated old-world
// content/v:1/fromDid MessageEnvelope is rejected at the relay, so these tests
// carry the same delivery assertions over a relay-eligible transport type. The
// relay routes by to[0] and is opaque to the ECIES body.
type TransportEnvelope = Record<string, unknown>
const INBOX_TYPE = 'https://web-of-trust.de/protocols/inbox/1.0'

const PORT = 9878
const RELAY_URL = `ws://localhost:${PORT}`

const {
  encodeBase58,
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
  formatBrokerChallengeResponseSignature,
} = protocol

interface TestIdentity {
  did: string
  deviceId: string
  signTranscriptBytes: (bytes: Uint8Array) => Promise<Uint8Array>
}

async function generateIdentity(): Promise<TestIdentity> {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  const prefixed = new Uint8Array(2 + publicKeyBytes.length)
  prefixed[0] = 0xed
  prefixed[1] = 0x01
  prefixed.set(publicKeyBytes, 2)
  const did = 'did:key:z' + encodeBase58(prefixed)

  return {
    did,
    deviceId: randomUUID(),
    signTranscriptBytes: async (bytes) => {
      const sig = await crypto.subtle.sign('Ed25519', keyPair.privateKey, bytes)
      return new Uint8Array(sig)
    },
  }
}

// --- Node WebSocket Adapter with Sync 003 broker-auth transcript signing ---

class NodeWebSocketAdapter {
  private ws: WebSocket | null = null
  private myDid: string | null = null
  private state: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  private messageCallbacks = new Set<(envelope: TransportEnvelope) => void>()
  private receiptCallbacks = new Set<(receipt: DeliveryReceipt) => void>()
  private pendingReceipts = new Map<string, (receipt: DeliveryReceipt) => void>()

  constructor(
    private relayUrl: string,
    private identity: TestIdentity,
  ) {}

  async connect(myDid: string): Promise<void> {
    this.myDid = myDid
    this.state = 'connecting'

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.relayUrl)

      this.ws.on('open', () => {
        this.ws!.send(JSON.stringify({ type: 'register', did: myDid, deviceId: this.identity.deviceId }))
      })

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())

        switch (msg.type) {
          case 'challenge': {
            const transcript = buildBrokerAuthTranscript({
              did: myDid,
              deviceId: this.identity.deviceId,
              nonce: msg.nonce,
            })
            const signingBytes = createBrokerAuthTranscriptSigningBytes(transcript)
            this.identity.signTranscriptBytes(signingBytes)
              .then((sigBytes) => {
                const signature = formatBrokerChallengeResponseSignature(sigBytes)
                this.ws?.send(
                  JSON.stringify({
                    type: 'challenge-response',
                    did: myDid,
                    deviceId: this.identity.deviceId,
                    nonce: msg.nonce,
                    signature,
                  }),
                )
              })
              .catch((err) => {
                this.state = 'error'
                reject(err)
              })
            break
          }
          case 'registered':
            this.state = 'connected'
            resolve()
            break
          case 'message':
            for (const cb of this.messageCallbacks) {
              cb(msg.envelope as TransportEnvelope)
            }
            break
          case 'receipt': {
            const receipt = msg.receipt as DeliveryReceipt
            const pending = this.pendingReceipts.get(receipt.messageId)
            if (pending) {
              this.pendingReceipts.delete(receipt.messageId)
              pending(receipt)
            }
            for (const cb of this.receiptCallbacks) {
              cb(receipt)
            }
            break
          }
          case 'error':
            if (this.state === 'connecting') {
              this.state = 'error'
              reject(new Error(msg.message))
            }
            break
        }
      })

      this.ws.on('error', () => {
        if (this.state === 'connecting') {
          this.state = 'error'
          reject(new Error('Connection failed'))
        }
      })

      this.ws.on('close', () => {
        this.state = 'disconnected'
      })
    })
  }

  async disconnect(): Promise<void> {
    this.ws?.close()
    this.ws = null
    this.myDid = null
    this.state = 'disconnected'
  }

  getState() { return this.state }

  async send(envelope: TransportEnvelope): Promise<DeliveryReceipt> {
    if (this.state !== 'connected' || !this.ws) throw new Error('Must connect first')
    return new Promise((resolve) => {
      this.pendingReceipts.set(envelope.id as string, resolve)
      this.ws!.send(JSON.stringify({ type: 'send', envelope }))
    })
  }

  onMessage(callback: (envelope: TransportEnvelope) => void): () => void {
    this.messageCallbacks.add(callback)
    return () => { this.messageCallbacks.delete(callback) }
  }

  onStateChange(_callback: (state: any) => void): () => void { return () => {} }

  onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void {
    this.receiptCallbacks.add(callback)
    return () => { this.receiptCallbacks.delete(callback) }
  }

  async registerTransport(): Promise<void> {}
  async resolveTransport(): Promise<string | null> { return null }
}

// --- Helpers ---

function createTestEnvelope(
  fromDid: string,
  toDid: string,
  overrides: Partial<TransportEnvelope> = {},
): TransportEnvelope {
  return {
    id: randomUUID(),
    typ: 'application/didcomm-plain+json',
    type: INBOX_TYPE,
    from: fromDid,
    to: [toDid],
    created_time: Math.floor(Date.now() / 1000),
    body: { epk: 'ZXBr', nonce: 'bm9uY2U', ciphertext: 'Y2lwaGVydGV4dA' },
    ...overrides,
  }
}

// --- Tests ---

describe('Integration: MessagingAdapter over WebSocket Relay', () => {
  let server: RelayServer
  let aliceId: TestIdentity
  let bobId: TestIdentity
  let alice: NodeWebSocketAdapter
  let bob: NodeWebSocketAdapter

  beforeEach(async () => {
    server = new RelayServer({ port: PORT })
    await server.start()
    aliceId = await generateIdentity()
    bobId = await generateIdentity()
    alice = new NodeWebSocketAdapter(RELAY_URL, aliceId)
    bob = new NodeWebSocketAdapter(RELAY_URL, bobId)
  })

  afterEach(async () => {
    await alice.disconnect()
    await bob.disconnect()
    await server.stop()
  })

  it('should send attestation from Alice to Bob', async () => {
    await alice.connect(aliceId.did)
    await bob.connect(bobId.did)

    const received: TransportEnvelope[] = []
    bob.onMessage((env) => received.push(env))

    const envelope = createTestEnvelope(aliceId.did, bobId.did)
    const receipt = await alice.send(envelope)

    expect(receipt.status).toBe('delivered')
    expect(receipt.messageId).toBe(envelope.id)

    await new Promise((r) => setTimeout(r, 50))

    expect(received).toHaveLength(1)
    expect(received[0].from).toBe(aliceId.did)
    expect(received[0].type).toBe(INBOX_TYPE)
    expect(received[0].body).toEqual(envelope.body)
  })

  it('should relay every whitelisted inbox transport type', async () => {
    // Post-VE-R2 the relay carries the defined Inbox transport types (Sync 003
    // Nachrichtentypen-Tabelle). The old-world content types (attestation, content,
    // …) are no longer relay-eligible; their delivery moves to inbox/1.0 bodies.
    await alice.connect(aliceId.did)
    await bob.connect(bobId.did)

    const received: TransportEnvelope[] = []
    bob.onMessage((env) => received.push(env))

    const types = [
      'https://web-of-trust.de/protocols/inbox/1.0',
      'https://web-of-trust.de/protocols/space-invite/1.0',
      'https://web-of-trust.de/protocols/member-update/1.0',
      'https://web-of-trust.de/protocols/key-rotation/1.0',
    ] as const

    for (const type of types) {
      await alice.send(createTestEnvelope(aliceId.did, bobId.did, { type }))
    }

    await new Promise((r) => setTimeout(r, 50))

    expect(received).toHaveLength(types.length)
    expect(received.map((e) => e.type)).toEqual([...types])
  })

  it('should include ResourceRef in envelope', async () => {
    await alice.connect(aliceId.did)
    await bob.connect(bobId.did)

    const received: TransportEnvelope[] = []
    bob.onMessage((env) => received.push(env))

    const ref = createResourceRef('attestation', 'att-999')
    await alice.send(createTestEnvelope(aliceId.did, bobId.did, { ref }))

    await new Promise((r) => setTimeout(r, 50))

    expect(received[0].ref).toBe('wot:attestation:att-999')
  })

  it('should deliver offline-queued messages', async () => {
    await alice.connect(aliceId.did)

    const envelope = createTestEnvelope(aliceId.did, bobId.did)
    const receipt = await alice.send(envelope)
    expect(receipt.status).toBe('accepted')

    const received: TransportEnvelope[] = []
    bob.onMessage((env) => received.push(env))
    await bob.connect(bobId.did)

    await new Promise((r) => setTimeout(r, 50))

    expect(received).toHaveLength(1)
    expect(received[0].id).toBe(envelope.id)
  })

  it('should notify sender via onReceipt callback', async () => {
    await alice.connect(aliceId.did)
    await bob.connect(bobId.did)

    const receipts: DeliveryReceipt[] = []
    alice.onReceipt((r) => receipts.push(r))

    const envelope = createTestEnvelope(aliceId.did, bobId.did)
    await alice.send(envelope)

    expect(receipts.some((r) => r.status === 'delivered')).toBe(true)
  })

  it('should handle bidirectional messaging', async () => {
    await alice.connect(aliceId.did)
    await bob.connect(bobId.did)

    const aliceReceived: TransportEnvelope[] = []
    const bobReceived: TransportEnvelope[] = []
    alice.onMessage((env) => aliceReceived.push(env))
    bob.onMessage((env) => bobReceived.push(env))

    await alice.send(createTestEnvelope(aliceId.did, bobId.did))
    await bob.send(createTestEnvelope(bobId.did, aliceId.did))

    await new Promise((r) => setTimeout(r, 50))

    expect(bobReceived).toHaveLength(1)
    expect(aliceReceived).toHaveLength(1)
    expect(bobReceived[0].from).toBe(aliceId.did)
    expect(aliceReceived[0].from).toBe(bobId.did)
  })
})
