import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PeerId, DocumentId, Message } from '@automerge/automerge-repo'
import { InMemoryMessagingAdapter, WebCryptoAdapter, InMemoryKeyManagementAdapter } from '@web_of_trust/core/adapters'
import { importKey } from '@web_of_trust/core/application'
import { decryptOneShot, encryptOneShot, MEMBER_UPDATE_MESSAGE_TYPE } from '@web_of_trust/core/protocol'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { KeyManagementPort } from '@web_of_trust/core/ports'
import type { MessageEnvelope } from '@web_of_trust/core/types'
import { EncryptedMessagingNetworkAdapter } from '../src/EncryptedMessagingNetworkAdapter'
import type { BlockedContentMessage } from '../src/EncryptedMessagingNetworkAdapter'

/**
 * F4-Fake (Review): injiziert nach dem ERSTEN Current-Read eine Rotation auf
 * gen 1 — simuliert das Rotations-Fenster zwischen zwei getrennten awaits im
 * Send-Pfad. Korrektes (atomares) Lesen liest die Generation EINMAL und holt
 * den Key GENAU dieser Generation → Label und Key bleiben konsistent.
 */
class RotationInjectingKeyManagement implements KeyManagementPort {
  private injected = false
  constructor(
    private readonly inner: InMemoryKeyManagementAdapter,
    private readonly spaceId: string,
    private readonly nextGenerationKey: Uint8Array,
  ) {}

  private async injectRotationAfterFirstRead(): Promise<void> {
    if (this.injected) return
    this.injected = true
    await importKey(this.inner, this.spaceId, 1, this.nextGenerationKey)
  }

  async getCurrentKey(spaceId: string): Promise<Uint8Array | null> {
    const key = await this.inner.getCurrentKey(spaceId)
    await this.injectRotationAfterFirstRead()
    return key
  }

  async getCurrentGeneration(spaceId: string): Promise<number> {
    const generation = await this.inner.getCurrentGeneration(spaceId)
    await this.injectRotationAfterFirstRead()
    return generation
  }

  getKeyByGeneration(spaceId: string, generation: number): Promise<Uint8Array | null> {
    return this.inner.getKeyByGeneration(spaceId, generation)
  }

  saveKey(spaceId: string, generation: number, key: Uint8Array): Promise<void> {
    return this.inner.saveKey(spaceId, generation, key)
  }

  saveCapabilityKeyPair(spaceId: string, generation: number, signingSeed: Uint8Array, verificationKey: Uint8Array): Promise<void> {
    return this.inner.saveCapabilityKeyPair(spaceId, generation, signingSeed, verificationKey)
  }

  getCapabilitySigningSeed(spaceId: string, generation: number): Promise<Uint8Array | null> {
    return this.inner.getCapabilitySigningSeed(spaceId, generation)
  }

  getCapabilityVerificationKey(spaceId: string, generation: number): Promise<Uint8Array | null> {
    return this.inner.getCapabilityVerificationKey(spaceId, generation)
  }

  saveOwnCapability(spaceId: string, generation: number, capabilityJws: string): Promise<void> {
    return this.inner.saveOwnCapability(spaceId, generation, capabilityJws)
  }

  getOwnCapability(spaceId: string, generation: number): Promise<string | null> {
    return this.inner.getOwnCapability(spaceId, generation)
  }
}

const ALICE_DID = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
const BOB_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const SPACE_ID = 'test-space-123'
const DOC_ID = 'test-doc-id' as DocumentId
const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

function createMockIdentity(did: string) {
  return {
    getDid: () => did,
    sign: async (_data: string) => 'mock-signature',
  }
}

describe('EncryptedMessagingNetworkAdapter', () => {
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceGroupKeys: InMemoryKeyManagementAdapter
  let bobGroupKeys: InMemoryKeyManagementAdapter
  let aliceAdapter: EncryptedMessagingNetworkAdapter
  let bobAdapter: EncryptedMessagingNetworkAdapter
  let groupKey: Uint8Array

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()

    aliceMessaging = new InMemoryMessagingAdapter()
    bobMessaging = new InMemoryMessagingAdapter()

    const crypto = new WebCryptoAdapter()
    groupKey = await crypto.generateSymmetricKey()

    aliceGroupKeys = new InMemoryKeyManagementAdapter()
    await importKey(aliceGroupKeys, SPACE_ID, 0, groupKey)

    bobGroupKeys = new InMemoryKeyManagementAdapter()
    await importKey(bobGroupKeys, SPACE_ID, 0, groupKey)

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
      const noKeyService = new InMemoryKeyManagementAdapter()
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

    it('F4: Label und Key bleiben konsistent, wenn eine Rotation zwischen die Lese-Zeitpunkte faellt', async () => {
      // Rotations-Fenster im Send-Pfad: der Fake rotiert nach dem ersten
      // Current-Read auf gen 1. Vor dem Fix (getCurrentKey, dann
      // getCurrentGeneration) reiste die Nachricht gen-0-verschluesselt, aber
      // gen-1-GELABELT — Gift fuer den blocked-by-key-Buffer (Replay unter
      // falscher Generation scheitert fuer immer). Atomar gelesen muss der
      // Ciphertext mit dem Key der gelabelten Generation entschluesselbar sein.
      const crypto = new WebCryptoAdapter()
      const gen1Key = await crypto.generateSymmetricKey()
      const inner = new InMemoryKeyManagementAdapter()
      await importKey(inner, SPACE_ID, 0, groupKey)
      const rotatingKeys = new RotationInjectingKeyManagement(inner, SPACE_ID, gen1Key)

      const adapter = new EncryptedMessagingNetworkAdapter(
        aliceMessaging,
        createMockIdentity(ALICE_DID),
        rotatingKeys,
      )
      await aliceMessaging.connect(ALICE_DID)
      adapter.connect(ALICE_DID as PeerId)
      adapter.registerDocument(DOC_ID, SPACE_ID)

      const sent: MessageEnvelope[] = []
      vi.spyOn(aliceMessaging, 'send').mockImplementation(async (envelope: unknown) => {
        sent.push(envelope as MessageEnvelope)
      })

      const syncData = new Uint8Array([42, 43, 44])
      adapter.send({
        type: 'sync',
        senderId: ALICE_DID as PeerId,
        targetId: BOB_DID as PeerId,
        documentId: DOC_ID,
        data: syncData,
      })
      await new Promise(r => setTimeout(r, 100))

      expect(sent).toHaveLength(1)
      const payload = JSON.parse(sent[0].payload)
      // Konsistenz-Beweis: der Key DER GELABELTEN Generation entschluesselt.
      const labeledKey = await inner.getKeyByGeneration(SPACE_ID, payload.generation)
      expect(labeledKey).not.toBeNull()
      const nonce = new Uint8Array(payload.nonce)
      const ciphertextTag = new Uint8Array(payload.ciphertext)
      const blob = new Uint8Array(nonce.length + ciphertextTag.length)
      blob.set(nonce, 0)
      blob.set(ciphertextTag, nonce.length)
      const decrypted = await decryptOneShot({ crypto: protocolCrypto, spaceContentKey: labeledKey!, blob })
      expect(new Uint8Array(decrypted)).toEqual(syncData)
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
      const encrypted = await encryptOneShot({ crypto: protocolCrypto, spaceContentKey: groupKey, plaintext: syncData })

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
          ciphertext: Array.from(encrypted.ciphertextTag),
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
      // Der content-Kanal ignoriert Fremdtypen BEIDER Familien: DIDComm-Inbox-Envelopes
      // (member-update etc., Type-URIs) und Old-World-Envelopes anderer Typen
      // (personal-sync gehört dem PersonalNetworkAdapter).
      await aliceMessaging.connect(ALICE_DID)
      await bobMessaging.connect(BOB_DID)
      bobAdapter.connect(BOB_DID as PeerId)

      const messages: Message[] = []
      bobAdapter.on('message', (msg: Message) => messages.push(msg))

      // DIDComm-Inbox-Familie: member-update als encrypted Envelope (Wire-Form Sync 003).
      const didcommEnvelope = {
        id: 'test-didcomm-msg-id',
        typ: 'application/didcomm-plain+json',
        type: MEMBER_UPDATE_MESSAGE_TYPE,
        from: ALICE_DID,
        to: [BOB_DID],
        created_time: Math.floor(Date.now() / 1000),
        body: { epk: 'AAAA', nonce: 'AAAA', ciphertext: 'AAAA' },
      }
      await aliceMessaging.send(didcommEnvelope as never)

      // Old-World-Negativbeispiel: personal-sync bleibt ein MessageEnvelope-Typ.
      const oldWorldEnvelope: MessageEnvelope = {
        v: 1,
        id: 'test-old-world-msg-id',
        type: 'personal-sync' as MessageEnvelope['type'],
        fromDid: ALICE_DID,
        toDid: BOB_DID,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: '{}',
        signature: '',
      }
      await aliceMessaging.send(oldWorldEnvelope)
      await new Promise(r => setTimeout(r, 50))

      expect(messages).toHaveLength(0)
    })

    it('should ignore messages without group key', async () => {
      const bobMessaging2 = new InMemoryMessagingAdapter()
      const noKeyService = new InMemoryKeyManagementAdapter() // Empty — no keys
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

      const encrypted = await encryptOneShot({ crypto: protocolCrypto, spaceContentKey: groupKey, plaintext: new Uint8Array([1, 2, 3]) })

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
          ciphertext: Array.from(encrypted.ciphertextTag),
          nonce: Array.from(encrypted.nonce),
        }),
        signature: '',
      }

      await aliceMessaging.send(envelope)
      await new Promise(r => setTimeout(r, 50))

      expect(messages).toHaveLength(0)
    })

    it('F-1: meldet content mit unbekannter Generation als blocked-by-key; Replay nach Key-Import emittiert die Nachricht', async () => {
      // Sync 002 Z.173 (MUSS): kein Drop — der Hook erhaelt den rohen
      // Envelope inkl. Generation; der Replay laeuft durch DENSELBEN
      // Decrypt-→repo-Pfad wie der Live-Empfang.
      const crypto = new WebCryptoAdapter()
      const gen1Key = await crypto.generateSymmetricKey()

      await aliceMessaging.connect(ALICE_DID)
      await bobMessaging.connect(BOB_DID)
      bobAdapter.connect(BOB_DID as PeerId)
      bobAdapter.registerDocument(DOC_ID, SPACE_ID)

      const blocked: BlockedContentMessage[] = []
      bobAdapter.setContentBlockedHandler(async (b) => { blocked.push(b) })

      const messages: Message[] = []
      bobAdapter.on('message', (msg: Message) => messages.push(msg))

      // gen-1-verschluesselte Nachricht; bob kennt nur gen 0.
      const syncData = new Uint8Array([7, 8, 9])
      const encrypted = await encryptOneShot({ crypto: protocolCrypto, spaceContentKey: gen1Key, plaintext: syncData })
      const envelope: MessageEnvelope = {
        v: 1,
        id: 'test-msg-blocked',
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
          generation: 1,
          ciphertext: Array.from(encrypted.ciphertextTag),
          nonce: Array.from(encrypted.nonce),
        }),
        signature: '',
      }
      await aliceMessaging.send(envelope)
      await new Promise(r => setTimeout(r, 100))

      expect(messages).toHaveLength(0)
      expect(blocked).toHaveLength(1)
      expect(blocked[0]).toMatchObject({ spaceId: SPACE_ID, keyGeneration: 1 })
      expect(blocked[0].envelope.id).toBe('test-msg-blocked')

      // Key-Import schliesst die Luecke → Replay emittiert die Nachricht.
      await importKey(bobGroupKeys, SPACE_ID, 1, gen1Key)
      await bobAdapter.replayContentEnvelope(blocked[0].envelope)

      expect(messages).toHaveLength(1)
      expect(messages[0].documentId).toBe(DOC_ID)
      expect(new Uint8Array(messages[0].data!)).toEqual(syncData)
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
