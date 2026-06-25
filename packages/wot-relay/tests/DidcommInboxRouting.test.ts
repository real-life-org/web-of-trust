import { describe, expect, it, beforeEach } from 'vitest'
import { RelayServer } from '../src/relay.js'

// Relay-Seite der Inbox-Wire-Migration (Sync 003):
// - Routing liest to[0] für DIDComm-Envelopes (Old-World toDid unverändert)
// - ack/1.0-Envelope → queue.ack-Mapping statt Routing (K1: Queue behält
//   DIDComm-Nachrichten bis zum expliziten ack/1.0 des Reception-Hosts)
// Per-Device-Inboxen sind SPEC-DEFERRED (Queue ist per-DID).
//
// Direkte Handler-Tests gegen die privaten Methoden mit Fake-Sockets — die
// Auth-/Netzwerk-Schicht ist in relay.test.ts abgedeckt.

const ALICE = 'did:key:z6MkAliceRelayInbox'
const BOB = 'did:key:z6MkBobRelayInbox'

const ACK_TYPE = 'https://web-of-trust.de/protocols/ack/1.0'
const INVITE_TYPE = 'https://web-of-trust.de/protocols/space-invite/1.0'
const LOG_ENTRY_TYPE = 'https://web-of-trust.de/protocols/log-entry/1.0'

interface FakeWs {
  readyState: number
  OPEN: number
  frames: Array<Record<string, unknown>>
  send(data: string): void
}

function fakeWs(): FakeWs {
  const frames: Array<Record<string, unknown>> = []
  return {
    readyState: 1,
    OPEN: 1,
    frames,
    send(data: string) {
      frames.push(JSON.parse(data) as Record<string, unknown>)
    },
  }
}

interface RelayInternals {
  socketToDid: Map<unknown, string>
  connections: Map<string, Set<unknown>>
  queue: {
    getUnacked(did: string): unknown[]
    dequeue(did: string): unknown[]
    count(did?: string): number
    enqueue(toDid: string, envelope: Record<string, unknown>): void
  }
  handleSend(ws: unknown, envelope: Record<string, unknown>): void
  handleAck(ws: unknown, messageId: string): void
  completeRegistration(ws: unknown, did: string, deviceId: string): void
}

function setup() {
  const server = new RelayServer({ port: 0 }) as unknown as RelayInternals
  const alice = fakeWs()
  const bob = fakeWs()
  server.socketToDid.set(alice, ALICE)
  server.socketToDid.set(bob, BOB)
  server.connections.set(ALICE, new Set([alice]))
  server.connections.set(BOB, new Set([bob]))
  return { server, alice, bob }
}

function didcommEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    typ: 'application/didcomm-plain+json',
    type: INVITE_TYPE,
    from: ALICE,
    to: [BOB],
    created_time: 1781438400,
    body: { epk: 'ZXBr', nonce: 'bm9uY2U', ciphertext: 'Y2lwaGVydGV4dA' },
    ...overrides,
  }
}

function ackEnvelope(messageId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '7a1c2f80-aabb-4cdd-9eef-112233445566',
    typ: 'application/didcomm-plain+json',
    type: ACK_TYPE,
    from: BOB,
    created_time: 1781438401,
    thid: messageId,
    body: { messageId },
    ...overrides,
  }
}

describe('Relay DIDComm inbox routing + ack/1.0 mapping', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
  })

  it('routes a DIDComm envelope via to[0] and keeps it queued until ack (K1)', () => {
    const envelope = didcommEnvelope()
    ctx.server.handleSend(ctx.alice, envelope)

    expect(ctx.bob.frames).toEqual([{ type: 'message', envelope }])
    expect(ctx.alice.frames).toEqual([
      expect.objectContaining({ type: 'receipt', receipt: expect.objectContaining({ status: 'delivered' }) }),
    ])
    // K1: kein Auto-ACK clientseitig → die Nachricht bleibt als unacked in der
    // Queue und würde bei Reconnect redelivered.
    expect(ctx.server.queue.getUnacked(BOB)).toHaveLength(1)
  })

  it('clears the queue when the reception host sends ack/1.0 and confirms with a receipt', () => {
    const envelope = didcommEnvelope()
    ctx.server.handleSend(ctx.alice, envelope)
    expect(ctx.server.queue.getUnacked(BOB)).toHaveLength(1)

    const ack = ackEnvelope(envelope.id as string)
    ctx.server.handleSend(ctx.bob, ack)

    expect(ctx.server.queue.getUnacked(BOB)).toHaveLength(0)
    // ack/1.0 wird gemappt, nicht geroutet — niemand bekommt es als Message.
    expect(ctx.alice.frames.filter((f) => f.type === 'message')).toHaveLength(0)
    expect(ctx.bob.frames.at(-1)).toEqual(
      expect.objectContaining({
        type: 'receipt',
        receipt: expect.objectContaining({ messageId: ack.id, status: 'delivered' }),
      }),
    )
  })

  it('rejects an ack/1.0 whose thid does not match body.messageId (Sync 003 Z.609)', () => {
    const envelope = didcommEnvelope()
    ctx.server.handleSend(ctx.alice, envelope)

    ctx.server.handleSend(
      ctx.bob,
      ackEnvelope(envelope.id as string, { thid: '99999999-9999-4999-8999-999999999999' }),
    )

    expect(ctx.bob.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    )
    expect(ctx.server.queue.getUnacked(BOB)).toHaveLength(1)
  })

  it('rejects an ack/1.0 without body.messageId', () => {
    ctx.server.handleSend(ctx.bob, ackEnvelope('x', { body: {} }))
    expect(ctx.bob.frames).toEqual([
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    ])
  })

  it('rejects the old-world string type ack with MALFORMED_MESSAGE (relay-whitelist, VE-R2)', () => {
    // Post-VE-R2 the relay only relays/queues defined transport types. The old-world
    // string `ack` (v:1, no DIDComm typ) is not in the Nachrichtentypen-Tabelle —
    // the only ack the relay understands is the DIDComm ack/1.0 (mapped, not routed).
    const oldWorldAck = {
      v: 1,
      id: '11111111-2222-4333-8444-555555555555',
      type: 'ack',
      fromDid: ALICE,
      toDid: BOB,
      createdAt: '2026-06-10T12:00:00Z',
      encoding: 'json',
      payload: '{}',
      signature: '',
    }
    ctx.server.handleSend(ctx.alice, oldWorldAck as unknown as Record<string, unknown>)
    expect(ctx.alice.frames).toEqual([
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    ])
    // Not relayed: Bob received nothing.
    expect(ctx.bob.frames).toEqual([])
  })

  it('queues a DIDComm envelope for an offline recipient via to[0]', () => {
    ctx.server.connections.delete(BOB)
    const envelope = didcommEnvelope()
    ctx.server.handleSend(ctx.alice, envelope)
    expect(ctx.alice.frames).toEqual([
      expect.objectContaining({ type: 'receipt', receipt: expect.objectContaining({ status: 'accepted' }) }),
    ])
    expect(ctx.server.queue.dequeue(BOB)).toEqual([envelope])
  })

  it('still rejects envelopes without any recipient field', () => {
    ctx.server.handleSend(ctx.alice, didcommEnvelope({ to: undefined }))
    expect(ctx.alice.frames).toEqual([
      expect.objectContaining({ type: 'error', code: 'MISSING_RECIPIENT' }),
    ])
  })

  it('rejects an ack/1.0 whose body.messageId is not a canonical lowercase UUID v4', () => {
    const envelope = didcommEnvelope()
    ctx.server.handleSend(ctx.alice, envelope)

    // Uppercase-UUID verletzt Sync 003 Z.609 (kanonische lowercase UUID v4).
    ctx.server.handleSend(ctx.bob, ackEnvelope((envelope.id as string).toUpperCase()))

    expect(ctx.bob.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    )
    expect(ctx.server.queue.getUnacked(BOB)).toHaveLength(1)
  })

  it('rejects an ack/1.0 referencing a queued log-sync-typed envelope (Sync 003 §Log-Sync vs. Inbox-ACK)', () => {
    const logEntry = didcommEnvelope({
      type: LOG_ENTRY_TYPE,
      body: { docId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b', payload: 'AAA' },
    })

    // Erste Abwehr (VE-R2): ein log-entry/1.0-typisierter Envelope, der zu malformed
    // ist um in den Durable-Log-Pfad zu divergieren, wird von der Relay-Whitelist mit
    // MALFORMED_MESSAGE abgelehnt — er landet NICHT als opaker Inbox-Slot in der Queue.
    ctx.server.handleSend(ctx.alice, logEntry)
    expect(ctx.alice.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    )
    expect(ctx.server.queue.count(BOB)).toBe(0)

    // Zweite Abwehr (defense-in-depth, handleInboxAckEnvelope): läge — auf welchem
    // Pfad auch immer — ein log-sync-typisierter Slot doch in der Queue, räumt ein
    // ack/1.0 ihn NICHT (ack/1.0 ist ausschließlich für den Inbox-Kanal definiert).
    // Wir seeden den Slot direkt, um genau diese Ownership-Prüfung zu belegen.
    ctx.server.queue.enqueue(BOB, logEntry)
    expect(ctx.server.queue.count(BOB)).toBe(1)

    ctx.server.handleSend(ctx.bob, ackEnvelope(logEntry.id as string))
    expect(ctx.bob.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    )
    // Der Slot bleibt: ack/1.0 räumt keinen Log-Sync-Slot.
    expect(ctx.server.queue.count(BOB)).toBe(1)
  })

  it('rejects an ack/1.0 referencing a queued Old-World envelope', () => {
    const oldWorld = {
      v: 1,
      id: '0e7d1f7a-3b58-4c2d-9a51-2f0c4e8b6d3a',
      type: 'content',
      fromDid: ALICE,
      toDid: BOB,
      createdAt: '2026-06-10T12:00:00Z',
      encoding: 'json',
      payload: '{}',
      signature: '',
    }

    // Erste Abwehr (VE-R2): die deprecated Old-World-Envelope (v:1, kein DIDComm typ)
    // wird von der Relay-Whitelist abgelehnt — sie wird nie als Inbox-Slot gequeued.
    ctx.server.handleSend(ctx.alice, oldWorld as unknown as Record<string, unknown>)
    expect(ctx.alice.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    )
    expect(ctx.server.queue.count(BOB)).toBe(0)

    // Zweite Abwehr (defense-in-depth, handleInboxAckEnvelope): ein direkt geseedeter
    // Old-World-Slot wird durch ack/1.0 NICHT geräumt — er ist keine DIDComm-Inbox-
    // Nachricht (Old-World wird per Control-Frame-ACK geräumt, nicht per ack/1.0).
    ctx.server.queue.enqueue(BOB, oldWorld as unknown as Record<string, unknown>)
    expect(ctx.server.queue.count(BOB)).toBe(1)

    ctx.server.handleSend(ctx.bob, ackEnvelope(oldWorld.id))
    expect(ctx.bob.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    )
    expect(ctx.server.queue.count(BOB)).toBe(1)
  })

  it('rejects an ack/1.0 for a message addressed to another DID (fremder Queue-Slot)', () => {
    const envelope = didcommEnvelope() // an BOB adressiert
    ctx.server.handleSend(ctx.alice, envelope)

    // Maßgeblich ist die authentifizierte DID der Verbindung, nicht `from` im
    // Envelope — Alice darf Bobs Slot nicht räumen (Autoritätsgrenze).
    ctx.server.handleSend(ctx.alice, ackEnvelope(envelope.id as string, { from: ALICE }))

    expect(ctx.alice.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    )
    expect(ctx.server.queue.getUnacked(BOB)).toHaveLength(1)
  })

  it('accepts an ack/1.0 for an unknown messageId idempotently (per-DID-Queue, per-Device SPEC-DEFERRED)', () => {
    // Nach Slot-Räumung durch Device 1 ackt ein Geschwister-Gerät dieselbe
    // messageId erneut — unter per-DID-Queues legitim, daher kein Reject.
    ctx.server.handleSend(ctx.bob, ackEnvelope('123e4567-e89b-42d3-a456-426614174000'))

    expect(ctx.bob.frames).toEqual([
      expect.objectContaining({
        type: 'receipt',
        receipt: expect.objectContaining({ status: 'delivered' }),
      }),
    ])
  })

  it('keeps a DIDComm inbox slot when the sender acks via old control frame, until ack/1.0 from Bob (K1)', () => {
    const envelope = didcommEnvelope()
    ctx.server.handleSend(ctx.alice, envelope)
    expect(ctx.server.queue.getUnacked(BOB)).toHaveLength(1)

    // Alice kennt envelope.id als Senderin — der alte Control-Frame-ACK darf
    // Bobs Inbox-Slot nicht räumen (K1-Ownership, kein ack/1.0-Bypass).
    ctx.server.handleAck(ctx.alice, envelope.id as string)
    expect(ctx.alice.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    )
    expect(ctx.server.queue.getUnacked(BOB)).toHaveLength(1)

    // Erst Bobs ack/1.0 als Reception-Host räumt den Slot.
    ctx.server.handleSend(ctx.bob, ackEnvelope(envelope.id as string))
    expect(ctx.server.queue.getUnacked(BOB)).toHaveLength(0)
  })

  it('rejects the old control frame for inbox-channel messages even from the recipient (nur ack/1.0)', () => {
    const envelope = didcommEnvelope()
    ctx.server.handleSend(ctx.alice, envelope)

    // Auch Bob selbst räumt Inbox-Slots ausschließlich per ack/1.0 — der
    // Control-Frame trägt keine Ack-Disposition (Sync 003 ACK-Vorbedingungen).
    ctx.server.handleAck(ctx.bob, envelope.id as string)

    expect(ctx.bob.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    )
    expect(ctx.server.queue.getUnacked(BOB)).toHaveLength(1)
  })

  it('enforces toDid ownership for old control-frame acks on a non-inbox queued slot', () => {
    // VE-R2 entfernt den Old-World-Sendepfad (handleSend lehnt v:1 ab), aber die
    // Control-Frame-ACK-Ownership-Prüfung in handleAck bleibt als defense-in-depth
    // für jeden NICHT-Inbox-Slot bestehen. Wir seeden den Slot direkt (der Slot kann
    // nicht mehr über handleSend entstehen) und belegen die Autoritätsgrenze.
    const oldWorld = {
      v: 1,
      id: '4f8b2c6d-1e3a-4b5c-8d7e-9f0a1b2c3d4e',
      type: 'content',
      fromDid: ALICE,
      toDid: BOB,
      createdAt: '2026-06-10T12:00:00Z',
      encoding: 'json',
      payload: '{}',
      signature: '',
    }
    // Gegenprobe: über handleSend kommt der Old-World-Envelope gar nicht erst rein.
    ctx.server.handleSend(ctx.alice, oldWorld as unknown as Record<string, unknown>)
    expect(ctx.alice.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    )
    expect(ctx.server.queue.count(BOB)).toBe(0)

    ctx.server.queue.enqueue(BOB, oldWorld as unknown as Record<string, unknown>)
    expect(ctx.server.queue.count(BOB)).toBe(1)

    // Alice (Senderin) darf Bobs Slot nicht per Control-Frame räumen.
    ctx.server.handleAck(ctx.alice, oldWorld.id)
    expect(ctx.alice.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', code: 'MALFORMED_MESSAGE' }),
    )
    expect(ctx.server.queue.count(BOB)).toBe(1)

    // Bob als Empfänger (matching toDid) räumt einen Nicht-Inbox-Slot weiterhin per
    // Control-Frame — kein Behavior-Bruch für alte Clients (Rollout: relay-first).
    const bobFramesBefore = ctx.bob.frames.length
    ctx.server.handleAck(ctx.bob, oldWorld.id)
    expect(ctx.server.queue.count(BOB)).toBe(0)
    // Erfolgreicher Control-Frame-ACK bleibt antwortlos wie bisher.
    expect(ctx.bob.frames.length).toBe(bobFramesBefore)
  })

  it('accepts an old control-frame ack for an unknown messageId as a silent no-op (idempotent)', () => {
    // Bereits geräumter Slot bzw. Geschwister-Gerät derselben DID — alte
    // Clients dürfen dafür keinen Fehler bekommen.
    ctx.server.handleAck(ctx.bob, '123e4567-e89b-42d3-a456-426614174000')
    expect(ctx.bob.frames).toEqual([])
  })

  it('redelivers an unacked DIDComm message on reconnect and clears it after ack/1.0', () => {
    const envelope = didcommEnvelope()
    ctx.server.handleSend(ctx.alice, envelope)
    expect(ctx.bob.frames).toEqual([{ type: 'message', envelope }])

    // Bob verarbeitet nicht (kein ack/1.0) und verbindet neu — die Nachricht
    // MUSS aus getUnacked redelivered werden (Direktive 1.6).
    const bobReconnect = fakeWs()
    ctx.server.completeRegistration(bobReconnect, BOB, '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f')
    expect(bobReconnect.frames.filter((f) => f.type === 'message')).toEqual([
      { type: 'message', envelope },
    ])

    // Erst das ack/1.0 des Reception-Hosts räumt den Slot — die nächste
    // Verbindung bekommt keine Redelivery mehr.
    ctx.server.handleSend(bobReconnect, ackEnvelope(envelope.id as string))
    const bobThird = fakeWs()
    ctx.server.completeRegistration(bobThird, BOB, '1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b')
    expect(bobThird.frames.filter((f) => f.type === 'message')).toHaveLength(0)
    expect(ctx.server.queue.count(BOB)).toBe(0)
  })
})
