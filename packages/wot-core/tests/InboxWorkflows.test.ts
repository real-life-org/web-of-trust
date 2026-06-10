import { describe, expect, it } from 'vitest'
import { deliverInboxMessage, receiveInboxMessage } from '../src/application/messaging'
import {
  ENCRYPTED_INBOX_MESSAGE_TYPES,
  INBOX_MESSAGE_TYPE,
  MEMBER_UPDATE_MESSAGE_TYPE,
  createDidKeyResolver,
  decodeBase64Url,
  type EciesMessage,
} from '../src/protocol'
import { InMemoryMessageIdHistory } from '../src/adapters/message-id-history'
import { createTestIdentity, testCryptoAdapter } from './helpers/identity-session'
import type { PublicIdentitySession } from '../src/application/identity'

// Sync 003 Z.446-470: voller Inbox-Pfad — Klartext-Body → Inner-JWS → ECIES →
// DIDComm-Envelope und zurück. Der accept-Result trägt den kryptographisch
// authentifizierten senderDid (Inner-JWS `from`), nie das Envelope-Routing.

const NOW = new Date('2026-06-10T12:00:00Z')

function decryptFor(identity: PublicIdentitySession) {
  return (message: EciesMessage) =>
    identity.decryptForMe({
      ephemeralPublicKey: decodeBase64Url(message.epk),
      nonce: decodeBase64Url(message.nonce),
      ciphertext: decodeBase64Url(message.ciphertext),
    })
}

async function pair() {
  const sender = (await createTestIdentity()).identity
  const recipient = (await createTestIdentity()).identity
  return { sender, recipient }
}

function deliverOptions(
  sender: PublicIdentitySession,
  recipient: PublicIdentitySession,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: INBOX_MESSAGE_TYPE,
    body: { vcJws: 'a.b.c' },
    from: sender.did,
    to: recipient.did,
    recipientEncryptionPublicKey: recipient.x25519PublicKey,
    sign: (input: Uint8Array) => sender.signEd25519(input),
    crypto: testCryptoAdapter,
    now: () => NOW,
    ...overrides,
  }
}

function receiveOptions(recipient: PublicIdentitySession, message: unknown, overrides: Record<string, unknown> = {}) {
  return {
    message,
    ownDid: recipient.did,
    decryptEcies: decryptFor(recipient),
    crypto: testCryptoAdapter,
    didResolver: createDidKeyResolver(),
    messageIdHistory: new InMemoryMessageIdHistory(),
    now: () => NOW,
    ...overrides,
  }
}

describe('deliverInboxMessage / receiveInboxMessage', () => {
  it('roundtrips every encrypted inbox type URI with authenticated senderDid', async () => {
    const { sender, recipient } = await pair()
    for (const type of ENCRYPTED_INBOX_MESSAGE_TYPES) {
      const body = { marker: `body-for-${type}` }
      const envelope = await deliverInboxMessage(deliverOptions(sender, recipient, { type, body }))
      expect(envelope.typ).toBe('application/didcomm-plain+json')
      expect(envelope.type).toBe(type)
      expect(envelope.to).toEqual([recipient.did])

      const result = await receiveInboxMessage(receiveOptions(recipient, envelope))
      expect(result).toMatchObject({
        decision: 'accept',
        type,
        senderDid: sender.did,
        body,
        outerId: envelope.id,
      })
    }
  })

  it('PFLICHT (S1-Auflösung): gespoofter outer-from — accept trägt den Inner-JWS-from', async () => {
    const { sender, recipient } = await pair()
    const spoofedAdmin = (await createTestIdentity()).identity
    const envelope = await deliverInboxMessage(deliverOptions(sender, recipient, { type: MEMBER_UPDATE_MESSAGE_TYPE }))
    // Angreifer-Szenario: Envelope-Routing-from auf eine Admin-DID umschreiben.
    // Sync 003 Z.392: from im Envelope DARF NICHT als Autor gewertet werden.
    const spoofed = { ...envelope, from: spoofedAdmin.did }

    const result = await receiveInboxMessage(receiveOptions(recipient, spoofed))
    expect(result.decision).toBe('accept')
    if (result.decision !== 'accept') throw new Error('unreachable')
    expect(result.senderDid).toBe(sender.did)
    expect(result.senderDid).not.toBe(spoofedAdmin.did)
  })

  it('keeps the clear body out of the wire envelope (nur ECIES-Container + Extensions)', async () => {
    const { sender, recipient } = await pair()
    const envelope = await deliverInboxMessage(
      deliverOptions(sender, recipient, { body: { secret: 'kept-confidential' } }),
    )
    expect(JSON.stringify(envelope)).not.toContain('kept-confidential')
    expect(Object.keys(envelope.body).sort()).toEqual(['ciphertext', 'epk', 'nonce'])
  })

  it('passes extensionFields outside the inner JWS and returns them on accept (VE-5)', async () => {
    const { sender, recipient } = await pair()
    const envelope = await deliverInboxMessage(
      deliverOptions(sender, recipient, { extensionFields: { encryptedDocSnapshot: 'AAECAw' } }),
    )
    expect(envelope.body.encryptedDocSnapshot).toBe('AAECAw')

    const result = await receiveInboxMessage(receiveOptions(recipient, envelope))
    expect(result).toMatchObject({
      decision: 'accept',
      extensionFields: { encryptedDocSnapshot: 'AAECAw' },
      // Extension reist NICHT im Inner-JWS-Body.
      body: { vcJws: 'a.b.c' },
    })
  })

  it('throws on extensionFields colliding with the ECIES container (Schema-Assert, P2)', async () => {
    const { sender, recipient } = await pair()
    await expect(
      deliverInboxMessage(deliverOptions(sender, recipient, { extensionFields: { epk: 'evil' } })),
    ).rejects.toThrow('collides with ECIES container')
  })

  it('rejects malformed wire input instead of throwing (P2-Konvention)', async () => {
    const { recipient } = await pair()
    for (const malformed of [
      null,
      'string',
      { v: 1, type: 'attestation', payload: '{}' },
      { id: 'not-a-uuid', typ: 'application/didcomm-plain+json' },
    ]) {
      const result = await receiveInboxMessage(receiveOptions(recipient, malformed))
      expect(result).toEqual({ decision: 'reject', reason: 'malformed-envelope' })
    }
  })

  it('rejects an envelope whose ECIES payload is not decryptable for this identity', async () => {
    const { sender, recipient } = await pair()
    const wrongRecipient = (await createTestIdentity()).identity
    const envelope = await deliverInboxMessage(deliverOptions(sender, recipient, {}))
    const result = await receiveInboxMessage(receiveOptions(wrongRecipient, envelope))
    // Decrypt mit fremdem Key scheitert am GCM-Tag — nie am Inner-JWS vorbei.
    expect(result).toEqual({ decision: 'reject', reason: 'decrypt-failed' })
  })

  it('rejects an invalid inner JWS (Misdirection: to ≠ ownDid nach Re-Encrypt)', async () => {
    const { sender, recipient } = await pair()
    const eavesdropper = (await createTestIdentity()).identity
    // Sender adressiert den Inner-JWS an recipient, verschlüsselt aber für
    // eavesdropper (Misdirection) — Pflichtprüfung 2 muss das abfangen.
    const envelope = await deliverInboxMessage(
      deliverOptions(sender, recipient, {
        recipientEncryptionPublicKey: eavesdropper.x25519PublicKey,
      }),
    )
    const result = await receiveInboxMessage(receiveOptions(eavesdropper, envelope))
    expect(result).toEqual({ decision: 'reject', reason: 'invalid-inner-jws' })
  })

  it('rejects an expired created_time as invalid-inner-jws', async () => {
    const { sender, recipient } = await pair()
    const envelope = await deliverInboxMessage(
      deliverOptions(sender, recipient, { now: () => new Date(NOW.getTime() - 25 * 60 * 60 * 1000) }),
    )
    const result = await receiveInboxMessage(receiveOptions(recipient, envelope))
    expect(result).toEqual({ decision: 'reject', reason: 'invalid-inner-jws' })
  })

  it('rejects a replay after conclusive recording (Pflichtprüfung 5, Sync 003 Z.466)', async () => {
    const { sender, recipient } = await pair()
    const envelope = await deliverInboxMessage(deliverOptions(sender, recipient, {}))
    const history = new InMemoryMessageIdHistory()
    const first = await receiveInboxMessage(receiveOptions(recipient, envelope, { messageIdHistory: history }))
    expect(first.decision).toBe('accept')
    if (first.decision !== 'accept') throw new Error('unreachable')
    // Sync 003 Z.620-622: erst der konklusive Ausgang (Anwendung / durable
    // Pufferung) macht die id zu "verarbeitet" — der Aufrufer recorded sie dort.
    await first.recordProcessed()
    const second = await receiveInboxMessage(receiveOptions(recipient, envelope, { messageIdHistory: history }))
    expect(second).toEqual({ decision: 'reject', reason: 'replay' })
  })

  it('PFLICHT (M1): ohne recordProcessed wird die Redelivery erneut akzeptiert (Recovery)', async () => {
    // Sync 003 Z.466 + Z.620-622: ein nicht-konklusiver Ausgang (z.B. transienter
    // Anwendungsfehler, unknown space ohne durable Pufferung) darf die
    // Relay-Redelivery nicht als Replay verbrennen — sonst räumt das
    // duplicate-known-ack den Broker-Slot und die Nachricht ist verloren.
    const { sender, recipient } = await pair()
    const envelope = await deliverInboxMessage(deliverOptions(sender, recipient, {}))
    const history = new InMemoryMessageIdHistory()
    const first = await receiveInboxMessage(receiveOptions(recipient, envelope, { messageIdHistory: history }))
    expect(first.decision).toBe('accept')
    // KEIN recordProcessed — die Verarbeitung gilt als nicht konklusiv.
    expect(await history.has(envelope.id, NOW.toISOString())).toBe(false)
    const redelivery = await receiveInboxMessage(receiveOptions(recipient, envelope, { messageIdHistory: history }))
    expect(redelivery).toMatchObject({ decision: 'accept', senderDid: sender.did, outerId: envelope.id })
  })

  it('does not poison the message-id history with rejected messages', async () => {
    const { sender, recipient } = await pair()
    const history = new InMemoryMessageIdHistory()
    const envelope = await deliverInboxMessage(deliverOptions(sender, recipient, {}))
    // Erst eine kaputte Variante derselben id (Angreifer) — sie darf die
    // History nicht belegen, sonst würde das spätere Original als Replay fallen.
    const tampered = { ...envelope, body: { ...envelope.body, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }
    const poisoned = await receiveInboxMessage(receiveOptions(recipient, tampered, { messageIdHistory: history }))
    expect(poisoned.decision).toBe('reject')
    const original = await receiveInboxMessage(receiveOptions(recipient, envelope, { messageIdHistory: history }))
    expect(original.decision).toBe('accept')
  })
})
