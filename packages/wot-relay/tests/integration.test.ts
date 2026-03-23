import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { MessageEnvelope, DeliveryReceipt, MessagingAdapter } from '@real-life/wot-core'
import { createResourceRef } from '@real-life/wot-core'

const PORT = 9878
const RELAY_URL = `ws://localhost:${PORT}`

// --- Ed25519 key generation ---

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58(bytes: Uint8Array): string {
  let num = BigInt(0)
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte)
  }
  let str = ''
  while (num > 0) {
    const mod = Number(num % BigInt(58))
    str = BASE58_ALPHABET[mod] + str
    num = num / BigInt(58)
  }
  for (const byte of bytes) {
    if (byte === 0) str = '1' + str
    else break
  }
  return str
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

interface TestIdentity {
  did: string
  sign: (data: string) => Promise<string>
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
    sign: async (data: string) => {
      const sig = await crypto.subtle.sign('Ed25519', keyPair.privateKey, new TextEncoder().encode(data))
      return encodeBase64Url(new Uint8Array(sig))
    },
  }
}

// --- Node WebSocket Adapter with challenge-response ---

class NodeWebSocketAdapter implements MessagingAdapter {
  private ws: WebSocket | null = null
  private myDid: string | null = null
  private state: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  private messageCallbacks = new Set<(envelope: MessageEnvelope) => void>()
  private receiptCallbacks = new Set<(receipt: DeliveryReceipt) => void>()
  private pendingReceipts = new Map<string, (receipt: DeliveryReceipt) => void>()
  private signFn: ((data: string) => Promise<string>) | null

  constructor(private relayUrl: string, signFn?: (data: string) => Promise<string>) {
    this.signFn = signFn ?? null
  }

  async connect(myDid: string): Promise<void> {
    this.myDid = myDid
    this.state = 'connecting'

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.relayUrl)

      this.ws.on('open', () => {
        this.ws!.send(JSON.stringify({ type: 'register', did: myDid }))
      })

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())

        switch (msg.type) {
          case 'challenge':
            if (this.signFn) {
              this.signFn(msg.nonce).then((signature) => {
                this.ws?.send(JSON.stringify({
                  type: 'challenge-response',
                  did: myDid,
                  nonce: msg.nonce,
                  signature,
                }))
              }).catch((err) => {
                this.state = 'error'
                reject(err)
              })
            } else {
              this.state = 'error'
              reject(new Error('Challenge received but no sign function provided'))
            }
            break
          case 'registered':
            this.state = 'connected'
            resolve()
            break
          case 'message':
            for (const cb of this.messageCallbacks) {
              cb(msg.envelope as MessageEnvelope)
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

  async send(envelope: MessageEnvelope): Promise<DeliveryReceipt> {
    if (this.state !== 'connected' || !this.ws) throw new Error('Must connect first')
    return new Promise((resolve) => {
      this.pendingReceipts.set(envelope.id, resolve)
      this.ws!.send(JSON.stringify({ type: 'send', envelope }))
    })
  }

  onMessage(callback: (envelope: MessageEnvelope) => void): () => void {
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
  overrides: Partial<MessageEnvelope> = {},
): MessageEnvelope {
  return {
    v: 1,
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'attestation',
    fromDid,
    toDid,
    createdAt: new Date().toISOString(),
    encoding: 'json',
    payload: JSON.stringify({ claim: 'test-claim' }),
    signature: 'test-signature-base64',
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
    alice = new NodeWebSocketAdapter(RELAY_URL, aliceId.sign)
    bob = new NodeWebSocketAdapter(RELAY_URL, bobId.sign)
  })

  afterEach(async () => {
    await alice.disconnect()
    await bob.disconnect()
    await server.stop()
  })

  it('should send attestation from Alice to Bob', async () => {
    await alice.connect(aliceId.did)
    await bob.connect(bobId.did)

    const received: MessageEnvelope[] = []
    bob.onMessage((env) => received.push(env))

    const envelope = createTestEnvelope(aliceId.did, bobId.did)
    const receipt = await alice.send(envelope)

    expect(receipt.status).toBe('delivered')
    expect(receipt.messageId).toBe(envelope.id)

    await new Promise((r) => setTimeout(r, 50))

    expect(received).toHaveLength(1)
    expect(received[0].fromDid).toBe(aliceId.did)
    expect(received[0].type).toBe('attestation')
    expect(received[0].payload).toBe(envelope.payload)
  })

  it('should send all message types', async () => {
    await alice.connect(aliceId.did)
    await bob.connect(bobId.did)

    const received: MessageEnvelope[] = []
    bob.onMessage((env) => received.push(env))

    const types = [
      'verification', 'attestation', 'contact-request', 'item-key',
      'space-invite', 'group-key-rotation', 'ack', 'content',
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

    const received: MessageEnvelope[] = []
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

    const received: MessageEnvelope[] = []
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

    const aliceReceived: MessageEnvelope[] = []
    const bobReceived: MessageEnvelope[] = []
    alice.onMessage((env) => aliceReceived.push(env))
    bob.onMessage((env) => bobReceived.push(env))

    await alice.send(createTestEnvelope(aliceId.did, bobId.did))
    await bob.send(createTestEnvelope(bobId.did, aliceId.did))

    await new Promise((r) => setTimeout(r, 50))

    expect(bobReceived).toHaveLength(1)
    expect(aliceReceived).toHaveLength(1)
    expect(bobReceived[0].fromDid).toBe(aliceId.did)
    expect(aliceReceived[0].fromDid).toBe(bobId.did)
  })
})
