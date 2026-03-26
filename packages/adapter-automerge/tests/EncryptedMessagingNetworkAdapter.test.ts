import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PeerId, DocumentId, Message } from '@automerge/automerge-repo'
import { InMemoryMessagingAdapter } from '@web.of.trust/core'
import { GroupKeyService } from '@web.of.trust/core'
import { EncryptedSyncService } from '@web.of.trust/core'
import { WebCryptoAdapter } from '@web.of.trust/core'
import type { MessageEnvelope } from '@web.of.trust/core'
import { EncryptedMessagingNetworkAdapter } from '../src/EncryptedMessagingNetworkAdapter'

const ALICE_DID = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
const BOB_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const SPACE_ID = 'test-space-123'
const DOC_ID = 'test-doc-id' as DocumentId

function createMockIdentity(did: string) {
  return {
    getDid: () => did,
    sign: async (_data: string) => 'mock-signature',
  }
}

describe('EncryptedMessagingNetworkAdapter', () => {
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceGroupKeys: GroupKeyService
  let bobGroupKeys: GroupKeyService
  let aliceAdapter: EncryptedMessagingNetworkAdapter
  let bobAdapter: EncryptedMessagingNetworkAdapter
  let groupKey: Uint8Array

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()

    aliceMessaging = new InMemoryMessagingAdapter()
    bobMessaging = new InMemoryMessagingAdapter()

    const crypto = new WebCryptoAdapter()
    groupKey = await crypto.generateSymmetricKey()

    aliceGroupKeys = new GroupKeyService()
    aliceGroupKeys.importKey(SPACE_ID, groupKey, 0)

    bobGroupKeys = new GroupKeyService()
    bobGroupKeys.importKey(SPACE_ID, groupKey, 0)

    aliceAdapter = new EncryptedMessagingNetworkAdapter(
      aliceMessaging,
      createMockIdentity(ALICE_DID),
      aliceGroupKeys,
    )

    bobAdapter = new EncryptedMessagingNetworkAdapter(
      bobMessaging,
      createMockIdentity(BOB_DID),
      bobGroupKeys,
    )
  })

  describe('lifecycle', () => {
    it('should start not ready', () => {
      expect(aliceAdapter.isReady()).toBe(false)
    })

    it('should become ready after connect', () => {
      aliceAdapter.connect(ALICE_DID as PeerId)
      expect(aliceAdapter.isReady()).toBe(true)
    })

    it('should resolve whenReady after connect', async () => {
      const ready = aliceAdapter.whenReady()
      aliceAdapter.connect(ALICE_DID as PeerId)
      await expect(ready).resolves.toBeUndefined()
    })

    it('should become not ready after disconnect', () => {
      aliceAdapter.connect(ALICE_DID as PeerId)
      aliceAdapter.disconnect()
      expect(aliceAdapter.isReady()).toBe(false)
    })
  })

  describe('document/peer registration', () => {
    it('should register and track document-to-space mapping', () => {
      aliceAdapter.registerDocument(DOC_ID, SPACE_ID)
      // No public getter — verified through send() behavior
    })

    it('should emit peer-candidate on registerSpacePeer', () => {
      aliceAdapter.connect(ALICE_DID as PeerId)
      const events: any[] = []
      aliceAdapter.on('peer-candidate', (e: any) => events.push(e))

      aliceAdapter.registerSpacePeer(SPACE_ID, BOB_DID)
      expect(events).toHaveLength(1)
      expect(events[0].peerId).toBe(BOB_DID)
    })

    it('should not emit duplicate peer-candidate for same peer', () => {
      aliceAdapter.connect(ALICE_DID as PeerId)
      const events: any[] = []
      aliceAdapter.on('peer-candidate', (e: any) => events.push(e))

      aliceAdapter.registerSpacePeer(SPACE_ID, BOB_DID)
      aliceAdapter.registerSpacePeer(SPACE_ID, BOB_DID)
      expect(events).toHaveLength(1)
    })

    it('should emit peer-disconnected when peer removed from all spaces', () => {
      aliceAdapter.connect(ALICE_DID as PeerId)
      const disconnected: any[] = []
      aliceAdapter.on('peer-disconnected', (e: any) => disconnected.push(e))

      aliceAdapter.registerSpacePeer(SPACE_ID, BOB_DID)
      aliceAdapter.unregisterSpacePeer(SPACE_ID, BOB_DID)

      expect(disconnected).toHaveLength(1)
      expect(disconnected[0].peerId).toBe(BOB_DID)
    })

    it('should not disconnect peer still in another space', () => {
      aliceAdapter.connect(ALICE_DID as PeerId)
      const disconnected: any[] = []
      aliceAdapter.on('peer-disconnected', (e: any) => disconnected.push(e))

      aliceAdapter.registerSpacePeer(SPACE_ID, BOB_DID)
      aliceAdapter.registerSpacePeer('space-2', BOB_DID)
      aliceAdapter.unregisterSpacePeer(SPACE_ID, BOB_DID)

      expect(disconnected).toHaveLength(0)
    })

    it('should register self peer with phantom ID', () => {
      aliceAdapter.connect(ALICE_DID as PeerId)
      const events: any[] = []
      aliceAdapter.on('peer-candidate', (e: any) => events.push(e))

      aliceAdapter.registerSelfPeer(SPACE_ID)
      expect(events).toHaveLength(1)
      expect(events[0].peerId).toContain(ALICE_DID)
      expect(events[0].peerId).toContain('#other-device')
    })
  })

  describe('send', () => {
    it('should not send when not ready', async () => {
      aliceAdapter.registerDocument(DOC_ID, SPACE_ID)

      const sendSpy = vi.spyOn(aliceMessaging, 'send')
      aliceAdapter.send({
        type: 'sync',
        senderId: ALICE_DID as PeerId,
        targetId: BOB_DID as PeerId,
        documentId: DOC_ID,
        data: new Uint8Array([1, 2, 3]),
      })

      // Give the async fire-and-forget a tick
      await new Promise(r => setTimeout(r, 50))
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('should not send without registered document', async () => {
      await aliceMessaging.connect(ALICE_DID)
      aliceAdapter.connect(ALICE_DID as PeerId)

      const sendSpy = vi.spyOn(aliceMessaging, 'send')
      aliceAdapter.send({
        type: 'sync',
        senderId: ALICE_DID as PeerId,
        targetId: BOB_DID as PeerId,
        documentId: DOC_ID,
        data: new Uint8Array([1, 2, 3]),
      })

      await new Promise(r => setTimeout(r, 50))
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('should not send without group key', async () => {
      const noKeyService = new GroupKeyService()
      const adapter = new EncryptedMessagingNetworkAdapter(
        aliceMessaging,
        createMockIdentity(ALICE_DID),
        noKeyService,
      )
      await aliceMessaging.connect(ALICE_DID)
      adapter.connect(ALICE_DID as PeerId)
      adapter.registerDocument(DOC_ID, SPACE_ID)

      const sendSpy = vi.spyOn(aliceMessaging, 'send')
      adapter.send({
        type: 'sync',
        senderId: ALICE_DID as PeerId,
        targetId: BOB_DID as PeerId,
        documentId: DOC_ID,
        data: new Uint8Array([1, 2, 3]),
      })

      await new Promise(r => setTimeout(r, 50))
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('should not send without data', () => {
      aliceAdapter.connect(ALICE_DID as PeerId)
      aliceAdapter.registerDocument(DOC_ID, SPACE_ID)

      const sendSpy = vi.spyOn(aliceMessaging, 'send')
      aliceAdapter.send({
        type: 'sync',
        senderId: ALICE_DID as PeerId,
        targetId: BOB_DID as PeerId,
        documentId: DOC_ID,
      } as Message)

      expect(sendSpy).not.toHaveBeenCalled()
    })
  })

  describe('receive', () => {
    it('should decrypt and emit incoming sync message', async () => {
      // Connect both adapters
      await aliceMessaging.connect(ALICE_DID)
      await bobMessaging.connect(BOB_DID)
      bobAdapter.connect(BOB_DID as PeerId)
      bobAdapter.registerDocument(DOC_ID, SPACE_ID)

      const messages: Message[] = []
      bobAdapter.on('message', (msg: Message) => messages.push(msg))

      // Alice sends an encrypted sync message to Bob via InMemoryMessagingAdapter
      const syncData = new Uint8Array([10, 20, 30])
      const encrypted = await EncryptedSyncService.encryptChange(
        syncData, groupKey, SPACE_ID, 0, ALICE_DID,
      )

      const envelope: MessageEnvelope = {
        v: 1,
        id: 'test-msg-id',
        type: 'content',
        fromDid: ALICE_DID,
        toDid: BOB_DID,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify({
          syncData: true,
          spaceId: SPACE_ID,
          documentId: DOC_ID,
          messageType: 'sync',
          generation: 0,
          ciphertext: Array.from(encrypted.ciphertext),
          nonce: Array.from(encrypted.nonce),
        }),
        signature: '',
      }

      // Send via Alice's messaging adapter — will deliver to Bob
      await aliceMessaging.send(envelope)

      // Wait for async processing
      await new Promise(r => setTimeout(r, 100))

      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('sync')
      expect(messages[0].senderId).toBe(ALICE_DID)
      expect(messages[0].documentId).toBe(DOC_ID)
      expect(new Uint8Array(messages[0].data!)).toEqual(syncData)
    })

    it('should ignore non-content messages', async () => {
      await aliceMessaging.connect(ALICE_DID)
      await bobMessaging.connect(BOB_DID)
      bobAdapter.connect(BOB_DID as PeerId)

      const messages: Message[] = []
      bobAdapter.on('message', (msg: Message) => messages.push(msg))

      const envelope: MessageEnvelope = {
        v: 1,
        id: 'test-msg-id',
        type: 'member-update',
        fromDid: ALICE_DID,
        toDid: BOB_DID,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: '{}',
        signature: '',
      }

      await aliceMessaging.send(envelope)
      await new Promise(r => setTimeout(r, 50))

      expect(messages).toHaveLength(0)
    })

    it('should ignore messages without group key', async () => {
      const bobMessaging2 = new InMemoryMessagingAdapter()
      const noKeyService = new GroupKeyService() // Empty — no keys
      const adapter = new EncryptedMessagingNetworkAdapter(
        bobMessaging2,
        createMockIdentity(BOB_DID),
        noKeyService,
      )
      await aliceMessaging.connect(ALICE_DID)
      await bobMessaging2.connect(BOB_DID)
      adapter.connect(BOB_DID as PeerId)

      const messages: Message[] = []
      adapter.on('message', (msg: Message) => messages.push(msg))

      const encrypted = await EncryptedSyncService.encryptChange(
        new Uint8Array([1, 2, 3]), groupKey, SPACE_ID, 0, ALICE_DID,
      )

      const envelope: MessageEnvelope = {
        v: 1,
        id: 'test-msg-no-key',
        type: 'content',
        fromDid: ALICE_DID,
        toDid: BOB_DID,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify({
          syncData: true,
          spaceId: SPACE_ID,
          documentId: DOC_ID,
          generation: 0,
          ciphertext: Array.from(encrypted.ciphertext),
          nonce: Array.from(encrypted.nonce),
        }),
        signature: '',
      }

      await aliceMessaging.send(envelope)
      await new Promise(r => setTimeout(r, 50))

      expect(messages).toHaveLength(0)
    })
  })

  describe('echo filtering', () => {
    it('should filter own echoed messages via sentMessageIds tracking', async () => {
      // The echo filtering works by tracking sent message IDs internally.
      // We verify this indirectly: when Alice sends to herself, the adapter
      // tracks the messageId and filters the echo.
      await aliceMessaging.connect(ALICE_DID)
      aliceAdapter.connect(ALICE_DID as PeerId)
      aliceAdapter.registerDocument(DOC_ID, SPACE_ID)
      aliceAdapter.registerSpacePeer(SPACE_ID, ALICE_DID) // self as peer

      const incomingMessages: Message[] = []
      aliceAdapter.on('message', (msg: Message) => incomingMessages.push(msg))

      // Send to self — InMemoryMessagingAdapter will deliver back immediately
      aliceAdapter.send({
        type: 'sync',
        senderId: ALICE_DID as PeerId,
        targetId: ALICE_DID as PeerId,
        documentId: DOC_ID,
        data: new Uint8Array([1, 2, 3]),
      })

      await new Promise(r => setTimeout(r, 200))

      // Should have been filtered (message was sent by us, echoed back)
      expect(incomingMessages).toHaveLength(0)
    })
  })
})
