import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryMessagingAdapter } from '../src/adapters/messaging/InMemoryMessagingAdapter'
import { InMemoryOutboxStore } from '../src/adapters/messaging/InMemoryOutboxStore'
import { OutboxMessagingAdapter } from '../src/adapters/messaging/OutboxMessagingAdapter'
import type { MessageEnvelope } from '../src/types/messaging'

const ALICE_DID = 'did:key:z6MkAlice1234567890abcdefghijklmnopqrstuvwxyz'
const BOB_DID = 'did:key:z6MkBob1234567890abcdefghijklmnopqrstuvwxyzab'

function createTestEnvelope(
  overrides: Partial<MessageEnvelope> = {},
): MessageEnvelope {
  return {
    v: 1,
    id: crypto.randomUUID(),
    type: 'verification',
    fromDid: ALICE_DID,
    toDid: BOB_DID,
    createdAt: new Date().toISOString(),
    encoding: 'json',
    payload: JSON.stringify({ test: true }),
    signature: 'test-sig',
    ...overrides,
  }
}

describe('OutboxMessagingAdapter', () => {
  let inner: InMemoryMessagingAdapter
  let bob: InMemoryMessagingAdapter
  let outbox: InMemoryOutboxStore
  let adapter: OutboxMessagingAdapter

  beforeEach(() => {
    InMemoryMessagingAdapter.resetAll()
    inner = new InMemoryMessagingAdapter()
    bob = new InMemoryMessagingAdapter()
    outbox = new InMemoryOutboxStore()
    adapter = new OutboxMessagingAdapter(inner, outbox, {
      skipTypes: ['profile-update'],
      sendTimeoutMs: 500, // short timeout for tests
    })
  })

  afterEach(() => {
    InMemoryMessagingAdapter.resetAll()
  })

  describe('send() when connected', () => {
    beforeEach(async () => {
      await adapter.connect(ALICE_DID)
      await bob.connect(BOB_DID)
    })

    it('should delegate to inner adapter and not enqueue', async () => {
      const envelope = createTestEnvelope()
      const receipt = await adapter.send(envelope)

      expect(receipt.status).toBe('accepted')
      expect(await outbox.count()).toBe(0)
    })

    it('should deliver message to recipient', async () => {
      const received: MessageEnvelope[] = []
      bob.onMessage((env) => received.push(env))

      await adapter.send(createTestEnvelope())

      expect(received).toHaveLength(1)
    })
  })

  describe('send() when disconnected', () => {
    it('should enqueue in outbox and return synthetic receipt', async () => {
      // Not connected — inner.send() would throw
      const envelope = createTestEnvelope()
      const receipt = await adapter.send(envelope)

      expect(receipt.status).toBe('accepted')
      expect(receipt.reason).toBe('queued-in-outbox')
      expect(await outbox.count()).toBe(1)
    })

    it('should not throw', async () => {
      const envelope = createTestEnvelope()
      await expect(adapter.send(envelope)).resolves.toBeDefined()
    })
  })

  describe('send() when inner throws', () => {
    it('should enqueue on send failure', async () => {
      await adapter.connect(ALICE_DID)
      // Bob is NOT connected — InMemory queues silently, so we need
      // to force an error. Disconnect inner after connect.
      await inner.disconnect()

      const envelope = createTestEnvelope()
      const receipt = await adapter.send(envelope)

      expect(receipt.reason).toBe('queued-in-outbox')
      expect(await outbox.count()).toBe(1)
    })
  })

  describe('dedup', () => {
    it('should not enqueue the same envelope.id twice', async () => {
      const envelope = createTestEnvelope()

      await adapter.send(envelope)
      await adapter.send(envelope)

      expect(await outbox.count()).toBe(1)
    })
  })

  describe('skipTypes', () => {
    it('should not enqueue profile-update messages', async () => {
      // Not connected
      const envelope = createTestEnvelope({ type: 'profile-update' })

      // profile-update bypasses outbox — should throw since we're disconnected
      await expect(adapter.send(envelope)).rejects.toThrow()
      expect(await outbox.count()).toBe(0)
    })

    it('should enqueue verification messages', async () => {
      const envelope = createTestEnvelope({ type: 'verification' })
      await adapter.send(envelope)
      expect(await outbox.count()).toBe(1)
    })

    it('should enqueue attestation messages', async () => {
      const envelope = createTestEnvelope({ type: 'attestation' })
      await adapter.send(envelope)
      expect(await outbox.count()).toBe(1)
    })
  })

  describe('flushOutbox()', () => {
    it('should send all pending messages on flush', async () => {
      // Queue two messages while disconnected
      const e1 = createTestEnvelope()
      const e2 = createTestEnvelope()
      await adapter.send(e1)
      await adapter.send(e2)
      expect(await outbox.count()).toBe(2)

      // Connect inner directly to avoid auto-flush from adapter.connect()
      await bob.connect(BOB_DID)
      await inner.connect(ALICE_DID)

      await adapter.flushOutbox()

      expect(await outbox.count()).toBe(0)
    })

    it('should deliver flushed messages to recipient', async () => {
      const received: MessageEnvelope[] = []
      bob.onMessage((env) => received.push(env))

      const envelope = createTestEnvelope()
      await adapter.send(envelope)

      // Connect inner directly to avoid auto-flush
      await bob.connect(BOB_DID)
      await inner.connect(ALICE_DID)

      await adapter.flushOutbox()

      expect(received).toHaveLength(1)
      expect(received[0].id).toBe(envelope.id)
    })

    it('should send in FIFO order', async () => {
      const received: MessageEnvelope[] = []
      bob.onMessage((env) => received.push(env))

      const e1 = createTestEnvelope({ id: 'first' })
      const e2 = createTestEnvelope({ id: 'second' })
      await adapter.send(e1)
      // Small delay to ensure different createdAt
      await new Promise(r => setTimeout(r, 5))
      await adapter.send(e2)

      // Connect inner directly to avoid auto-flush
      await bob.connect(BOB_DID)
      await inner.connect(ALICE_DID)

      await adapter.flushOutbox()

      expect(received[0].id).toBe('first')
      expect(received[1].id).toBe('second')
    })

    it('should increment retryCount on failed flush', async () => {
      const envelope = createTestEnvelope()
      await adapter.send(envelope)

      // Connect inner so flushOutbox doesn't break early
      await inner.connect(ALICE_DID)

      // Mock send to throw while still connected
      vi.spyOn(inner, 'send').mockRejectedValue(new Error('relay error'))

      await adapter.flushOutbox()

      const pending = await outbox.getPending()
      expect(pending).toHaveLength(1)
      expect(pending[0].retryCount).toBe(1)
    })

    it('should stop flushing if connection drops mid-flush', async () => {
      // Queue messages
      const e1 = createTestEnvelope()
      const e2 = createTestEnvelope()
      await adapter.send(e1)
      await adapter.send(e2)

      // Connect inner directly to avoid auto-flush
      await inner.connect(ALICE_DID)

      // Make inner disconnect after first send attempt
      const origSend = inner.send.bind(inner)
      let callCount = 0
      vi.spyOn(inner, 'send').mockImplementation(async (env) => {
        callCount++
        if (callCount === 1) {
          // First call succeeds
          return origSend(env)
        }
        // Then disconnect
        await inner.disconnect()
        throw new Error('disconnected')
      })

      await adapter.flushOutbox()

      // First message sent, second should still be in outbox
      expect(await outbox.count()).toBe(1)
    })

    it('should not flush concurrently (flushing guard)', async () => {
      const envelope = createTestEnvelope()
      await adapter.send(envelope)

      // Connect inner directly to avoid auto-flush from adapter.connect()
      await bob.connect(BOB_DID)
      await inner.connect(ALICE_DID)

      // Start two flushes simultaneously
      await Promise.all([
        adapter.flushOutbox(),
        adapter.flushOutbox(),
      ])

      // Should still work correctly (no duplicates)
      expect(await outbox.count()).toBe(0)
    })
  })

  describe('connect() triggers flush', () => {
    it('should flush outbox after successful connect', async () => {
      const received: MessageEnvelope[] = []
      bob.onMessage((env) => received.push(env))

      // Queue while disconnected
      await adapter.send(createTestEnvelope())

      await bob.connect(BOB_DID)
      await adapter.connect(ALICE_DID)

      // Give the fire-and-forget flush time to complete
      await new Promise(r => setTimeout(r, 50))

      expect(received).toHaveLength(1)
      expect(await outbox.count()).toBe(0)
    })
  })

  describe('getState()', () => {
    it('should reflect inner adapter state', async () => {
      expect(adapter.getState()).toBe('disconnected')

      await adapter.connect(ALICE_DID)
      expect(adapter.getState()).toBe('connected')

      await adapter.disconnect()
      expect(adapter.getState()).toBe('disconnected')
    })
  })

  describe('onMessage delegation', () => {
    it('should delegate onMessage to inner', async () => {
      await adapter.connect(ALICE_DID)
      await bob.connect(BOB_DID)

      const received: MessageEnvelope[] = []
      adapter.onMessage((env) => received.push(env))

      // Bob sends to Alice
      await bob.send(createTestEnvelope({ fromDid: BOB_DID, toDid: ALICE_DID }))

      expect(received).toHaveLength(1)
    })
  })
})
