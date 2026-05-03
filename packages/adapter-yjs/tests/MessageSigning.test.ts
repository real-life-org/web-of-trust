import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WotIdentity } from '@web_of_trust/core/application'
import { InMemoryMessagingAdapter, InMemorySpaceMetadataStorage, InMemoryCompactStore } from '@web_of_trust/core/adapters'
import { GroupKeyService } from '@web_of_trust/core/services'
import { verifyEnvelope } from '@web_of_trust/core/crypto'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'
import type { MessageEnvelope } from '@web_of_trust/core/types'

const wait = (ms = 300) => new Promise(r => setTimeout(r, ms))

interface TestDoc {
  items: Record<string, { title: string }>
}

describe('Message Signing — All messages leaving the device must be signed', () => {
  let alice: WotIdentity
  let bob: WotIdentity
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: YjsReplicationAdapter
  let bobAdapter: YjsReplicationAdapter

  // Capture all messages sent by Alice
  const sentMessages: MessageEnvelope[] = []

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    sentMessages.length = 0

    alice = new WotIdentity()
    bob = new WotIdentity()
    await alice.create('alice-pass', false)
    await bob.create('bob-pass', false)

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
      groupKeyService: new GroupKeyService(),
      metadataStorage: new InMemorySpaceMetadataStorage(),
      compactStore: new InMemoryCompactStore(),
    })
    bobAdapter = new YjsReplicationAdapter({
      identity: bob,
      messaging: bobMessaging,
      groupKeyService: new GroupKeyService(),
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

  it('should sign content (space update) messages', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>(
      'shared', { items: {} }, { name: 'Test', members: [alice.getDid()] },
    )
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait()
    sentMessages.length = 0

    // Alice writes → triggers sendEncryptedUpdate
    const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
    handle.transact(doc => { doc.items['t1'] = { title: 'test' } })
    await wait()

    const contentMessages = sentMessages.filter(m => m.type === 'content')
    expect(contentMessages.length).toBeGreaterThan(0)

    for (const msg of contentMessages) {
      expect(msg.signature).toBeTruthy()
      expect(await verifyEnvelope(msg)).toBe(true)
    }

    handle.close()
  })

  it('should sign member-update messages', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>(
      'shared', { items: {} }, { name: 'Test', members: [alice.getDid()] },
    )
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait()
    sentMessages.length = 0

    // Alice removes Bob → sends member-update
    await aliceAdapter.removeMember(space.id, bob.getDid())
    await wait()

    const memberUpdateMessages = sentMessages.filter(m =>
      m.type === 'member-update' || (typeof m.payload === 'string' && m.payload.includes('"removed"'))
    )
    expect(memberUpdateMessages.length).toBeGreaterThan(0)

    for (const msg of memberUpdateMessages) {
      expect(msg.signature).toBeTruthy()
      expect(await verifyEnvelope(msg)).toBe(true)
    }
  })

  it('should sign space-invite messages (already implemented)', async () => {
    sentMessages.length = 0

    const space = await aliceAdapter.createSpace<TestDoc>(
      'shared', { items: {} }, { name: 'Test', members: [alice.getDid()] },
    )
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait()

    const inviteMessages = sentMessages.filter(m => m.type === 'space-invite')
    expect(inviteMessages.length).toBeGreaterThan(0)

    for (const msg of inviteMessages) {
      expect(msg.signature).toBeTruthy()
      expect(await verifyEnvelope(msg)).toBe(true)
    }
  })

  it('should sign group-key-rotation messages (already implemented)', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>(
      'shared', { items: {} }, { name: 'Test', members: [alice.getDid()] },
    )
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait()
    sentMessages.length = 0

    await aliceAdapter.removeMember(space.id, bob.getDid())
    await wait()

    const rotationMessages = sentMessages.filter(m => m.type === 'group-key-rotation')
    expect(rotationMessages.length).toBeGreaterThan(0)

    for (const msg of rotationMessages) {
      expect(msg.signature).toBeTruthy()
      expect(await verifyEnvelope(msg)).toBe(true)
    }
  })

  it('should encrypt member-update messages', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>(
      'shared', { items: {} }, { name: 'Test', members: [alice.getDid()] },
    )
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait()
    sentMessages.length = 0

    await aliceAdapter.removeMember(space.id, bob.getDid())
    await wait()

    const memberUpdateMessages = sentMessages.filter(m => m.type === 'member-update')
    expect(memberUpdateMessages.length).toBeGreaterThan(0)

    for (const msg of memberUpdateMessages) {
      const payload = JSON.parse(msg.payload)
      // Payload should be encrypted (not contain cleartext memberDid/action)
      expect(payload.encrypted).toBe(true)
      expect(payload.ciphertext).toBeDefined()
      expect(payload.nonce).toBeDefined()
      // Should NOT contain cleartext fields
      expect(payload.action).toBeUndefined()
      expect(payload.memberDid).toBeUndefined()
    }
  })
})
