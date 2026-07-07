/**
 * K1-Tests auf Host-Ebene (VE-9): ack/1.0-Ownership liegt beim
 * InboxReceptionHost — ack nur nach Anwendung (Listener resolved) oder als
 * Replay-Duplikat (Sync 003 Z.613-622); fehlgeschlagene Verarbeitung → kein ack.
 */
import { describe, it, expect, vi } from 'vitest'
import { IdentityWorkflow, deliverInboxMessage, type PublicIdentitySession } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import {
  ACK_MESSAGE_TYPE,
  INBOX_MESSAGE_TYPE,
  isDidcommMessage,
} from '@web_of_trust/core/protocol'
import type { DidcommPlaintextMessage } from '@web_of_trust/core/protocol'
import type { MessagingAdapter, WireMessage } from '@web_of_trust/core/ports'
import { InboxReceptionHost } from '../src/services/InboxReceptionHost'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

async function createIdentity(passphrase: string): Promise<PublicIdentitySession> {
  return (await new IdentityWorkflow({ crypto: cryptoAdapter }).createIdentity({
    passphrase,
    storeSeed: false,
  })).identity
}

function createMessagingStub() {
  const sent: WireMessage[] = []
  let handler: ((message: WireMessage) => void | Promise<void>) | null = null
  const adapter = {
    send: vi.fn(async (message: WireMessage) => {
      sent.push(message)
      return { messageId: message.id, status: 'accepted' as const, timestamp: new Date().toISOString() }
    }),
    onMessage: (cb: (message: WireMessage) => void | Promise<void>) => {
      handler = cb
      return () => { handler = null }
    },
    onReceipt: () => () => {},
    getState: () => 'connected' as const,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    registerTransport: vi.fn(async () => {}),
    resolveTransport: vi.fn(async () => null),
  }
  return {
    sent,
    adapter: adapter as unknown as MessagingAdapter,
    deliver: async (message: WireMessage) => {
      if (!handler) throw new Error('No onMessage handler registered')
      await handler(message)
    },
  }
}

function acks(sent: WireMessage[]): DidcommPlaintextMessage<object>[] {
  return sent.filter(
    (message): message is DidcommPlaintextMessage<object> =>
      isDidcommMessage(message) && message.type === ACK_MESSAGE_TYPE,
  )
}

// Form-gültiger Compact-JWS — der Host verifiziert den VC NICHT (Trust 002
// gehört dem Konsumenten), nur die Body-Shape {vcJws}.
const FAKE_VC_JWS = 'aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl'

async function buildDelivery(
  sender: PublicIdentitySession,
  recipient: PublicIdentitySession,
): Promise<DidcommPlaintextMessage<object>> {
  return deliverInboxMessage({
    type: INBOX_MESSAGE_TYPE,
    body: { vcJws: FAKE_VC_JWS },
    from: sender.getDid(),
    to: recipient.getDid(),
    recipientEncryptionPublicKey: recipient.x25519PublicKey,
    sign: (input) => sender.signEd25519(input),
    crypto: cryptoAdapter,
  })
}

describe('InboxReceptionHost (K1 ack ownership)', () => {
  it('dispatches an accepted delivery to the listener and sends exactly one ack/1.0', async () => {
    const sender = await createIdentity('host-sender')
    const recipient = await createIdentity('host-recipient')
    const messaging = createMessagingStub()
    const host = new InboxReceptionHost({
      messaging: messaging.adapter,
      identity: recipient,
      crypto: cryptoAdapter,
    })
    host.start()

    const listener = vi.fn(async () => {})
    host.onAttestation(listener)

    const envelope = await buildDelivery(sender, recipient)
    // S1-Auflösung: gespooftes outer-from darf den authentifizierten Sender
    // nicht ändern (Sync 003 Z.388-396 — Envelope ist kein Autoritätsanker).
    const spoofed = { ...envelope, from: recipient.getDid() }
    await messaging.deliver(spoofed)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({
      vcJws: FAKE_VC_JWS,
      senderDid: sender.getDid(),
      outerId: envelope.id,
    })

    const ackList = acks(messaging.sent)
    expect(ackList).toHaveLength(1)
    expect(ackList[0].thid).toBe(envelope.id)
    expect((ackList[0].body as { messageId: string }).messageId).toBe(envelope.id)
  })

  it('does not ack when the inner verification fails (tampered ciphertext)', async () => {
    const sender = await createIdentity('host-sender-2')
    const recipient = await createIdentity('host-recipient-2')
    const messaging = createMessagingStub()
    const host = new InboxReceptionHost({
      messaging: messaging.adapter,
      identity: recipient,
      crypto: cryptoAdapter,
    })
    host.start()
    const listener = vi.fn(async () => {})
    host.onAttestation(listener)

    const envelope = await buildDelivery(sender, recipient)
    const body = envelope.body as Record<string, string>
    const tampered = { ...envelope, body: { ...body, ciphertext: body.ciphertext.slice(0, -2) + 'AA' } }
    await messaging.deliver(tampered)

    expect(listener).not.toHaveBeenCalled()
    expect(acks(messaging.sent)).toHaveLength(0)
  })

  it('does not ack or record when the listener fails; the redelivery is applied normally (M1)', async () => {
    // Sync 003 Z.466 + Z.620-622: ein transienter Listener-Fehler ist KEIN
    // konklusiver Ausgang — die id bleibt aus der Message-ID-History und die
    // Relay-Redelivery ist der Recovery-Pfad. Würde die Redelivery als Replay
    // geACKt, räumte der Broker den Slot und die Zustellung wäre verloren.
    const sender = await createIdentity('host-sender-3')
    const recipient = await createIdentity('host-recipient-3')
    const messaging = createMessagingStub()
    const host = new InboxReceptionHost({
      messaging: messaging.adapter,
      identity: recipient,
      crypto: cryptoAdapter,
    })
    host.start()

    let transientFailures = 1
    const listener = vi.fn(async () => {
      if (transientFailures-- > 0) throw new Error('storage offline')
    })
    host.onAttestation(listener)

    const envelope = await buildDelivery(sender, recipient)
    await messaging.deliver(envelope)

    // K1: Verarbeitung fehlgeschlagen → KEIN ack (Redelivery-Pfad).
    expect(listener).toHaveBeenCalledTimes(1)
    expect(acks(messaging.sent)).toHaveLength(0)

    // Relay-Redelivery: kein Replay (nichts recorded) → der Listener läuft
    // erneut, die Anwendung gelingt → genau ein ack (Recovery-Beweis).
    await messaging.deliver(envelope)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(acks(messaging.sent)).toHaveLength(1)
    expect(acks(messaging.sent)[0].thid).toBe(envelope.id)
  })

  it('acks a replayed delivery exactly once more without re-dispatching', async () => {
    const sender = await createIdentity('host-sender-4')
    const recipient = await createIdentity('host-recipient-4')
    const messaging = createMessagingStub()
    const host = new InboxReceptionHost({
      messaging: messaging.adapter,
      identity: recipient,
      crypto: cryptoAdapter,
    })
    host.start()
    const listener = vi.fn(async () => {})
    host.onAttestation(listener)

    const envelope = await buildDelivery(sender, recipient)
    await messaging.deliver(envelope)
    await messaging.deliver(envelope)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(acks(messaging.sent)).toHaveLength(2)
  })

  it('buffers deliveries without listener (no ack) and flushes them on subscribe', async () => {
    const sender = await createIdentity('host-sender-5')
    const recipient = await createIdentity('host-recipient-5')
    const messaging = createMessagingStub()
    const host = new InboxReceptionHost({
      messaging: messaging.adapter,
      identity: recipient,
      crypto: cryptoAdapter,
    })
    host.start()

    const envelope = await buildDelivery(sender, recipient)
    await messaging.deliver(envelope)

    // In-memory-Puffer ist nicht durabel → noch kein ack (Sync 003 Z.613-622).
    expect(acks(messaging.sent)).toHaveLength(0)

    const listener = vi.fn(async () => {})
    host.onAttestation(listener)
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(1)
      expect(acks(messaging.sent)).toHaveLength(1)
    })
    expect(acks(messaging.sent)[0].thid).toBe(envelope.id)
  })

  it('does not burn a redelivery while buffered without listener (M1) and flushes it once', async () => {
    // Der In-Memory-Puffer ist nicht durabel → nicht recorded (Sync 003
    // Z.620-622). Eine Redelivery in dieser Phase darf weder als Replay enden
    // noch doppelt gepuffert werden — der Flush wendet genau einmal an.
    const sender = await createIdentity('host-sender-7')
    const recipient = await createIdentity('host-recipient-7')
    const messaging = createMessagingStub()
    const host = new InboxReceptionHost({
      messaging: messaging.adapter,
      identity: recipient,
      crypto: cryptoAdapter,
    })
    host.start()

    const envelope = await buildDelivery(sender, recipient)
    await messaging.deliver(envelope)
    await messaging.deliver(envelope) // Relay-Redelivery, weiterhin kein Listener
    expect(acks(messaging.sent)).toHaveLength(0)

    const listener = vi.fn(async () => {})
    host.onAttestation(listener)
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(1)
      expect(acks(messaging.sent)).toHaveLength(1)
    })
    expect(acks(messaging.sent)[0].thid).toBe(envelope.id)
  })

  it('ignores non-inbox message families entirely', async () => {
    const recipient = await createIdentity('host-recipient-6')
    const messaging = createMessagingStub()
    const host = new InboxReceptionHost({
      messaging: messaging.adapter,
      identity: recipient,
      crypto: cryptoAdapter,
    })
    host.start()
    const listener = vi.fn(async () => {})
    host.onAttestation(listener)

    // Old-World-Envelope (CRDT-Sync-Kanal) — der Host fasst sie nicht an.
    await messaging.deliver({
      v: 1,
      id: crypto.randomUUID(),
      type: 'content',
      fromDid: 'did:key:z6MkSender',
      toDid: recipient.getDid(),
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: '{}',
      signature: '',
    })

    expect(listener).not.toHaveBeenCalled()
    expect(acks(messaging.sent)).toHaveLength(0)
  })
})
