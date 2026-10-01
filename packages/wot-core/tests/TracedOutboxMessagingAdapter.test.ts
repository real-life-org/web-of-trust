import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryMessagingAdapter } from '../src/adapters/messaging/InMemoryMessagingAdapter'
import { InMemoryOutboxStore } from '../src/adapters/messaging/InMemoryOutboxStore'
import { OutboxMessagingAdapter } from '../src/adapters/messaging/OutboxMessagingAdapter'
import { TracedOutboxMessagingAdapter } from '../src/adapters/messaging/TracedOutboxMessagingAdapter'
import { getTraceLog } from '../src/storage/TraceLog'
import { INBOX_MESSAGE_TYPE } from '../src/protocol/messaging/inbox-message'
import type { MessagingAdapter, WireMessage } from '../src/ports/MessagingAdapter'
import type { DeliveryReceipt, MessagingState } from '../src/types/messaging'
import { createDidcommTestMessage } from './helpers/didcomm-wire'

const ALICE_DID = 'did:key:z6MkAlice1234567890abcdefghijklmnopqrstuvwxyz'
const BOB_DID = 'did:key:z6MkBob1234567890abcdefghijklmnopqrstuvwxyzab'

// VE-8: Trace-Labels dürfen für die DIDComm-Familie nicht auf toDid/fromDid
// zugreifen (existieren dort nicht) — Mapping läuft defensiv über to[0]/from.

describe('TracedOutboxMessagingAdapter (DIDComm-Familie, VE-8)', () => {
  let inner: InMemoryMessagingAdapter
  let bob: InMemoryMessagingAdapter
  let traced: TracedOutboxMessagingAdapter

  beforeEach(() => {
    InMemoryMessagingAdapter.resetAll()
    getTraceLog().clear()
    inner = new InMemoryMessagingAdapter()
    bob = new InMemoryMessagingAdapter()
    traced = new TracedOutboxMessagingAdapter(
      new OutboxMessagingAdapter(inner, new InMemoryOutboxStore(), { sendTimeoutMs: 500 }),
    )
  })

  afterEach(() => {
    InMemoryMessagingAdapter.resetAll()
    getTraceLog().clear()
  })

  it('forwards sendControlFrame down the wrapper chain (Traced → Outbox → inner) so the log-sync L1 gate sees it (VE-DW8)', async () => {
    expect(typeof traced.sendControlFrame).toBe('function')
    const receipt = { messageId: 'space-1', status: 'delivered' as const, timestamp: 'now' }
    ;(inner as unknown as { sendControlFrame: () => Promise<typeof receipt> }).sendControlFrame =
      async () => receipt
    const result = await traced.sendControlFrame!({ type: 'present-capability' })
    expect(result).toBe(receipt)
  })

  it('traces a DIDComm send with to[0]-Label statt toDid', async () => {
    await traced.connect(ALICE_DID)
    await bob.connect(BOB_DID)

    const message = createDidcommTestMessage({ from: ALICE_DID, to: [BOB_DID] })
    const receipt = await traced.send(message)

    expect(receipt.status).toBe('accepted')
    const entry = getTraceLog().getAll({ operation: 'send' }).at(-1)
    expect(entry?.label).toBe(`send ${INBOX_MESSAGE_TYPE} → ${BOB_DID.slice(0, 24)}…`)
    expect(entry?.meta).toMatchObject({
      id: message.id,
      typ: 'application/didcomm-plain+json',
      from: ALICE_DID,
      to: [BOB_DID],
    })
  })

  it('traces a DIDComm receive with from-Label statt fromDid', async () => {
    await traced.connect(ALICE_DID)
    await bob.connect(BOB_DID)

    const received: WireMessage[] = []
    traced.onMessage((env) => { received.push(env) })

    await bob.send(createDidcommTestMessage({ from: BOB_DID, to: [ALICE_DID] }))

    expect(received).toHaveLength(1)
    const entry = getTraceLog().getAll({ operation: 'receive' }).at(-1)
    expect(entry?.label).toBe(`receive ${INBOX_MESSAGE_TYPE} ← ${BOB_DID.slice(0, 24)}…`)
  })

  it('traces one received frame once, regardless of the number of subscribers', async () => {
    await traced.connect(ALICE_DID)
    await bob.connect(BOB_DID)

    const seen: string[] = []
    traced.onMessage(() => { seen.push('a') })
    traced.onMessage(() => { seen.push('b') })
    traced.onMessage(() => { seen.push('c') })

    await bob.send(createDidcommTestMessage({ from: BOB_DID, to: [ALICE_DID] }))

    expect(seen).toEqual(['a', 'b', 'c'])
    expect(getTraceLog().getAll({ operation: 'receive' })).toHaveLength(1)
  })
})

/**
 * Minimal transport that lets a test push arbitrary frames into the message
 * callbacks — the way WebSocketMessagingAdapter fans a relay `error` frame out
 * (handleControlFrameError → message callbacks).
 */
class FrameInjectingTransport implements MessagingAdapter {
  private callbacks = new Set<(m: WireMessage) => void | Promise<void>>()
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  getState(): MessagingState { return 'connected' }
  onStateChange(): () => void { return () => {} }
  async send(envelope: WireMessage): Promise<DeliveryReceipt> {
    return { messageId: (envelope as { id: string }).id, status: 'accepted', timestamp: 'now' }
  }
  onMessage(cb: (m: WireMessage) => void | Promise<void>): () => void {
    this.callbacks.add(cb)
    return () => { this.callbacks.delete(cb) }
  }
  onReceipt(): () => void { return () => {} }
  async registerTransport(): Promise<void> {}
  async resolveTransport(): Promise<string | null> { return null }
  async inject(frame: unknown): Promise<void> {
    for (const cb of this.callbacks) await cb(frame as WireMessage)
  }
}

describe('TracedOutboxMessagingAdapter (relay error frames, wot#381)', () => {
  let transport: FrameInjectingTransport
  let traced: TracedOutboxMessagingAdapter

  beforeEach(() => {
    getTraceLog().clear()
    transport = new FrameInjectingTransport()
    traced = new TracedOutboxMessagingAdapter(
      new OutboxMessagingAdapter(transport, new InMemoryOutboxStore(), { reconnectIntervalMs: 0 }),
    )
  })

  afterEach(() => {
    getTraceLog().clear()
  })

  // wot#381 (1): `receive error ← unknown` with success:true told nobody what
  // the relay rejected. The code, the message and the correlating thid must be
  // in the trace, and an error is not a success.
  it('traces a relay error frame as a failure with code, message and correlation', async () => {
    traced.onMessage(() => {})

    await transport.inject({
      type: 'error',
      code: 'CAPABILITY_REQUIRED',
      message: 'space capability missing',
      thid: 'doc-123',
    })

    const entry = getTraceLog().getAll({ operation: 'receive' }).at(-1)
    expect(entry?.label).toBe('receive error CAPABILITY_REQUIRED ← relay')
    expect(entry?.success).toBe(false)
    expect(entry?.error).toBe('CAPABILITY_REQUIRED: space capability missing')
    expect(entry?.meta).toMatchObject({
      type: 'error',
      code: 'CAPABILITY_REQUIRED',
      message: 'space capability missing',
      thid: 'doc-123',
    })
  })

  it('traces an error frame without code or thid without inventing them', async () => {
    traced.onMessage(() => {})

    await transport.inject({ type: 'error', message: 'Unknown message type' })

    const entry = getTraceLog().getAll({ operation: 'receive' }).at(-1)
    expect(entry?.label).toBe('receive error ← relay')
    expect(entry?.success).toBe(false)
    expect(entry?.error).toBe('Unknown message type')
    expect(entry?.meta).toMatchObject({ type: 'error', message: 'Unknown message type' })
    expect(entry?.meta).not.toHaveProperty('code')
    expect(entry?.meta).not.toHaveProperty('thid')
  })
})
