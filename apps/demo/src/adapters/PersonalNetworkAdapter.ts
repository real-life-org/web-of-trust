/**
 * PersonalNetworkAdapter — Bridge between the Personal Doc's Automerge Repo
 * and the MessagingAdapter for multi-device sync.
 *
 * Like EncryptedMessagingNetworkAdapter but simpler:
 * - Single document (personal doc), no space/doc mapping needed
 * - Single key (personal key derived from mnemonic), no GroupKeyService
 * - Sends to self (toDid === fromDid) for cross-device delivery
 * - Filters messages by type: 'personal-sync' (not 'content')
 */
import { NetworkAdapter } from '@automerge/automerge-repo'
import type { PeerId, DocumentId } from '@automerge/automerge-repo'
import type { Message } from '@automerge/automerge-repo'
import type { MessagingAdapter } from '@real-life/wot-core'
import { EncryptedSyncService } from '@real-life/wot-core'

export class PersonalNetworkAdapter extends NetworkAdapter {
  private messaging: MessagingAdapter
  private personalKey: Uint8Array
  private myDid: string
  private documentId: DocumentId | null = null
  private ready = false
  private readyResolve?: () => void
  private readyPromise: Promise<void>
  private unsubMessage: (() => void) | null = null
  /** Track message IDs we sent, so we can ignore our own echoes from the relay */
  private sentMessageIds = new Set<string>()
  /** Gate incoming messages until the doc handle is confirmed ready (avoids automerge-repo 60s timeout) */
  private docReady = false

  constructor(messaging: MessagingAdapter, personalKey: Uint8Array, myDid: string) {
    super()
    this.messaging = messaging
    this.personalKey = personalKey
    this.myDid = myDid
    this.readyPromise = new Promise(resolve => {
      this.readyResolve = resolve
    })
  }

  /** Register the personal document ID for routing */
  setDocumentId(documentId: DocumentId): void {
    this.documentId = documentId
  }

  /** Signal that the doc handle is ready — incoming messages will be emitted to the repo */
  setDocReady(): void {
    this.docReady = true
  }

  // --- NetworkAdapter interface ---

  isReady(): boolean {
    return this.ready
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  connect(peerId: PeerId): void {
    this.peerId = peerId

    // Listen for incoming personal-sync messages
    this.unsubMessage = this.messaging.onMessage(async (envelope) => {
      if (envelope.type as string !== 'personal-sync') return
      if (!this.documentId || !this.docReady) return

      // Skip our own messages echoed back by the relay
      if (this.sentMessageIds.has(envelope.id)) {
        this.sentMessageIds.delete(envelope.id)
        return
      }

      try {
        const payload = JSON.parse(envelope.payload)

        // Decrypt the sync data with our personal key
        const encryptedChange = {
          ciphertext: new Uint8Array(payload.ciphertext),
          nonce: new Uint8Array(payload.nonce),
          spaceId: '__personal__',
          generation: 0,
          fromDid: envelope.fromDid,
        }
        const syncData = await EncryptedSyncService.decryptChange(encryptedChange, this.personalKey)

        // Reconstruct the automerge-repo message
        const message: Message = {
          type: payload.messageType || 'sync',
          senderId: envelope.fromDid as PeerId,
          targetId: this.peerId!,
          documentId: this.documentId,
          data: syncData,
        }

        this.emit('message', message)
      } catch (err) {
        console.debug('[PersonalNetworkAdapter] Failed to process message:', err)
      }
    })

    this.ready = true
    this.readyResolve?.()
    this.emit('ready' as any, undefined)
  }

  send(message: Message): void {
    if (!this.ready) return
    if (!message.data || !this.documentId) return
    // Only send messages for our personal document
    if (message.documentId !== this.documentId) return

    // Fire-and-forget async encryption + send
    void (async () => {
      try {
        const encrypted = await EncryptedSyncService.encryptChange(
          message.data!,
          this.personalKey,
          '__personal__',
          0,
          this.myDid,
        )

        const payload = {
          messageType: message.type,
          ciphertext: Array.from(encrypted.ciphertext),
          nonce: Array.from(encrypted.nonce),
        }

        const messageId = crypto.randomUUID()
        // Track this ID so we ignore the echo from relay
        this.sentMessageIds.add(messageId)
        // Clean up after 30s to prevent memory leak
        setTimeout(() => this.sentMessageIds.delete(messageId), 30_000)

        // Send to self — relay delivers to all other devices with the same DID
        const envelope = {
          v: 1 as const,
          id: messageId,
          type: 'personal-sync' as const,
          fromDid: this.myDid,
          toDid: this.myDid,
          createdAt: new Date().toISOString(),
          encoding: 'json' as const,
          payload: JSON.stringify(payload),
          signature: '',
        }

        await this.messaging.send(envelope)
      } catch {
        // Silently ignore send failures
      }
    })()
  }

  disconnect(): void {
    if (this.unsubMessage) {
      this.unsubMessage()
      this.unsubMessage = null
    }
    this.sentMessageIds.clear()
    this.docReady = false
    this.ready = false
  }
}
