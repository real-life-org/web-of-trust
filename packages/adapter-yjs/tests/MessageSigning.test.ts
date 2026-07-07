import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity, testCryptoAdapter } from '../../wot-core/tests/helpers/identity-session'
import { InMemoryMessagingAdapter, InMemorySpaceMetadataStorage, InMemoryCompactStore, InMemoryKeyManagementAdapter, InMemoryMessageIdHistory } from '@web_of_trust/core/adapters'
import { verifyEnvelope } from '@web_of_trust/core/crypto'
import {
  assertEncryptedInboxEnvelope, createDidKeyResolver, decodeBase64Url, isDidcommMessage,
  SPACE_INVITE_MESSAGE_TYPE, MEMBER_UPDATE_MESSAGE_TYPE, KEY_ROTATION_MESSAGE_TYPE,
} from '@web_of_trust/core/protocol'
import type { DidcommPlaintextMessage, EciesMessage } from '@web_of_trust/core/protocol'
import { receiveInboxMessage } from '@web_of_trust/core/application'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'
import type { WireMessage } from '@web_of_trust/core/ports'
import type { MessageEnvelope } from '@web_of_trust/core/types'

const wait = (ms = 300) => new Promise(r => setTimeout(r, ms))

interface TestDoc {
  items: Record<string, { title: string }>
}

// Authentizität pro Message-Typ (Sync 003 Z.408-426): content bleibt Old-World
// mit Envelope-Signatur; die 3 Membership-Typen sind encrypted DIDComm-Envelopes,
// deren Authentizität der Inner-JWS im ECIES-Body trägt (kein Envelope-JWS).

describe('Message authenticity — every message leaving the device is signed or inner-JWS-bound', () => {
  let alice: PublicIdentitySession
  let bob: PublicIdentitySession
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: YjsReplicationAdapter
  let bobAdapter: YjsReplicationAdapter

  // Capture all messages sent by Alice
  const sentMessages: WireMessage[] = []

  /** receiveInboxMessage gegen Bobs Identity — beweist Inner-JWS-Authentizität. */
  function receiveAsBob(message: unknown) {
    return receiveInboxMessage({
      message,
      ownDid: bob.getDid(),
      decryptEcies: (ecies: EciesMessage) => bob.decryptForMe({
        ephemeralPublicKey: decodeBase64Url(ecies.epk),
        nonce: decodeBase64Url(ecies.nonce),
        ciphertext: decodeBase64Url(ecies.ciphertext),
      }),
      crypto: testCryptoAdapter,
      didResolver: createDidKeyResolver(),
      messageIdHistory: new InMemoryMessageIdHistory(),
    })
  }

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    sentMessages.length = 0

    alice = (await createTestIdentity('alice-pass')).identity
    bob = (await createTestIdentity('bob-pass')).identity

    aliceMessaging = new InMemoryMessagingAdapter()
    bobMessaging = new InMemoryMessagingAdapter()

    // Intercept all messages from Bob's side to capture what Alice sends
    const origBobOnMessage = bobMessaging.onMessage.bind(bobMessaging)
    bobMessaging.onMessage = (cb) => {
      return origBobOnMessage(async (envelope) => {
        sentMessages.push(envelope)
        await cb(envelope)
      })
    }

    // Also capture self-messages (multi-device)
    const origAliceOnMessage = aliceMessaging.onMessage.bind(aliceMessaging)
    aliceMessaging.onMessage = (cb) => {
      return origAliceOnMessage(async (envelope) => {
        sentMessages.push(envelope)
        await cb(envelope)
      })
    }

    await aliceMessaging.connect(alice.getDid())
    await bobMessaging.connect(bob.getDid())

    aliceAdapter = new YjsReplicationAdapter({
      identity: alice,
      messaging: aliceMessaging,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: new InMemorySpaceMetadataStorage(),
      compactStore: new InMemoryCompactStore(),
    })
    bobAdapter = new YjsReplicationAdapter({
      identity: bob,
      messaging: bobMessaging,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: new InMemorySpaceMetadataStorage(),
    })

    await aliceAdapter.start()
    await bobAdapter.start()
  })

  afterEach(async () => {
    await aliceAdapter.stop()
    await bobAdapter.stop()
    InMemoryMessagingAdapter.resetAll()
    try { await alice.deleteStoredIdentity() } catch {}
    try { await bob.deleteStoredIdentity() } catch {}
  })

  async function setupSpaceWithBob(): Promise<string> {
    const space = await aliceAdapter.createSpace<TestDoc>(
      'shared', { items: {} }, { name: 'Test', members: [alice.getDid()] },
    )
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait()
    return space.id
  }

  it('should sign content (space update) messages', async () => {
    const spaceId = await setupSpaceWithBob()
    sentMessages.length = 0

    // Alice writes → triggers sendEncryptedUpdate
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    handle.transact(doc => { doc.items['t1'] = { title: 'test' } })
    await wait()

    const contentMessages = sentMessages.filter(
      (m): m is MessageEnvelope => !isDidcommMessage(m) && m.type === 'content',
    )
    expect(contentMessages.length).toBeGreaterThan(0)

    for (const msg of contentMessages) {
      expect(msg.signature).toBeTruthy()
      expect(await verifyEnvelope(msg)).toBe(true)
    }

    handle.close()
  })

  it('member-update: encrypted DIDComm-Envelope, Inner-JWS verifiziert auf alice', async () => {
    const spaceId = await setupSpaceWithBob()
    sentMessages.length = 0

    // Alice removes Bob → sends member-update
    await aliceAdapter.removeMember(spaceId, bob.getDid())
    await wait()

    const memberUpdates = sentMessages.filter(
      (m): m is DidcommPlaintextMessage => isDidcommMessage(m) && m.type === MEMBER_UPDATE_MESSAGE_TYPE,
    )
    expect(memberUpdates.length).toBeGreaterThan(0)

    for (const msg of memberUpdates) {
      expect(() => assertEncryptedInboxEnvelope(msg, MEMBER_UPDATE_MESSAGE_TYPE)).not.toThrow()
      const result = await receiveAsBob(msg)
      expect(result.decision).toBe('accept')
      if (result.decision !== 'accept') throw new Error('unreachable')
      // Authentizität: senderDid = Inner-JWS-Signer, nicht Envelope-Routing.
      expect(result.senderDid).toBe(alice.getDid())
      expect(result.body).toMatchObject({ spaceId, action: 'removed', memberDid: bob.getDid() })
    }
  })

  it('space-invite: encrypted DIDComm-Envelope, Inner-JWS verifiziert auf alice', async () => {
    sentMessages.length = 0
    await setupSpaceWithBob()

    const invites = sentMessages.filter(
      (m): m is DidcommPlaintextMessage => isDidcommMessage(m) && m.type === SPACE_INVITE_MESSAGE_TYPE,
    )
    expect(invites.length).toBeGreaterThan(0)

    for (const msg of invites) {
      expect(() => assertEncryptedInboxEnvelope(msg, SPACE_INVITE_MESSAGE_TYPE)).not.toThrow()
      const result = await receiveAsBob(msg)
      expect(result.decision).toBe('accept')
      if (result.decision !== 'accept') throw new Error('unreachable')
      expect(result.senderDid).toBe(alice.getDid())
    }
  })

  it('key-rotation: encrypted DIDComm-Envelope, Inner-JWS verifiziert auf alice', async () => {
    const spaceId = await setupSpaceWithBob()
    sentMessages.length = 0

    await aliceAdapter.removeMember(spaceId, bob.getDid())
    await wait()

    const rotations = sentMessages.filter(
      (m): m is DidcommPlaintextMessage => isDidcommMessage(m) && m.type === KEY_ROTATION_MESSAGE_TYPE,
    )
    expect(rotations.length).toBeGreaterThan(0)

    for (const msg of rotations) {
      expect(() => assertEncryptedInboxEnvelope(msg, KEY_ROTATION_MESSAGE_TYPE)).not.toThrow()
      // key-rotation geht an die VERBLEIBENDEN Member — nach removeMember(bob) ist
      // das nur noch alice selbst (multi-device); Inner-JWS-Verify gegen die
      // Empfänger-DID aus dem Envelope.
      expect(msg.to).toEqual([alice.getDid()])
    }
  })

  it('member-update: kein Klartext-Body auf dem Wire (ECIES-Container, C6-Analog)', async () => {
    const spaceId = await setupSpaceWithBob()
    sentMessages.length = 0

    await aliceAdapter.removeMember(spaceId, bob.getDid())
    await wait()

    const memberUpdates = sentMessages.filter(
      (m): m is DidcommPlaintextMessage => isDidcommMessage(m) && m.type === MEMBER_UPDATE_MESSAGE_TYPE,
    )
    expect(memberUpdates.length).toBeGreaterThan(0)

    for (const msg of memberUpdates) {
      expect(Object.keys(msg.body).sort()).toEqual(['ciphertext', 'epk', 'nonce'])
      const wireJson = JSON.stringify(msg)
      expect(wireJson).not.toContain('"action"')
      expect(wireJson).not.toContain('"memberDid"')
      expect(wireJson).not.toContain('"removed"')
    }
  })
})
