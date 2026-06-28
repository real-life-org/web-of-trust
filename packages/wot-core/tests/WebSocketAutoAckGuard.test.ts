import { describe, expect, it } from 'vitest'
import { WebSocketMessagingAdapter } from '../src/adapters/messaging/WebSocketMessagingAdapter'
import { INBOX_MESSAGE_TYPE } from '../src/protocol'

// K1 (Sync 003 Z.613-622): das generische Transport-Auto-ACK des WS-Adapters
// DARF für DIDComm-Inbox-Nachrichten nicht feuern — ACK-Ownership liegt beim
// Inbox-Reception-Host nach evaluierter Ack-Disposition. Old-World-CRDT-Sync
// behält das Auto-ACK unverändert (inkl. der Semantik "ein resolvter Callback
// reicht, auch wenn andere werfen").

const OLD_WORLD = {
  v: 1,
  id: '550e8400-e29b-41d4-a716-446655440000',
  type: 'content',
  fromDid: 'did:key:z6MkAlice',
  toDid: 'did:key:z6MkBob',
  createdAt: '2026-06-10T12:00:00Z',
  encoding: 'json',
  payload: '{}',
  signature: 'sig',
}

const DIDCOMM = {
  id: '7a1c2f80-aabb-4cdd-9eef-112233445566',
  typ: 'application/didcomm-plain+json',
  type: INBOX_MESSAGE_TYPE,
  from: 'did:key:z6MkAlice',
  to: ['did:key:z6MkBob'],
  created_time: 1781438400,
  body: { epk: 'ZXBr', nonce: 'bm9uY2U', ciphertext: 'Y2lwaGVydGV4dA' },
}

function adapterWithFakeSocket() {
  const adapter = new WebSocketMessagingAdapter('ws://unused')
  const sent: string[] = []
  ;(adapter as unknown as { ws: unknown }).ws = {
    readyState: 1, // WebSocket.OPEN
    send: (data: string) => sent.push(data),
  }
  const deliver = (envelope: unknown) =>
    (adapter as unknown as { handleIncomingMessage(e: unknown): Promise<void> }).handleIncomingMessage(envelope)
  return { adapter, sent, deliver }
}

describe('WebSocketMessagingAdapter Auto-ACK-Guard (K1)', () => {
  it('auto-ACKs old-world envelopes after a callback resolves (unverändert)', async () => {
    const { adapter, sent, deliver } = adapterWithFakeSocket()
    adapter.onMessage(() => {})
    await deliver(OLD_WORLD)
    expect(sent).toEqual([JSON.stringify({ type: 'ack', messageId: OLD_WORLD.id })])
  })

  it('does NOT auto-ACK DIDComm inbox messages even when callbacks resolve', async () => {
    const { adapter, sent, deliver } = adapterWithFakeSocket()
    let received: unknown = null
    adapter.onMessage((envelope) => {
      received = envelope
    })
    await deliver(DIDCOMM)
    expect(received).toEqual(DIDCOMM)
    expect(sent).toEqual([])
  })

  it('does NOT auto-ACK DIDComm inbox messages whose processing throws', async () => {
    const { adapter, sent, deliver } = adapterWithFakeSocket()
    adapter.onMessage(() => {
      throw new Error('inner JWS invalid')
    })
    await deliver(DIDCOMM)
    expect(sent).toEqual([])
  })

  it('keeps the old-world semantics: one resolved callback ACKs despite another throwing', async () => {
    const { adapter, sent, deliver } = adapterWithFakeSocket()
    adapter.onMessage(() => {
      throw new Error('boom')
    })
    adapter.onMessage(() => {})
    await deliver(OLD_WORLD)
    expect(sent).toHaveLength(1)
  })
})
