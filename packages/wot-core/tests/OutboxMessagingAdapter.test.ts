import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryMessagingAdapter } from '../src/adapters/messaging/InMemoryMessagingAdapter'
import { InMemoryOutboxStore } from '../src/adapters/messaging/InMemoryOutboxStore'
import { OutboxMessagingAdapter } from '../src/adapters/messaging/OutboxMessagingAdapter'
import type { MessagingAdapter, WireMessage } from '../src/ports/MessagingAdapter'
import { INBOX_MESSAGE_TYPE } from '../src/protocol/messaging/inbox-message'
import { SPACE_INVITE_MESSAGE_TYPE } from '../src/protocol/sync/membership-messages'
import { createDidcommTestMessage } from './helpers/didcomm-wire'
import { getTraceLog } from '../src/storage/TraceLog'

const ALICE_DID = 'did:key:z6MkAlice1234567890abcdefghijklmnopqrstuvwxyz'
const BOB_DID = 'did:key:z6MkBob1234567890abcdefghijklmnopqrstuvwxyzab'
const SKIPPED_TYPE = 'https://web-of-trust.de/protocols/test-skipped/1.0'

/** A relay-eligible wire message: encrypted DIDComm inbox envelope (Sync 003 whitelist, wot#386). */
function createTestEnvelope(overrides: { id?: string; from?: string; to?: string } = {}): WireMessage {
  return createDidcommTestMessage({
    id: overrides.id,
    from: overrides.from ?? ALICE_DID,
    to: [overrides.to ?? BOB_DID],
  })
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
      skipTypes: [SKIPPED_TYPE],
      sendTimeoutMs: 500, // short timeout for tests
    })
  })

  afterEach(() => {
    InMemoryMessagingAdapter.resetAll()
  })

  describe('sendControlFrame passthrough (Durable Wiring / VE-DW8)', () => {
    it('exposes sendControlFrame ONLY when the inner transport supports it (L1 gate feature-detect)', () => {
      // inner = InMemoryMessagingAdapter HAS sendControlFrame → the wrapper forwards it.
      expect(typeof adapter.sendControlFrame).toBe('function')

      // An inner transport WITHOUT sendControlFrame → the wrapper does NOT expose it,
      // so the log-sync L1 gate stays false for a control-frame-incapable transport.
      const bareInner: MessagingAdapter = {
        connect: async () => {},
        disconnect: async () => {},
        getState: () => 'connected',
        onStateChange: () => () => {},
        send: async (e) => ({ messageId: e.id, status: 'accepted', timestamp: '' }),
        onMessage: () => () => {},
        onReceipt: () => () => {},
        registerTransport: async () => {},
        resolveTransport: async () => null,
      }
      const bareWrapped = new OutboxMessagingAdapter(bareInner, new InMemoryOutboxStore())
      expect(bareWrapped.sendControlFrame).toBeUndefined()
    })

    it('delegates a control frame straight to the inner transport, BYPASSING the outbox', async () => {
      await adapter.connect(ALICE_DID)
      const receipt = { messageId: 'space-1', status: 'delivered' as const, timestamp: 'now' }
      const spy = vi.fn(async () => receipt)
      ;(inner as unknown as { sendControlFrame: typeof spy }).sendControlFrame = spy

      const frame = { type: 'present-capability' }
      const result = await adapter.sendControlFrame!(frame)

      expect(spy).toHaveBeenCalledWith(frame)
      expect(result).toBe(receipt)
      expect(await outbox.count()).toBe(0) // control frames are NOT outbox-queued
    })
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
      const received: WireMessage[] = []
      bob.onMessage((env) => { received.push(env) })

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
    it('does not enqueue a skipped type — it is sent directly (throws while disconnected)', async () => {
      const envelope = createDidcommTestMessage({ from: ALICE_DID, to: [BOB_DID], type: SKIPPED_TYPE })
      await expect(adapter.send(envelope)).rejects.toThrow()
      expect(await outbox.count()).toBe(0)
    })

    it('enqueues every other type', async () => {
      await adapter.send(createTestEnvelope())
      expect(await outbox.count()).toBe(1)
    })

    it('skips nothing by default', async () => {
      const defaults = new OutboxMessagingAdapter(inner, outbox, { sendTimeoutMs: 500 })
      await defaults.send(createDidcommTestMessage({ from: ALICE_DID, to: [BOB_DID], type: SKIPPED_TYPE }))
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
      const received: WireMessage[] = []
      bob.onMessage((env) => { received.push(env) })

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
      const received: WireMessage[] = []
      bob.onMessage((env) => { received.push(env) })

      const e1 = createTestEnvelope()
      const e2 = createTestEnvelope()
      await adapter.send(e1)
      // Small delay to ensure different createdAt
      await new Promise(r => setTimeout(r, 5))
      await adapter.send(e2)

      // Connect inner directly to avoid auto-flush
      await bob.connect(BOB_DID)
      await inner.connect(ALICE_DID)

      await adapter.flushOutbox()

      expect(received[0].id).toBe(e1.id)
      expect(received[1].id).toBe(e2.id)
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

    // wot#381 (5): a message given up after maxRetries used to vanish with a
    // console.warn only — the sender kept believing it was on its way. The drop
    // must land in the trace as a failure naming type, recipient and retries.
    it('traces a message it gives up on after maxRetries as a failed outbox delete', async () => {
      getTraceLog().clear()
      const limited = new OutboxMessagingAdapter(inner, outbox, { sendTimeoutMs: 500, maxRetries: 2 })
      const envelope = createDidcommTestMessage({ from: ALICE_DID, to: [BOB_DID], type: SPACE_INVITE_MESSAGE_TYPE })
      await limited.send(envelope)
      await inner.connect(ALICE_DID)
      await outbox.incrementRetry(envelope.id)
      await outbox.incrementRetry(envelope.id)

      await limited.flushOutbox()

      expect(await outbox.getPending()).toHaveLength(0)
      const drop = getTraceLog().getAll({ store: 'outbox', operation: 'delete' }).at(-1)
      expect(drop?.success).toBe(false)
      expect(drop?.error).toBe('max-retries-exceeded')
      expect(drop?.label).toBe(`drop ${SPACE_INVITE_MESSAGE_TYPE} → ${BOB_DID.slice(0, 24)}… after 2 retries`)
      expect(drop?.meta).toMatchObject({ id: envelope.id, type: SPACE_INVITE_MESSAGE_TYPE, retryCount: 2, maxRetries: 2 })
      getTraceLog().clear()
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
      const received: WireMessage[] = []
      bob.onMessage((env) => { received.push(env) })

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

  // VE-8: die Outbox behandelt beide Wire-Familien gleich — DIDComm-Envelopes
  // werden opak gequeued, geflusht und über to[0] geroutet.
  describe('DIDComm-Familie (VE-8)', () => {
    it('PFLICHT (c): nimmt die DIDComm-Form an, queued sie offline und stellt sie per flush zu', async () => {
      const message = createDidcommTestMessage({ from: ALICE_DID, to: [BOB_DID] })

      // Disconnected — Outbox übernimmt
      const receipt = await adapter.send(message)
      expect(receipt.status).toBe('accepted')
      expect(receipt.reason).toBe('queued-in-outbox')
      expect(await outbox.count()).toBe(1)

      const received: WireMessage[] = []
      bob.onMessage((env) => { received.push(env) })
      await bob.connect(BOB_DID)
      await inner.connect(ALICE_DID)

      await adapter.flushOutbox()

      expect(await outbox.count()).toBe(0)
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        id: message.id,
        typ: 'application/didcomm-plain+json',
        type: INBOX_MESSAGE_TYPE,
        to: [BOB_DID],
      })
    })

    it('stellt die DIDComm-Form direkt zu, wenn verbunden (Routing über to[0])', async () => {
      await adapter.connect(ALICE_DID)
      await bob.connect(BOB_DID)

      const received: WireMessage[] = []
      bob.onMessage((env) => { received.push(env) })

      const receipt = await adapter.send(createDidcommTestMessage({ from: ALICE_DID, to: [BOB_DID] }))

      expect(receipt.status).toBe('accepted')
      expect(received).toHaveLength(1)
      expect(await outbox.count()).toBe(0)
    })

    it('skipTypes greift auch für Type-URIs (beide Familien teilen das type-Feld)', async () => {
      const skipping = new OutboxMessagingAdapter(inner, outbox, {
        skipTypes: [INBOX_MESSAGE_TYPE],
        sendTimeoutMs: 500,
      })

      // Disconnected: Skip-Typ umgeht die Outbox → inner.send wirft, nichts gequeued
      await expect(skipping.send(createDidcommTestMessage({ from: ALICE_DID, to: [BOB_DID] }))).rejects.toThrow()
      expect(await outbox.count()).toBe(0)
    })
  })

  describe('onMessage delegation', () => {
    it('should delegate onMessage to inner', async () => {
      await adapter.connect(ALICE_DID)
      await bob.connect(BOB_DID)

      const received: WireMessage[] = []
      adapter.onMessage((env) => { received.push(env) })

      // Bob sends to Alice
      await bob.send(createTestEnvelope({ from: BOB_DID, to: ALICE_DID }))

      expect(received).toHaveLength(1)
    })
  })
})
