import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryMessagingAdapter } from '../src/adapters/messaging/InMemoryMessagingAdapter'
import { InMemoryOutboxStore } from '../src/adapters/messaging/InMemoryOutboxStore'
import { OutboxMessagingAdapter } from '../src/adapters/messaging/OutboxMessagingAdapter'
import { TracedOutboxMessagingAdapter } from '../src/adapters/messaging/TracedOutboxMessagingAdapter'
import { getTraceLog } from '../src/storage/TraceLog'
import { INBOX_MESSAGE_TYPE } from '../src/protocol/messaging/inbox-message'
import type { WireMessage } from '../src/ports/MessagingAdapter'
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

  it('keeps old-world labels unchanged (toDid/fromDid)', async () => {
    await traced.connect(ALICE_DID)
    await bob.connect(BOB_DID)

    await traced.send({
      v: 1,
      id: crypto.randomUUID(),
      type: 'content',
      fromDid: ALICE_DID,
      toDid: BOB_DID,
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: '{}',
      signature: 'sig',
    })

    const entry = getTraceLog().getAll({ operation: 'send' }).at(-1)
    expect(entry?.label).toBe(`send content → ${BOB_DID.slice(0, 24)}…`)
    expect(entry?.meta).toMatchObject({ fromDid: ALICE_DID, toDid: BOB_DID, v: 1 })
  })
})
