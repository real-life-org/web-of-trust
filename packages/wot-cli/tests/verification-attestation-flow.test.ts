import { describe, expect, it } from 'vitest'
import { AttestationWorkflow, IdentityWorkflow, type PublicIdentitySession } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { Attestation, Contact, Identity, MessageEnvelope } from '@web_of_trust/core/types'
import type { ReactiveStorageAdapter, StorageAdapter } from '@web_of_trust/core/ports'
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
  sent: MessageEnvelope[] = []

  async send(envelope: MessageEnvelope): Promise<void> {
    this.sent.push(envelope)
  }
}

interface TestableWotCliClient {
  identity: PublicIdentitySession
  storage: MemoryCliStorage
  outboxAdapter: MemoryOutbox
  discovery: null
  handleIncomingAttestation(envelope: MessageEnvelope): Promise<void>
}

async function createIdentity(passphrase: string): Promise<PublicIdentitySession> {
  return (await new IdentityWorkflow({ crypto: cryptoAdapter }).createIdentity({
    passphrase,
    storeSeed: false,
  })).identity
}

function createClient(identity: PublicIdentitySession, name: string): {
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
    discovery: null,
  })

  return { client, storage, outbox }
}

describe('WotCliClient Trust 002 verification-attestation delivery', () => {
  it('counter-verifies an incoming verification-attestation without legacy Verification storage', async () => {
    const aliceIdentity = await createIdentity('cli-alice')
    const bobIdentity = await createIdentity('cli-bob')
    const alice = createClient(aliceIdentity, 'Alice')
    const bob = createClient(bobIdentity, 'Bob')

    const challenge = await alice.client.createChallenge()
    await bob.client.respondToChallenge(challenge.code)

    const verificationEnvelope = bob.outbox.sent.find((envelope) => envelope.type === 'attestation')
    expect(verificationEnvelope).toBeDefined()

    await (alice.client as unknown as TestableWotCliClient).handleIncomingAttestation(verificationEnvelope!)

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

    const sentTypes = alice.outbox.sent.map((envelope) => envelope.type)
    expect(sentTypes).toEqual(['attestation'])

    const counterEnvelope = alice.outbox.sent[0]
    expect(counterEnvelope).toMatchObject({
      type: 'attestation',
      fromDid: aliceIdentity.getDid(),
      toDid: bobIdentity.getDid(),
    })

    const workflow = new AttestationWorkflow({ crypto: cryptoAdapter })
    await expect(workflow.verifyAttestation(JSON.parse(counterEnvelope.payload) as Attestation)).resolves.toBe(true)
  })
})
