/**
 * wot#386: Profiländerungen reisen verschlüsselt als inbox/1.0 an die Kontakte
 * (statt als Old-World-`profile-update`, den das Relay verwirft) und tragen das
 * Profil selbst. Ende zu Ende: Versand über den AttestationService, Empfang
 * im echten InboxReceptionHost, Übernahme durch den Listener.
 */
import { describe, it, expect, vi } from 'vitest'
import { IdentityWorkflow, type PublicIdentitySession } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { INBOX_MESSAGE_TYPE, isDidcommMessage } from '@web_of_trust/core/protocol'
import type { MessagingAdapter, WireMessage } from '@web_of_trust/core/ports'
import type { Contact, IdentitySession } from '@web_of_trust/core/types'
import { AttestationService, type AttestationStoragePort } from '../src/services/AttestationService'
import { InboxReceptionHost } from '../src/services/InboxReceptionHost'
import { createProfileUpdateListener } from '../src/services/profileUpdateListener'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

async function createIdentity(passphrase: string): Promise<PublicIdentitySession> {
  return (await new IdentityWorkflow({ crypto: cryptoAdapter }).createIdentity({ passphrase, storeSeed: false })).identity
}

function messagingStub() {
  const sent: WireMessage[] = []
  let handler: ((message: WireMessage) => void | Promise<void>) | null = null
  const adapter = {
    send: vi.fn(async (message: WireMessage) => {
      sent.push(message)
      return { messageId: message.id, status: 'accepted' as const, timestamp: new Date().toISOString() }
    }),
    onMessage: (cb: (message: WireMessage) => void | Promise<void>) => { handler = cb; return () => { handler = null } },
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
    deliver: async (message: WireMessage) => { await handler?.(message) },
  }
}

const noAttestations: AttestationStoragePort = {
  saveAttestation: async () => {},
  getReceivedAttestations: async () => [],
  getAttestation: async () => null,
  setAttestationAccepted: async () => {},
}

describe('profile-update delivery (wot#386)', () => {
  it('sends the profile encrypted as inbox/1.0 and the contact takes it over', async () => {
    const anna = await createIdentity('profile-anna')
    const ben = await createIdentity('profile-ben')

    const annaMessaging = messagingStub()
    const service = new AttestationService(noAttestations)
    service.setMessaging(annaMessaging.adapter)
    service.configureDelivery({
      identity: anna as unknown as IdentitySession,
      resolveRecipientEncryptionKey: async (did) => (did === ben.getDid() ? ben.x25519PublicKey : null),
    })

    await service.sendProfileUpdate(ben.getDid(), {
      did: anna.getDid(),
      name: 'Anna',
      bio: 'Gärtnerin',
      updatedAt: '2026-10-01T12:00:00.000Z',
    })

    expect(annaMessaging.sent).toHaveLength(1)
    const wire = annaMessaging.sent[0]
    expect(isDidcommMessage(wire) && wire.type).toBe(INBOX_MESSAGE_TYPE)
    expect(JSON.stringify(wire)).not.toContain('Gärtnerin')

    // Ben empfängt im echten Host und übernimmt das Profil in seinen Kontakt.
    const benContacts = new Map<string, Contact>([[anna.getDid(), {
      did: anna.getDid(), publicKey: 'z6Mk', name: 'Anna (alt)', status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }]])
    const benMessaging = messagingStub()
    const host = new InboxReceptionHost({ messaging: benMessaging.adapter, identity: ben, crypto: cryptoAdapter })
    host.start()
    host.onProfileUpdate(createProfileUpdateListener({
      storage: {
        getContact: async (did) => benContacts.get(did) ?? null,
        updateContact: async (contact) => { benContacts.set(contact.did, contact) },
      },
    }))
    await benMessaging.deliver(wire)

    expect(benContacts.get(anna.getDid())).toMatchObject({ name: 'Anna', bio: 'Gärtnerin', profileUpdatedAt: '2026-10-01T12:00:00.000Z' })
  })

  it('fails loudly when the contact has no published encryption key (no plaintext fallback)', async () => {
    const anna = await createIdentity('profile-anna-2')
    const service = new AttestationService(noAttestations)
    service.setMessaging(messagingStub().adapter)
    service.configureDelivery({ identity: anna as unknown as IdentitySession, resolveRecipientEncryptionKey: async () => null })

    await expect(service.sendProfileUpdate('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', {
      name: 'Anna', updatedAt: '2026-10-01T12:00:00.000Z',
    })).rejects.toThrow(/encryption key/)
  })
})
