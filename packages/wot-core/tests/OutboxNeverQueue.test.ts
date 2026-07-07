import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryMessagingAdapter } from '../src/adapters/messaging/InMemoryMessagingAdapter'
import { InMemoryOutboxStore } from '../src/adapters/messaging/InMemoryOutboxStore'
import { OutboxMessagingAdapter } from '../src/adapters/messaging/OutboxMessagingAdapter'
import type { MessageEnvelope } from '../src/types/messaging'
import { SPACE_SYNC_REQUEST_MESSAGE_TYPE } from '../src/types/messaging'
import { LOG_ENTRY_MESSAGE_TYPE } from '../src/protocol/sync/log-entry'
import { SYNC_REQUEST_MESSAGE_TYPE } from '../src/protocol/sync/sync-messages'
import { INBOX_MESSAGE_TYPE } from '../src/protocol/messaging/inbox-message'
import { createDidcommTestMessage } from './helpers/didcomm-wire'

const ALICE_DID = 'did:key:z6MkAlice1234567890abcdefghijklmnopqrstuvwxyz'
const BOB_DID = 'did:key:z6MkBob1234567890abcdefghijklmnopqrstuvwxyzab'

/**
 * #236 (I-AUTH / I-NQ): log-sync envelope types are NEVER outbox-queued — their
 * retry authority is the LogSyncCoordinator / requestSync path. They leave the
 * outbox only via dequeue (lazy drain), never via send.
 */
describe('OutboxMessagingAdapter NEVER_QUEUE (#236)', () => {
  let inner: InMemoryMessagingAdapter
  let outbox: InMemoryOutboxStore
  let adapter: OutboxMessagingAdapter

  function oldWorldEnvelope(type: MessageEnvelope['type']): MessageEnvelope {
    return {
      v: 1,
      id: crypto.randomUUID(),
      type,
      fromDid: ALICE_DID,
      toDid: BOB_DID,
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: JSON.stringify({ test: true }),
      signature: 'test-sig',
    }
  }

  beforeEach(() => {
    InMemoryMessagingAdapter.resetAll()
    inner = new InMemoryMessagingAdapter()
    outbox = new InMemoryOutboxStore()
    adapter = new OutboxMessagingAdapter(inner, outbox, {
      skipTypes: ['profile-update'],
      sendTimeoutMs: 500,
    })
  })

  afterEach(() => {
    InMemoryMessagingAdapter.resetAll()
    vi.restoreAllMocks()
  })

  it('TC-T1: log-entry/1.0 on a disconnected transport THROWS and nothing lands in the outbox', async () => {
    // NOT connected — the pre-#236 behaviour was: enqueue + synthetic accepted receipt.
    const envelope = createDidcommTestMessage({
      from: ALICE_DID,
      to: [ALICE_DID],
      type: LOG_ENTRY_MESSAGE_TYPE,
    })
    await expect(adapter.send(envelope as never)).rejects.toThrow(/connect/)
    expect(await outbox.count()).toBe(0)
  })

  it('TC-T1: sync-request/1.0 and space-sync-request are never queued either (disconnected)', async () => {
    const syncRequest = createDidcommTestMessage({
      from: ALICE_DID,
      to: [ALICE_DID],
      type: SYNC_REQUEST_MESSAGE_TYPE,
    })
    await expect(adapter.send(syncRequest as never)).rejects.toThrow(/connect/)

    const spaceSyncRequest = oldWorldEnvelope(SPACE_SYNC_REQUEST_MESSAGE_TYPE)
    await expect(adapter.send(spaceSyncRequest as never)).rejects.toThrow(/connect/)

    expect(await outbox.count()).toBe(0)
  })

  it('TC-T1: a connected send failure does NOT enqueue a never-queue type (failure-enqueue path)', async () => {
    await inner.connect(ALICE_DID)
    vi.spyOn(inner, 'send').mockRejectedValue(new Error('transport hiccup'))

    const envelope = createDidcommTestMessage({
      from: ALICE_DID,
      to: [ALICE_DID],
      type: LOG_ENTRY_MESSAGE_TYPE,
    })
    await expect(adapter.send(envelope as never)).rejects.toThrow('transport hiccup')
    expect(await outbox.count()).toBe(0)
  })

  it('TC-T2 (regression): an inbox envelope still queues offline and delivers + dequeues after connect', async () => {
    const envelope = createDidcommTestMessage({
      from: ALICE_DID,
      to: [BOB_DID],
      type: INBOX_MESSAGE_TYPE,
    })
    // Disconnected → queued, synthetic accepted receipt (unchanged behaviour).
    const receipt = await adapter.send(envelope as never)
    expect(receipt.status).toBe('accepted')
    expect(receipt.reason).toBe('queued-in-outbox')
    expect(await outbox.count()).toBe(1)

    // Reconnect → flush delivers it through the inner transport and dequeues.
    await inner.connect(ALICE_DID)
    await adapter.flushOutbox()
    expect(await outbox.count()).toBe(0)
  })

  it('TC-T5: flushOutbox lazy-drains stale never-queue entries WITHOUT ever sending them', async () => {
    // Pre-fill the outbox as a previous (pre-#236) app version would have left it.
    const staleLogEntry = createDidcommTestMessage({
      from: ALICE_DID,
      to: [ALICE_DID],
      type: LOG_ENTRY_MESSAGE_TYPE,
    })
    const staleSpaceSync = oldWorldEnvelope(SPACE_SYNC_REQUEST_MESSAGE_TYPE)
    const queuedInbox = createDidcommTestMessage({
      from: ALICE_DID,
      to: [BOB_DID],
      type: INBOX_MESSAGE_TYPE,
    })
    await outbox.enqueue(staleLogEntry as never)
    await outbox.enqueue(staleSpaceSync as never)
    await outbox.enqueue(queuedInbox as never)
    expect(await outbox.count()).toBe(3)

    await inner.connect(ALICE_DID)
    const innerSend = vi.spyOn(inner, 'send')
    await adapter.flushOutbox()

    // Both never-queue entries were drained via dequeue — inner.send NEVER saw them.
    expect(await outbox.count()).toBe(0)
    const sentTypes = innerSend.mock.calls.map(([env]) => (env as { type?: string }).type)
    expect(sentTypes).not.toContain(LOG_ENTRY_MESSAGE_TYPE)
    expect(sentTypes).not.toContain(SPACE_SYNC_REQUEST_MESSAGE_TYPE)
    // The inbox entry WAS sent (regular flush behaviour untouched).
    expect(sentTypes).toContain(INBOX_MESSAGE_TYPE)
  })

  it('TC-T5: the drain also runs when a flush is triggered while another is in-flight (flushing-flag serialization)', async () => {
    const staleLogEntry = createDidcommTestMessage({
      from: ALICE_DID,
      to: [ALICE_DID],
      type: LOG_ENTRY_MESSAGE_TYPE,
    })
    await outbox.enqueue(staleLogEntry as never)

    await inner.connect(ALICE_DID)
    // Two concurrent flush triggers (connect fire-and-forget + onStateChange listener
    // in the demo): the flushing flag serializes them; the drain happens exactly once.
    await Promise.all([adapter.flushOutbox(), adapter.flushOutbox()])
    // A second explicit flush afterwards is a no-op on an empty outbox.
    await adapter.flushOutbox()
    expect(await outbox.count()).toBe(0)
  })
})
