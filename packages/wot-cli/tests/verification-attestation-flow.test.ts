import { describe, expect, it } from 'vitest'
import { AttestationWorkflow, IdentityWorkflow, receiveInboxMessage, type PublicIdentitySession } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import {
  ACK_MESSAGE_TYPE,
  INBOX_MESSAGE_TYPE,
  assertAttestationDeliveryBody,
  createDidKeyResolver,
  decodeBase64Url,
  isDidcommMessage,
  resolveDidKey,
  x25519PublicKeyToMultibase,
} from '@web_of_trust/core/protocol'
import type { DidcommPlaintextMessage } from '@web_of_trust/core/protocol'
import { InMemoryMessageIdHistory } from '@web_of_trust/core/adapters'
import type { Attestation, Contact, Identity } from '@web_of_trust/core/types'
import type { ReactiveStorageAdapter, StorageAdapter, WireMessage } from '@web_of_trust/core/ports'
import { WotCliClient } from '../src/WotCliClient.js'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

class MemoryCliStorage implements StorageAdapter, Partial<ReactiveStorageAdapter> {
  identity: Identity
  contacts: Contact[] = []
  attestations: Attestation[] = []

  constructor(identity: PublicIdentitySession, name: string) {
    this.identity = {
      did: identity.getDid(),
      profile: { name },
      createdAt: '2026-05-27T10:00:00Z',
      updatedAt: '2026-05-27T10:00:00Z',
    }
  }

  async createIdentity(_did: string, _profile: Identity['profile']): Promise<Identity> {
    return this.identity
  }

  async getIdentity(): Promise<Identity | null> {
    return this.identity
  }

  async updateIdentity(identity: Identity): Promise<void> {
    this.identity = identity
  }

  async addContact(contact: Contact): Promise<void> {
    const existing = this.contacts.findIndex((candidate) => candidate.did === contact.did)
    if (existing >= 0) {
      this.contacts[existing] = contact
    } else {
      this.contacts.push(contact)
    }
  }

  async getContacts(): Promise<Contact[]> {
    return [...this.contacts]
  }

  async getContact(did: string): Promise<Contact | null> {
    return this.contacts.find((contact) => contact.did === did) ?? null
  }

  async updateContact(contact: Contact): Promise<void> {
    await this.addContact(contact)
  }

  async removeContact(did: string): Promise<void> {
    this.contacts = this.contacts.filter((contact) => contact.did !== did)
  }

  async saveAttestation(attestation: Attestation): Promise<void> {
    this.attestations.push(attestation)
  }

  async getReceivedAttestations(): Promise<Attestation[]> {
    return [...this.attestations]
  }

  async getAttestation(id: string): Promise<Attestation | null> {
    return this.attestations.find((attestation) => attestation.id === id) ?? null
  }

  async getAttestationMetadata(): Promise<null> {
    return null
  }

  async setAttestationAccepted(): Promise<void> {}

  async init(): Promise<void> {}

  async clear(): Promise<void> {
    this.contacts = []
    this.attestations = []
  }
}

class MemoryOutbox {
  sent: WireMessage[] = []

  async send(message: WireMessage): Promise<void> {
    this.sent.push(message)
  }
}

/** Discovery-Stub: liefert das DID-Dokument mit keyAgreement (Sync 004) pro DID. */
function createDiscoveryStub(identities: PublicIdentitySession[]) {
  const byDid = new Map(identities.map((identity) => [identity.getDid(), identity]))
  return {
    async resolveProfile(did: string) {
      const identity = byDid.get(did)
      if (!identity) return { profile: null, didDocument: null }
      return {
        profile: null,
        didDocument: resolveDidKey(did, {
          keyAgreement: [{
            id: '#enc-0',
            type: 'X25519KeyAgreementKey2020',
            controller: did,
            publicKeyMultibase: x25519PublicKeyToMultibase(identity.x25519PublicKey),
          }],
        }),
      }
    },
  }
}

interface TestableWotCliClient {
  identity: PublicIdentitySession
  storage: MemoryCliStorage
  outboxAdapter: MemoryOutbox
  discovery: ReturnType<typeof createDiscoveryStub>
  handleInboxMessage(message: DidcommPlaintextMessage<object>): Promise<void>
}

async function createIdentity(passphrase: string): Promise<PublicIdentitySession> {
  return (await new IdentityWorkflow({ crypto: cryptoAdapter }).createIdentity({
    passphrase,
    storeSeed: false,
  })).identity
}

function createClient(
  identity: PublicIdentitySession,
  name: string,
  discovery: ReturnType<typeof createDiscoveryStub>,
): {
  client: WotCliClient
  storage: MemoryCliStorage
  outbox: MemoryOutbox
} {
  const client = new WotCliClient({ seedPath: `/tmp/${name}.seed` })
  const storage = new MemoryCliStorage(identity, name)
  const outbox = new MemoryOutbox()

  Object.assign(client as unknown as TestableWotCliClient, {
    identity,
    storage,
    outboxAdapter: outbox,
    discovery,
  })

  return { client, storage, outbox }
}

function inboxMessages(outbox: MemoryOutbox): DidcommPlaintextMessage<object>[] {
  return outbox.sent.filter(
    (message): message is DidcommPlaintextMessage<object> =>
      isDidcommMessage(message) && message.type === INBOX_MESSAGE_TYPE,
  )
}

function ackMessages(outbox: MemoryOutbox): DidcommPlaintextMessage<object>[] {
  return outbox.sent.filter(
    (message): message is DidcommPlaintextMessage<object> =>
      isDidcommMessage(message) && message.type === ACK_MESSAGE_TYPE,
  )
}

/** Entschlüsselt + verifiziert eine inbox/1.0-Zustellung aus Empfänger-Sicht. */
async function receiveAsRecipient(message: unknown, recipient: PublicIdentitySession) {
  return receiveInboxMessage({
    message,
    ownDid: recipient.getDid(),
    decryptEcies: (ecies) => recipient.decryptForMe({
      ephemeralPublicKey: decodeBase64Url(ecies.epk),
      nonce: decodeBase64Url(ecies.nonce),
      ciphertext: decodeBase64Url(ecies.ciphertext),
    }),
    crypto: cryptoAdapter,
    didResolver: createDidKeyResolver(),
    messageIdHistory: new InMemoryMessageIdHistory(),
  })
}

describe('WotCliClient inbox/1.0 attestation delivery (K2/K3)', () => {
  it('counter-verifies an incoming verification-attestation over the DIDComm inbox wire and acks it', async () => {
    const aliceIdentity = await createIdentity('cli-alice')
    const bobIdentity = await createIdentity('cli-bob')
    const discovery = createDiscoveryStub([aliceIdentity, bobIdentity])
    const alice = createClient(aliceIdentity, 'Alice', discovery)
    const bob = createClient(bobIdentity, 'Bob', discovery)

    const challenge = await alice.client.createChallenge()
    await bob.client.respondToChallenge(challenge.code)

    // K2-Wire-Vertrag: Versand als DIDComm inbox/1.0, Body = ECIES-Container.
    const verificationEnvelopes = inboxMessages(bob.outbox)
    expect(verificationEnvelopes).toHaveLength(1)
    const verificationEnvelope = verificationEnvelopes[0]
    expect(verificationEnvelope.to).toEqual([aliceIdentity.getDid()])
    expect(Object.keys(verificationEnvelope.body)).toEqual(
      expect.arrayContaining(['epk', 'nonce', 'ciphertext']),
    )
    // Kein Klartext-Attestation-Objekt im Wire-Body (K2).
    expect(JSON.stringify(verificationEnvelope.body)).not.toContain('"claim"')

    await (alice.client as unknown as TestableWotCliClient).handleInboxMessage(verificationEnvelope)

    const incoming = alice.storage.attestations.find((attestation) => attestation.from === bobIdentity.getDid())
    const counter = alice.storage.attestations.find((attestation) => attestation.from === aliceIdentity.getDid())
    expect(incoming).toBeDefined()
    expect(counter).toBeDefined()
    expect(incoming?.id).toBe(`urn:uuid:${challenge.nonce}`)
    expect(counter?.inResponseTo).toBe(incoming?.id)

    expect(alice.storage.contacts).toEqual([
      expect.objectContaining({
        did: bobIdentity.getDid(),
        status: 'active',
      }),
    ])

    // Counter-Attestation reist ebenfalls als inbox/1.0 an Bob.
    const counterEnvelopes = inboxMessages(alice.outbox)
    expect(counterEnvelopes).toHaveLength(1)
    expect(counterEnvelopes[0].to).toEqual([bobIdentity.getDid()])

    // ack/1.0 nach Anwendung (K1): thid = body.messageId = Original-id.
    const acks = ackMessages(alice.outbox)
    expect(acks).toHaveLength(1)
    expect(acks[0].thid).toBe(verificationEnvelope.id)
    expect((acks[0].body as { messageId: string }).messageId).toBe(verificationEnvelope.id)

    // Bob kann die Counter-Zustellung entschlüsseln, der Inner-JWS-Sender ist
    // Alice (Sync 003 Z.460-464), und der VC verifiziert.
    const received = await receiveAsRecipient(counterEnvelopes[0], bobIdentity)
    expect(received.decision).toBe('accept')
    if (received.decision !== 'accept') throw new Error('unreachable')
    expect(received.senderDid).toBe(aliceIdentity.getDid())
    assertAttestationDeliveryBody(received.body)
    const workflow = new AttestationWorkflow({ crypto: cryptoAdapter })
    const verifiedCounter = await workflow.importAttestation(received.body.vcJws)
    expect(verifiedCounter.from).toBe(aliceIdentity.getDid())
    expect(verifiedCounter.to).toBe(bobIdentity.getDid())
    expect(verifiedCounter.inResponseTo).toBe(incoming?.id)
  })

  it('does not ack an inbox message whose processing fails (K1) and acks replays', async () => {
    const aliceIdentity = await createIdentity('cli-alice-k1')
    const bobIdentity = await createIdentity('cli-bob-k1')
    const discovery = createDiscoveryStub([aliceIdentity, bobIdentity])
    const alice = createClient(aliceIdentity, 'Alice', discovery)
    const bob = createClient(bobIdentity, 'Bob', discovery)

    const challenge = await alice.client.createChallenge()
    await bob.client.respondToChallenge(challenge.code)
    const envelope = inboxMessages(bob.outbox)[0]

    // Manipulierter Ciphertext → decrypt-failed → KEIN ack/1.0 (Redelivery-Pfad).
    const body = envelope.body as Record<string, string>
    const tampered = {
      ...envelope,
      body: { ...body, ciphertext: body.ciphertext.slice(0, -2) + 'AA' },
    }
    await (alice.client as unknown as TestableWotCliClient).handleInboxMessage(
      tampered as unknown as DidcommPlaintextMessage<object>,
    )
    expect(ackMessages(alice.outbox)).toHaveLength(0)
    expect(alice.storage.attestations).toHaveLength(0)

    // Erste gültige Zustellung → genau ein ack.
    await (alice.client as unknown as TestableWotCliClient).handleInboxMessage(envelope)
    expect(ackMessages(alice.outbox)).toHaveLength(1)

    // Redelivery derselben Nachricht → Replay → ack (Sync 003 Z.619), keine
    // doppelte Anwendung.
    const attestationCountAfterFirst = alice.storage.attestations.length
    await (alice.client as unknown as TestableWotCliClient).handleInboxMessage(envelope)
    expect(ackMessages(alice.outbox)).toHaveLength(2)
    expect(alice.storage.attestations).toHaveLength(attestationCountAfterFirst)
  })

  it('M1: transienter Persistenz-Fehler → kein ack, keine History; die Redelivery wird angewendet', async () => {
    // Sync 003 Z.466 + Z.620-622: ein nicht-konklusiver Ausgang (Storage wirft
    // transient) darf die id nicht in die Message-ID-History schreiben — sonst
    // endet die Relay-Redelivery als Replay mit duplicate-known-ack und die
    // Zustellung ist endgültig verloren.
    const aliceIdentity = await createIdentity('cli-alice-m1')
    const bobIdentity = await createIdentity('cli-bob-m1')
    const discovery = createDiscoveryStub([aliceIdentity, bobIdentity])
    const alice = createClient(aliceIdentity, 'Alice', discovery)
    const bob = createClient(bobIdentity, 'Bob', discovery)

    const challenge = await alice.client.createChallenge()
    await bob.client.respondToChallenge(challenge.code)
    const envelope = inboxMessages(bob.outbox)[0]

    let transientFailures = 1
    const originalSave = alice.storage.saveAttestation.bind(alice.storage)
    alice.storage.saveAttestation = async (attestation: Attestation) => {
      if (transientFailures-- > 0) throw new Error('storage offline')
      return originalSave(attestation)
    }

    await (alice.client as unknown as TestableWotCliClient).handleInboxMessage(envelope)
    expect(ackMessages(alice.outbox)).toHaveLength(0)
    expect(alice.storage.attestations.filter((a) => a.from === bobIdentity.getDid())).toHaveLength(0)

    // Redelivery: kein Replay (nichts recorded) → Anwendung gelingt → genau ein ack.
    await (alice.client as unknown as TestableWotCliClient).handleInboxMessage(envelope)
    expect(alice.storage.attestations.filter((a) => a.from === bobIdentity.getDid())).toHaveLength(1)
    expect(ackMessages(alice.outbox)).toHaveLength(1)
    expect(ackMessages(alice.outbox)[0].thid).toBe(envelope.id)
  })

  it('rejects inbox-family types on the generic old-world sendMessage path', async () => {
    const aliceIdentity = await createIdentity('cli-alice-guard')
    const discovery = createDiscoveryStub([aliceIdentity])
    const alice = createClient(aliceIdentity, 'Alice', discovery)

    await expect(
      alice.client.sendMessage('did:key:z6MkTarget', 'attestation', { claim: 'x' }),
    ).rejects.toThrow(/inbox message/)
  })
})
