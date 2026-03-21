import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryMessagingAdapter } from '../src/adapters/messaging/InMemoryMessagingAdapter'
import { createResourceRef } from '../src/types/resource-ref'
import type { MessageEnvelope } from '../src/types/messaging'

const ALICE_DID = 'did:key:z6MkAlice1234567890abcdefghijklmnopqrstuvwxyz'
const BOB_DID = 'did:key:z6MkBob1234567890abcdefghijklmnopqrstuvwxyzab'

function createTestEnvelope(
  overrides: Partial<MessageEnvelope> = {},
): MessageEnvelope {
  return {
    v: 1,
    id: crypto.randomUUID(),
    type: 'attestation',
    fromDid: ALICE_DID,
    toDid: BOB_DID,
    createdAt: new Date().toISOString(),
    encoding: 'json',
    payload: JSON.stringify({ claim: 'test' }),
    signature: 'test-signature-base64',
    ...overrides,
  }
}

describe('InMemoryMessagingAdapter', () => {
  let alice: InMemoryMessagingAdapter
  let bob: InMemoryMessagingAdapter

  beforeEach(() => {
    InMemoryMessagingAdapter.resetAll()
    alice = new InMemoryMessagingAdapter()
    bob = new InMemoryMessagingAdapter()
  })

  afterEach(() => {
    InMemoryMessagingAdapter.resetAll()
  })

  describe('connection lifecycle', () => {
    it('should start in disconnected state', () => {
      expect(alice.getState()).toBe('disconnected')
    })

    it('should transition to connected after connect()', async () => {
      await alice.connect(ALICE_DID)
      expect(alice.getState()).toBe('connected')
    })

    it('should transition to disconnected after disconnect()', async () => {
      await alice.connect(ALICE_DID)
      await alice.disconnect()
      expect(alice.getState()).toBe('disconnected')
    })

    it('should throw when sending without connect', async () => {
      const envelope = createTestEnvelope()
      await expect(alice.send(envelope)).rejects.toThrow()
    })
  })

  describe('send and receive', () => {
    beforeEach(async () => {
      await alice.connect(ALICE_DID)
      await bob.connect(BOB_DID)
    })

    it('should deliver message from Alice to Bob', async () => {
      const received: MessageEnvelope[] = []
      bob.onMessage((env) => received.push(env))

      const envelope = createTestEnvelope()
      await alice.send(envelope)

      expect(received).toHaveLength(1)
      expect(received[0].fromDid).toBe(ALICE_DID)
      expect(received[0].toDid).toBe(BOB_DID)
      expect(received[0].type).toBe('attestation')
    })

    it('should return accepted receipt on send', async () => {
      const envelope = createTestEnvelope()
      const receipt = await alice.send(envelope)

      expect(receipt.messageId).toBe(envelope.id)
      expect(receipt.status).toBe('accepted')
      expect(receipt.timestamp).toBeDefined()
    })

    it('should deliver all message types', async () => {
      const types = [
        'verification',
        'attestation',
        'contact-request',
        'item-key',
        'space-invite',
        'group-key-rotation',
        'attestation-ack',
        'ack',
        'content',
      ] as const

      const received: MessageEnvelope[] = []
      bob.onMessage((env) => received.push(env))

      for (const type of types) {
        await alice.send(createTestEnvelope({ type }))
      }

      expect(received).toHaveLength(types.length)
      expect(received.map((e) => e.type)).toEqual(types)
    })

    it('should include ResourceRef when provided', async () => {
      const received: MessageEnvelope[] = []
      bob.onMessage((env) => received.push(env))

      const ref = createResourceRef('attestation', 'att-123')
      await alice.send(createTestEnvelope({ ref }))

      expect(received[0].ref).toBe('wot:attestation:att-123')
    })
  })

  describe('onMessage unsubscribe', () => {
    beforeEach(async () => {
      await alice.connect(ALICE_DID)
      await bob.connect(BOB_DID)
    })

    it('should stop receiving after unsubscribe', async () => {
      const received: MessageEnvelope[] = []
      const unsubscribe = bob.onMessage((env) => received.push(env))

      await alice.send(createTestEnvelope())
      expect(received).toHaveLength(1)

      unsubscribe()

      await alice.send(createTestEnvelope())
      expect(received).toHaveLength(1) // No new messages
    })
  })

  describe('offline queuing', () => {
    it('should queue messages for offline recipients and deliver on connect', async () => {
      await alice.connect(ALICE_DID)
      // Bob is NOT connected yet

      const envelope = createTestEnvelope()
      const receipt = await alice.send(envelope)
      expect(receipt.status).toBe('accepted') // Relay accepted it

      // Now Bob connects
      const received: MessageEnvelope[] = []
      bob.onMessage((env) => received.push(env))
      await bob.connect(BOB_DID)

      expect(received).toHaveLength(1)
      expect(received[0].id).toBe(envelope.id)
    })
  })

  describe('receipt callbacks', () => {
    beforeEach(async () => {
      await alice.connect(ALICE_DID)
      await bob.connect(BOB_DID)
    })

    it('should notify sender of delivered receipt when recipient is online', async () => {
      const receipts: Array<{ messageId: string; status: string }> = []
      alice.onReceipt((r) => receipts.push(r))

      await alice.send(createTestEnvelope())

      // InMemory delivers synchronously, so we should get a delivered receipt
      expect(receipts.some((r) => r.status === 'delivered')).toBe(true)
    })
  })

  describe('transport resolution', () => {
    it('should register and resolve transport address', async () => {
      await alice.connect(ALICE_DID)

      await alice.registerTransport(BOB_DID, 'ws://relay.example.com/bob')
      const address = await alice.resolveTransport(BOB_DID)

      expect(address).toBe('ws://relay.example.com/bob')
    })

    it('should return null for unknown DID', async () => {
      await alice.connect(ALICE_DID)
      const address = await alice.resolveTransport('did:key:z6MkUnknown')
      expect(address).toBeNull()
    })
  })

  describe('async message callbacks', () => {
    beforeEach(async () => {
      await alice.connect(ALICE_DID)
      await bob.connect(BOB_DID)
    })

    it('should await async onMessage callback before considering message processed', async () => {
      const order: string[] = []

      bob.onMessage(async () => {
        await new Promise((r) => setTimeout(r, 50))
        order.push('async-done')
      })

      await alice.send(createTestEnvelope())

      // Give delivery a tick to complete
      await new Promise((r) => setTimeout(r, 100))

      expect(order).toContain('async-done')
    })

    it('should handle mixed sync and async callbacks', async () => {
      const order: string[] = []

      bob.onMessage(() => {
        order.push('sync')
      })
      bob.onMessage(async () => {
        await new Promise((r) => setTimeout(r, 30))
        order.push('async')
      })

      await alice.send(createTestEnvelope())
      await new Promise((r) => setTimeout(r, 80))

      expect(order).toContain('sync')
      expect(order).toContain('async')
    })

    it('should catch errors in async callbacks without breaking', async () => {
      const received: MessageEnvelope[] = []

      bob.onMessage(async () => {
        throw new Error('async callback error')
      })
      bob.onMessage((env) => {
        received.push(env)
      })

      await alice.send(createTestEnvelope())
      await new Promise((r) => setTimeout(r, 50))

      expect(received).toHaveLength(1)
    })
  })

  describe('resetAll', () => {
    it('should clear all state for test isolation', async () => {
      await alice.connect(ALICE_DID)
      await alice.registerTransport(BOB_DID, 'ws://example.com')

      InMemoryMessagingAdapter.resetAll()

      expect(alice.getState()).toBe('disconnected')
      const address = await alice.resolveTransport(BOB_DID)
      expect(address).toBeNull()
    })
  })
})
