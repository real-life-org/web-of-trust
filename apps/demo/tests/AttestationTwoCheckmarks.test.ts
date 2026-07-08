/**
 * Zwei-Häkchen-Zustellstatus (Variante A, App-Level Empfangs-Ack, E2EE).
 *
 * Häkchen 1 = `delivered` (Server hat sie, Transport-Receipt); Häkchen 2 =
 * `acknowledged` (Empfänger-App hat verifiziert+gespeichert und einen
 * verschlüsselten `inbox/1.0`-Empfangs-Ack `{ kind:'attestation-receipt', jti,
 * status:'received' }` an die iss-DID zurückgeschickt).
 *
 * Kern-Regressionen:
 * - Der Empfangs-Ack sitzt IM Listener an den Save-Points — ein Reject
 *   (simulierter VC-Verify-Fail) sendet KEINEN Ack (ehrliche Semantik).
 * - Authentizität: nur der ursprüngliche Empfänger (attestation.to) kann das
 *   zweite Häkchen setzen — ein fremder Receipt-Sender wird ignoriert.
 */
import { describe, it, expect, vi } from 'vitest'
import { IdentityWorkflow, deliverInboxMessage, receiveInboxMessage, type PublicIdentitySession } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import {
  ACK_MESSAGE_TYPE,
  INBOX_MESSAGE_TYPE,
  createDidKeyResolver,
  decodeBase64Url,
  isAttestationReceiptBody,
  isDidcommMessage,
} from '@web_of_trust/core/protocol'
import type { AttestationVcPayload, DidcommPlaintextMessage } from '@web_of_trust/core/protocol'
import { InMemoryMessageIdHistory } from '@web_of_trust/core/adapters'
import type { MessagingAdapter, WireMessage } from '@web_of_trust/core/ports'
import type { Attestation, IdentitySession } from '@web_of_trust/core/types'
import {
  AttestationService,
  DuplicateAttestationError,
  type AttestationStoragePort,
} from '../src/services/AttestationService'
import { InboxReceptionHost } from '../src/services/InboxReceptionHost'
import { createAttestationListener, type AttestationListenerDeps } from '../src/services/attestationListener'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

const SENDER_DID = 'did:key:z6MkSender1234567890abcdefghijklmnopqrstuvwx'
const LOCAL_DID = 'did:key:z6MkLocal1234567890abcdefghijklmnopqrstuvwxyz'
const AID = 'urn:uuid:11111111-2222-4333-8444-555555555555'
const BARE = '11111111-2222-4333-8444-555555555555'
// Empfänger der (lokal ausgestellten) Attestation = legitimer Receipt-Absender.
const RECIPIENT_DID = 'did:key:z6MkRecipient234567890abcdefghijklmnopqrstu'
const IMPOSTER_DID = 'did:key:z6MkImposter234567890abcdefghijklmnopqrstuv'

function createMockStorage(): AttestationStoragePort {
  const attestations = new Map<string, Attestation>()
  return {
    saveAttestation: vi.fn(async (a: Attestation) => { attestations.set(a.id, a) }),
    getAttestation: vi.fn(async (id: string) => attestations.get(id) ?? null),
    getReceivedAttestations: vi.fn(async () => [...attestations.values()]),
    setAttestationAccepted: vi.fn(async () => {}),
  }
}

interface MessagingStub {
  sent: WireMessage[]
  adapter: MessagingAdapter
  deliver: (message: WireMessage) => Promise<void>
  emitReceipt: (receipt: { messageId: string; status: string }) => void
}

function createMessaging(): MessagingStub {
  const sent: WireMessage[] = []
  let msgHandler: ((message: WireMessage) => void | Promise<void>) | null = null
  let receiptHandler: ((receipt: { messageId: string; status: string }) => void) | null = null
  const adapter = {
    send: vi.fn(async (message: WireMessage) => {
      sent.push(message)
      return { messageId: message.id, status: 'accepted' as const, timestamp: new Date().toISOString() }
    }),
    onMessage: (cb: (message: WireMessage) => void | Promise<void>) => {
      msgHandler = cb
      return () => { msgHandler = null }
    },
    onReceipt: (cb: (receipt: { messageId: string; status: string }) => void) => {
      receiptHandler = cb
      return () => { receiptHandler = null }
    },
    getState: () => 'connected' as const,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    registerTransport: vi.fn(async () => {}),
    resolveTransport: vi.fn(async () => null),
  }
  return {
    sent,
    adapter: adapter as unknown as MessagingAdapter,
    deliver: async (message) => {
      if (!msgHandler) throw new Error('No onMessage handler registered')
      await msgHandler(message)
    },
    emitReceipt: (receipt) => { receiptHandler?.(receipt) },
  }
}

function inboxMessages(sent: WireMessage[]): DidcommPlaintextMessage<object>[] {
  return sent.filter(
    (m): m is DidcommPlaintextMessage<object> => isDidcommMessage(m) && m.type === INBOX_MESSAGE_TYPE,
  )
}

function ackMessages(sent: WireMessage[]): DidcommPlaintextMessage<object>[] {
  return sent.filter(
    (m): m is DidcommPlaintextMessage<object> => isDidcommMessage(m) && m.type === ACK_MESSAGE_TYPE,
  )
}

async function createIdentity(passphrase: string): Promise<PublicIdentitySession> {
  return (await new IdentityWorkflow({ crypto: cryptoAdapter }).createIdentity({
    passphrase,
    storeSeed: false,
  })).identity
}

// --- 1. AttestationService: Monotonie, Restore, markAcknowledged -----------

/** Ausgestellte (lokal gespeicherte) Attestation an RECIPIENT_DID seeden. */
async function seedIssuedAttestation(storage: AttestationStoragePort, to = RECIPIENT_DID): Promise<void> {
  await storage.saveAttestation({
    id: AID,
    from: LOCAL_DID,
    to,
    claim: 'Knows TypeScript',
    createdAt: '2026-06-10T10:00:00Z',
    vcJws: 'header.payload.signature',
  })
}

describe('AttestationService — Monotonie-Guard + zweites Häkchen', () => {
  it('delivered → acknowledged: Häkchen 2 setzt sich (legitimer Receipt-Sender)', async () => {
    const storage = createMockStorage()
    await seedIssuedAttestation(storage)
    const service = new AttestationService(storage)
    service.restoreDeliveryStatuses(new Map([[AID, 'delivered']]))
    await service.markAcknowledged(AID, RECIPIENT_DID)
    expect(service.getDeliveryStatus(AID)).toBe('acknowledged')
  })

  it('FÄLSCHUNGS-TEST: Receipt von fremder DID (≠ attestation.to) → KEIN acknowledged', async () => {
    // Der Inbox-Empfang authentifiziert nur den Absender, nicht dass er der
    // legitime Empfänger war. Ein Dritter mit bekannter jti darf das zweite
    // Häkchen NICHT fälschen.
    const storage = createMockStorage()
    await seedIssuedAttestation(storage)
    const service = new AttestationService(storage)
    service.restoreDeliveryStatuses(new Map([[AID, 'delivered']]))
    await service.markAcknowledged(AID, IMPOSTER_DID)
    expect(service.getDeliveryStatus(AID)).toBe('delivered')
  })

  it('acknowledged → delivered ist ein NO-OP (terminal-positiv)', () => {
    const messaging = createMessaging()
    const service = new AttestationService(createMockStorage())
    service.setMessaging(messaging.adapter)
    service.listenForReceipts(messaging.adapter)
    service.restoreDeliveryStatuses(new Map([[AID, 'acknowledged']]))

    // Ein spätes Relay-'delivered'-Receipt darf das zweite Häkchen NICHT downgraden.
    messaging.emitReceipt({ messageId: BARE, status: 'delivered' })
    expect(service.getDeliveryStatus(AID)).toBe('acknowledged')
  })

  it('failed ist aus acknowledged NICHT erreichbar', () => {
    const messaging = createMessaging()
    const service = new AttestationService(createMockStorage())
    service.setMessaging(messaging.adapter)
    service.listenForReceipts(messaging.adapter)
    service.restoreDeliveryStatuses(new Map([[AID, 'acknowledged']]))

    messaging.emitReceipt({ messageId: BARE, status: 'failed' })
    expect(service.getDeliveryStatus(AID)).toBe('acknowledged')
  })

  it('delivered → failed bleibt erlaubt (nicht-acknowledged)', () => {
    const messaging = createMessaging()
    const service = new AttestationService(createMockStorage())
    service.setMessaging(messaging.adapter)
    service.listenForReceipts(messaging.adapter)
    service.restoreDeliveryStatuses(new Map([[AID, 'delivered']]))

    messaging.emitReceipt({ messageId: BARE, status: 'failed' })
    expect(service.getDeliveryStatus(AID)).toBe('failed')
  })

  it('markAcknowledged ist ein No-op für eine unbekannte jti', async () => {
    const service = new AttestationService(createMockStorage())
    const unknown = 'urn:uuid:99999999-2222-4333-8444-555555555555'
    await service.markAcknowledged(unknown, RECIPIENT_DID)
    expect(service.getDeliveryStatus(unknown)).toBeUndefined()
  })

  it('restoreDeliveryStatuses akzeptiert acknowledged (Whitelist), verwirft Unbekanntes', () => {
    const service = new AttestationService(createMockStorage())
    service.restoreDeliveryStatuses(new Map([
      [AID, 'acknowledged'],
      ['urn:uuid:bogus', 'not-a-status'],
    ]))
    expect(service.getDeliveryStatus(AID)).toBe('acknowledged')
    expect(service.getDeliveryStatus('urn:uuid:bogus')).toBeUndefined()
  })
})

// --- 2. Listener: Empfangs-Ack an den Save-Points (Kern-Regression) --------

const NORMAL_PAYLOAD: AttestationVcPayload = {
  id: AID,
  type: ['VerifiableCredential', 'WotAttestation'],
  issuer: SENDER_DID,
  validFrom: '2026-06-10T10:00:00Z',
  iss: SENDER_DID,
  sub: LOCAL_DID,
  jti: AID,
  nbf: 1_760_000_000,
  credentialSubject: { id: LOCAL_DID, claim: 'Knows TypeScript' },
} as unknown as AttestationVcPayload

const VERIFICATION_PAYLOAD: AttestationVcPayload = {
  ...NORMAL_PAYLOAD,
  type: ['VerifiableCredential', 'WotAttestation', 'WotVerification'],
} as unknown as AttestationVcPayload

const NORMAL_ATTESTATION: Attestation = {
  id: AID,
  from: SENDER_DID,
  to: LOCAL_DID,
  claim: 'Knows TypeScript',
  createdAt: '2026-06-10T10:00:00Z',
  vcJws: 'header.payload.signature',
}

interface ListenerHarness {
  deps: AttestationListenerDeps
  sendReceiptAck: ReturnType<typeof vi.fn>
  saveIncomingAttestation: ReturnType<typeof vi.fn>
}

function makeListener(overrides: {
  payload?: AttestationVcPayload
  decodeThrows?: boolean
  saveThrows?: Error
  verificationDecision?: unknown
  counterDecision?: unknown
} = {}): ListenerHarness {
  const sendReceiptAck = vi.fn(async () => {})
  const saveIncomingAttestation = vi.fn(async (a: Attestation) => {
    if (overrides.saveThrows) throw overrides.saveThrows
    return a
  })
  const deps: AttestationListenerDeps = {
    attestationService: {
      decodeIncomingAttestation: vi.fn(async () => {
        if (overrides.decodeThrows) throw new Error('invalid VC (verify fail / clock skew)')
        return { attestation: NORMAL_ATTESTATION, payload: overrides.payload ?? NORMAL_PAYLOAD }
      }),
      saveIncomingAttestation,
      sendReceiptAck,
    },
    verificationWorkflow: {
      acceptVerifiedVerificationAttestation: () => overrides.verificationDecision as never,
      acceptVerifiedCounterVerification: () => overrides.counterDecision as never,
    },
    getLocalDid: () => LOCAL_DID,
    getLocalIdentity: () => ({} as IdentitySession),
    findContactName: () => undefined,
    setChallengeNonce: vi.fn(),
    setPendingIncoming: vi.fn(),
    triggerAttestationDialog: vi.fn(),
  }
  return { deps, sendReceiptAck, saveIncomingAttestation }
}

const DELIVERY = { vcJws: 'header.payload.signature', senderDid: SENDER_DID, outerId: 'urn-outer' }

describe('attestationListener — Empfangs-Ack nur nach Verify+Store', () => {
  it('normale Attestation akzeptiert → genau EIN Ack an die iss-DID', async () => {
    const { deps, sendReceiptAck } = makeListener()
    await createAttestationListener(deps)(DELIVERY)
    expect(sendReceiptAck).toHaveBeenCalledTimes(1)
    expect(sendReceiptAck).toHaveBeenCalledWith(SENDER_DID, AID)
  })

  it('REGRESSION: Verify-Fail (Reject) → KEIN Ack, kein Store', async () => {
    const { deps, sendReceiptAck, saveIncomingAttestation } = makeListener({ decodeThrows: true })
    await createAttestationListener(deps)(DELIVERY)
    expect(saveIncomingAttestation).not.toHaveBeenCalled()
    expect(sendReceiptAck).not.toHaveBeenCalled()
  })

  it('iss ≠ authentifizierter Inbox-Sender → KEIN Ack', async () => {
    const { deps, sendReceiptAck } = makeListener()
    await createAttestationListener(deps)({ ...DELIVERY, senderDid: 'did:key:z6MkEve0000000000000000000000000000000000000' })
    expect(sendReceiptAck).not.toHaveBeenCalled()
  })

  it('DuplicateAttestationError → Ack wird ERNEUT gesendet (Sender verpasste evtl. den ersten)', async () => {
    const { deps, sendReceiptAck } = makeListener({ saveThrows: new DuplicateAttestationError(AID) })
    await createAttestationListener(deps)(DELIVERY)
    expect(sendReceiptAck).toHaveBeenCalledTimes(1)
    expect(sendReceiptAck).toHaveBeenCalledWith(SENDER_DID, AID)
  })

  it('Verification accept-in-person → Ack', async () => {
    const { deps, sendReceiptAck } = makeListener({
      payload: VERIFICATION_PAYLOAD,
      verificationDecision: { decision: 'accept-in-person', nonce: 'n' },
    })
    await createAttestationListener(deps)(DELIVERY)
    expect(sendReceiptAck).toHaveBeenCalledTimes(1)
  })

  it('Verification reject-Decision → KEIN Ack (kein Store)', async () => {
    const { deps, sendReceiptAck, saveIncomingAttestation } = makeListener({
      payload: VERIFICATION_PAYLOAD,
      verificationDecision: { decision: 'reject', reason: 'challenge-expired' },
    })
    await createAttestationListener(deps)(DELIVERY)
    expect(saveIncomingAttestation).not.toHaveBeenCalled()
    expect(sendReceiptAck).not.toHaveBeenCalled()
  })

  it('best-effort: ein fehlgeschlagener Ack rollt den Store NICHT zurück', async () => {
    const { deps, saveIncomingAttestation } = makeListener()
    ;(deps.attestationService.sendReceiptAck as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no key'))
    await expect(createAttestationListener(deps)(DELIVERY)).resolves.toBeUndefined()
    expect(saveIncomingAttestation).toHaveBeenCalledTimes(1)
  })
})

// --- 3. Wire: AttestationService.sendReceiptAck erzeugt genau EINEN Receipt -

describe('AttestationService.sendReceiptAck — Wire-Form', () => {
  it('sendet genau EINEN inbox/1.0-Receipt an die iss-DID mit stabiler (deterministischer) ID', async () => {
    const issuer = await createIdentity('checkmarks-issuer')
    const recipient = await createIdentity('checkmarks-recipient')
    const messaging = createMessaging()
    const service = new AttestationService(createMockStorage())
    service.setMessaging(messaging.adapter)
    service.configureDelivery({
      identity: recipient,
      resolveRecipientEncryptionKey: async (did) =>
        did === issuer.getDid() ? issuer.x25519PublicKey : null,
    })

    await service.sendReceiptAck(issuer.getDid(), AID)
    const inbox = inboxMessages(messaging.sent)
    expect(inbox).toHaveLength(1)
    expect(inbox[0].to).toEqual([issuer.getDid()])

    // Der Aussteller kann ihn entschlüsseln; Body ist ein Empfangs-Ack für AID.
    const received = await receiveInboxMessage({
      message: inbox[0],
      ownDid: issuer.getDid(),
      decryptEcies: (ecies) => issuer.decryptForMe({
        ephemeralPublicKey: decodeBase64Url(ecies.epk),
        nonce: decodeBase64Url(ecies.nonce),
        ciphertext: decodeBase64Url(ecies.ciphertext),
      }),
      crypto: cryptoAdapter,
      didResolver: createDidKeyResolver(),
      messageIdHistory: new InMemoryMessageIdHistory(),
    })
    expect(received.decision).toBe('accept')
    if (received.decision !== 'accept') throw new Error('unreachable')
    expect(received.senderDid).toBe(recipient.getDid())
    expect(isAttestationReceiptBody(received.body)).toBe(true)
    expect((received.body as { jti: string }).jti).toBe(AID)

    // Stabile ID (RX-Dedup): erneuter Ack für dieselbe jti = identische Envelope-ID.
    await service.sendReceiptAck(issuer.getDid(), AID)
    const inbox2 = inboxMessages(messaging.sent)
    expect(inbox2).toHaveLength(2)
    expect(inbox2[1].id).toBe(inbox2[0].id)
  })

  it('ohne keyAgreement-Key des Ausstellers wirft sendReceiptAck (Listener behandelt best-effort)', async () => {
    const issuer = await createIdentity('checkmarks-nokey-issuer')
    const recipient = await createIdentity('checkmarks-nokey-recipient')
    const messaging = createMessaging()
    const service = new AttestationService(createMockStorage())
    service.setMessaging(messaging.adapter)
    service.configureDelivery({ identity: recipient, resolveRecipientEncryptionKey: async () => null })
    await expect(service.sendReceiptAck(issuer.getDid(), AID)).rejects.toThrow(/No encryption key/)
    expect(inboxMessages(messaging.sent)).toHaveLength(0)
  })
})

// --- 4. Empfänger-Host: Receipt-Routing + Sender-Seite acknowledged --------

async function buildReceipt(
  sender: PublicIdentitySession,
  recipient: PublicIdentitySession,
  jti: string,
): Promise<DidcommPlaintextMessage<object>> {
  return deliverInboxMessage({
    type: INBOX_MESSAGE_TYPE,
    body: { kind: 'attestation-receipt', jti, status: 'received' },
    from: sender.getDid(),
    to: recipient.getDid(),
    recipientEncryptionPublicKey: recipient.x25519PublicKey,
    sign: (input) => sender.signEd25519(input),
    crypto: cryptoAdapter,
  })
}

describe('InboxReceptionHost — Receipt-Pfad (Sender-Seite, zweites Häkchen)', () => {
  it('routet einen Receipt zum Receipt-Listener, NICHT zum Attestation-Listener (kein Ack-auf-Ack)', async () => {
    const issuer = await createIdentity('recv-issuer')       // = lokaler Sender (empfängt den Ack)
    const recipient = await createIdentity('recv-recipient') // Attestation-Empfänger, acked
    const messaging = createMessaging()
    const host = new InboxReceptionHost({ messaging: messaging.adapter, identity: issuer, crypto: cryptoAdapter })
    host.start()

    const storage = createMockStorage()
    await seedIssuedAttestation(storage, recipient.getDid())
    const service = new AttestationService(storage)
    service.restoreDeliveryStatuses(new Map([[AID, 'delivered']]))

    const attestationSpy = vi.fn()
    host.onAttestation(attestationSpy)
    host.onAttestationReceipt((receipt) => service.markAcknowledged(receipt.jti, receipt.senderDid))

    await messaging.deliver(await buildReceipt(recipient, issuer, AID))

    // Zweites Häkchen gesetzt; Attestation-Listener NICHT berührt.
    expect(service.getDeliveryStatus(AID)).toBe('acknowledged')
    expect(attestationSpy).not.toHaveBeenCalled()
    // Transport-ack (Queue-Hygiene) ja; ein App-Receipt (inbox/1.0) NEIN (kein Pingpong).
    expect(ackMessages(messaging.sent)).toHaveLength(1)
    expect(inboxMessages(messaging.sent)).toHaveLength(0)
  })

  it('ignoriert einen Receipt für eine unbekannte jti (markAcknowledged No-op), ackt aber transport-seitig', async () => {
    const issuer = await createIdentity('recv-issuer-2')
    const recipient = await createIdentity('recv-recipient-2')
    const messaging = createMessaging()
    const host = new InboxReceptionHost({ messaging: messaging.adapter, identity: issuer, crypto: cryptoAdapter })
    host.start()

    const service = new AttestationService(createMockStorage())
    service.restoreDeliveryStatuses(new Map([[AID, 'delivered']]))
    host.onAttestationReceipt((receipt) => service.markAcknowledged(receipt.jti, receipt.senderDid))

    const UNKNOWN = 'urn:uuid:abababab-2222-4333-8444-555555555555'
    await messaging.deliver(await buildReceipt(recipient, issuer, UNKNOWN))

    expect(service.getDeliveryStatus(UNKNOWN)).toBeUndefined()
    expect(service.getDeliveryStatus(AID)).toBe('delivered')
    // Konklusiv → Transport-ack (Queue-Hygiene).
    expect(ackMessages(messaging.sent)).toHaveLength(1)
  })

  it('puffert Receipts vor Listener-Registrierung und flusht sie beim Registrieren', async () => {
    const issuer = await createIdentity('recv-issuer-3')
    const recipient = await createIdentity('recv-recipient-3')
    const messaging = createMessaging()
    const host = new InboxReceptionHost({ messaging: messaging.adapter, identity: issuer, crypto: cryptoAdapter })
    host.start()

    const storage = createMockStorage()
    await seedIssuedAttestation(storage, recipient.getDid())
    const service = new AttestationService(storage)
    service.restoreDeliveryStatuses(new Map([[AID, 'delivered']]))

    // Receipt kommt VOR der Registrierung → gepuffert, kein ack, kein acknowledged.
    await messaging.deliver(await buildReceipt(recipient, issuer, AID))
    expect(service.getDeliveryStatus(AID)).toBe('delivered')
    expect(ackMessages(messaging.sent)).toHaveLength(0)

    // Registrierung flusht den Puffer (async: markAcknowledged + Transport-ack).
    const unsub = host.onAttestationReceipt((receipt) => service.markAcknowledged(receipt.jti, receipt.senderDid))
    await vi.waitFor(() => {
      expect(service.getDeliveryStatus(AID)).toBe('acknowledged')
      expect(ackMessages(messaging.sent)).toHaveLength(1)
    })
    unsub()
  })
})

// --- 5. Host + echter Listener: Reject sendet keinen App-Receipt -----------

/** Fake generischer VC-JWS mit echten DIDs (der Host verifiziert nur den Inner-JWS). */
function makeVcJws(fromDid: string, toDid: string): string {
  return `header.${Buffer.from(JSON.stringify({
    id: AID,
    type: ['VerifiableCredential', 'WotAttestation'],
    issuer: fromDid,
    validFrom: '2026-06-10T10:00:00Z',
    iss: fromDid,
    sub: toDid,
    jti: AID,
    credentialSubject: { id: toDid, claim: 'Knows TypeScript' },
  })).toString('base64url')}.signature`
}

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

describe('InboxReceptionHost + echter Listener — App-Receipt nur bei erfolgreichem Empfang', () => {
  function buildRealListener(recipient: PublicIdentitySession) {
    const sendReceiptAck = vi.fn(async () => {})
    const deps: AttestationListenerDeps = {
      attestationService: {
        decodeIncomingAttestation: decodeStub,
        saveIncomingAttestation: async (a) => a,
        sendReceiptAck,
      },
      verificationWorkflow: {
        acceptVerifiedVerificationAttestation: () => { throw new Error('not used') },
        acceptVerifiedCounterVerification: () => { throw new Error('not used') },
      },
      getLocalDid: () => recipient.getDid(),
      getLocalIdentity: () => recipient as unknown as IdentitySession,
      findContactName: () => undefined,
      setChallengeNonce: vi.fn(),
      setPendingIncoming: vi.fn(),
      triggerAttestationDialog: vi.fn(),
    }
    return { deps, sendReceiptAck }
  }

  it('gültige Zustellung → genau EIN App-Receipt; getamperte (Reject) → KEINER', async () => {
    const sender = await createIdentity('e2e-sender')
    const recipient = await createIdentity('e2e-recipient')
    const messaging = createMessaging()
    const host = new InboxReceptionHost({ messaging: messaging.adapter, identity: recipient, crypto: cryptoAdapter })
    host.start()
    const { deps, sendReceiptAck } = buildRealListener(recipient)
    host.onAttestation(createAttestationListener(deps))

    const envelope = await deliverInboxMessage({
      type: INBOX_MESSAGE_TYPE,
      body: { vcJws: makeVcJws(sender.getDid(), recipient.getDid()) },
      from: sender.getDid(),
      to: recipient.getDid(),
      recipientEncryptionPublicKey: recipient.x25519PublicKey,
      sign: (input) => sender.signEd25519(input),
      crypto: cryptoAdapter,
    })

    await messaging.deliver(envelope)
    expect(sendReceiptAck).toHaveBeenCalledTimes(1)
    expect(sendReceiptAck).toHaveBeenCalledWith(sender.getDid(), AID)

    // Host-Reject VOR dem Listener: getamperter Ciphertext → decrypt-failed →
    // der Listener läuft gar nicht → KEIN App-Receipt. Das deckt den
    // Host-seitigen Reject-Zweig ab (Decrypt/Inner-JWS/Replay/Clock-Skew laufen
    // alle hier). Der VC-spezifische Verify-Fail-Reject ist separat getestet
    // ("REGRESSION: Verify-Fail (Reject) → KEIN Ack, kein Store").
    sendReceiptAck.mockClear()
    const body = envelope.body as Record<string, string>
    const tampered = { ...envelope, body: { ...body, ciphertext: body.ciphertext.slice(0, -2) + 'AA' } }
    await messaging.deliver(tampered as unknown as DidcommPlaintextMessage<object>)
    expect(sendReceiptAck).not.toHaveBeenCalled()
  })
})
