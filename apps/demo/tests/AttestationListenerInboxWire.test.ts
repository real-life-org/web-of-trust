/**
 * M-A Integrationstests: echter InboxReceptionHost + echter App-Listener
 * (createAttestationListener) am inbox/1.0-Wire.
 *
 * Sync 003 Z.466 + Z.620-622: ein transienter Persist-Fehler im Listener ist
 * KEIN konklusiver Ausgang — kein ack, kein record; die Relay-Redelivery ist
 * der Recovery-Pfad. Ein deterministisches Duplikat (DuplicateAttestationError)
 * ist konklusiv — der Host ackt und räumt den Broker-Slot.
 */
import { describe, it, expect, vi } from 'vitest'
import { IdentityWorkflow, deliverInboxMessage, type PublicIdentitySession } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import {
  ACK_MESSAGE_TYPE,
  INBOX_MESSAGE_TYPE,
  isDidcommMessage,
} from '@web_of_trust/core/protocol'
import type { AttestationVcPayload, DidcommPlaintextMessage } from '@web_of_trust/core/protocol'
import type { MessagingAdapter, WireMessage } from '@web_of_trust/core/ports'
import type { Attestation, IdentitySession } from '@web_of_trust/core/types'
import { InboxReceptionHost } from '../src/services/InboxReceptionHost'
import {
  createAttestationListener,
  type AttestationListenerDeps,
} from '../src/services/attestationListener'
import { DuplicateAttestationError } from '../src/services/AttestationService'

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

/** Generische (Nicht-Verification-)Attestation als fake VC-JWS mit echten DIDs. */
function makeVcJws(fromDid: string, toDid: string): string {
  return `header.${Buffer.from(JSON.stringify({
    id: 'urn:uuid:11111111-2222-4333-8444-555555555555',
    type: ['VerifiableCredential', 'WotAttestation'],
    issuer: fromDid,
    validFrom: '2026-06-10T10:00:00Z',
    iss: fromDid,
    sub: toDid,
    jti: 'urn:uuid:11111111-2222-4333-8444-555555555555',
    credentialSubject: { id: toDid, claim: 'Knows TypeScript' },
  })).toString('base64url')}.signature`
}

/** K2-Ableitungs-Stub: Attestation-View aus dem (fake-verifizierten) Payload. */
async function decodeStub(vcJws: string): Promise<{ attestation: Attestation; payload: AttestationVcPayload }> {
  const [, payloadPart] = vcJws.split('.')
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as AttestationVcPayload
  return {
    payload,
    attestation: {
      id: payload.jti as string,
      from: payload.issuer,
      to: payload.credentialSubject.id,
      claim: payload.credentialSubject.claim,
      createdAt: payload.validFrom,
      vcJws,
    },
  }
}

async function buildDelivery(
  sender: PublicIdentitySession,
  recipient: PublicIdentitySession,
): Promise<DidcommPlaintextMessage<object>> {
  return deliverInboxMessage({
    type: INBOX_MESSAGE_TYPE,
    body: { vcJws: makeVcJws(sender.getDid(), recipient.getDid()) },
    from: sender.getDid(),
    to: recipient.getDid(),
    recipientEncryptionPublicKey: recipient.x25519PublicKey,
    sign: (input) => sender.signEd25519(input),
    crypto: cryptoAdapter,
  })
}

function buildListenerDeps(
  recipient: PublicIdentitySession,
  saveIncomingAttestation: AttestationListenerDeps['attestationService']['saveIncomingAttestation'],
): { deps: AttestationListenerDeps; triggerAttestationDialog: ReturnType<typeof vi.fn> } {
  const triggerAttestationDialog = vi.fn()
  const deps: AttestationListenerDeps = {
    attestationService: {
      decodeIncomingAttestation: decodeStub,
      saveIncomingAttestation,
    },
    verificationWorkflow: {
      acceptVerifiedVerificationAttestation: () => { throw new Error('not used in this test') },
      acceptVerifiedCounterVerification: () => { throw new Error('not used in this test') },
    },
    getLocalDid: () => recipient.getDid(),
    getLocalIdentity: () => recipient as unknown as IdentitySession,
    findContactName: () => undefined,
    setChallengeNonce: vi.fn(),
    setPendingIncoming: vi.fn(),
    triggerAttestationDialog,
  }
  return { deps, triggerAttestationDialog }
}

describe('AttestationListener am echten InboxReceptionHost (M-A)', () => {
  it('transienter Storage-Fehler → kein ack, kein record; die Redelivery wird angewendet', async () => {
    const sender = await createIdentity('wire-sender-1')
    const recipient = await createIdentity('wire-recipient-1')
    const messaging = createMessagingStub()
    const host = new InboxReceptionHost({
      messaging: messaging.adapter,
      identity: recipient,
      crypto: cryptoAdapter,
    })
    host.start()

    let transientFailures = 1
    const saved: Attestation[] = []
    const { deps, triggerAttestationDialog } = buildListenerDeps(recipient, async (attestation) => {
      if (transientFailures-- > 0) throw new Error('storage offline')
      saved.push(attestation)
      return attestation
    })
    host.onAttestation(createAttestationListener(deps))

    const envelope = await buildDelivery(sender, recipient)
    await messaging.deliver(envelope)

    // K1: transient → processing-incomplete → KEIN ack (Redelivery-Pfad).
    expect(acks(messaging.sent)).toHaveLength(0)
    expect(saved).toHaveLength(0)
    expect(triggerAttestationDialog).not.toHaveBeenCalled()

    // Relay-Redelivery: kein record beim Fehlschlag → kein Replay; die
    // Anwendung gelingt jetzt → genau ein ack (Recovery-Beweis).
    await messaging.deliver(envelope)
    expect(saved).toHaveLength(1)
    expect(acks(messaging.sent)).toHaveLength(1)
    expect(acks(messaging.sent)[0].thid).toBe(envelope.id)
    expect(triggerAttestationDialog).toHaveBeenCalledTimes(1)
  })

  it('deterministisches Duplikat → konklusiv: ack, kein Dialog', async () => {
    const sender = await createIdentity('wire-sender-2')
    const recipient = await createIdentity('wire-recipient-2')
    const messaging = createMessagingStub()
    const host = new InboxReceptionHost({
      messaging: messaging.adapter,
      identity: recipient,
      crypto: cryptoAdapter,
    })
    host.start()

    const { deps, triggerAttestationDialog } = buildListenerDeps(recipient, async (attestation) => {
      throw new DuplicateAttestationError(attestation.id)
    })
    host.onAttestation(createAttestationListener(deps))

    const envelope = await buildDelivery(sender, recipient)
    await messaging.deliver(envelope)

    // Duplikat ist konklusiv → der Host ackt (Queue-Hygiene), kein Dialog.
    expect(acks(messaging.sent)).toHaveLength(1)
    expect(acks(messaging.sent)[0].thid).toBe(envelope.id)
    expect(triggerAttestationDialog).not.toHaveBeenCalled()
  })
})
