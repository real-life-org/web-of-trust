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
import type { PeerId, DocumentId, DocHandle } from '@automerge/automerge-repo'
import type { Message } from '@automerge/automerge-repo'
import type { MessagingAdapter } from '@web_of_trust/core/ports'
import { EncryptedSyncService } from '@web_of_trust/core/services'
import * as Automerge from '@automerge/automerge'

export class PersonalNetworkAdapter extends NetworkAdapter {
  private messaging: MessagingAdapter
  private personalKey: Uint8Array
  private myDid: string
  private documentId: DocumentId | null = null
  private ready = false
  private readyResolve?: () => void
  private readyPromise: Promise<void>
  private unsubMessage: (() => void) | null = null
  private unsubStateChange: (() => void) | null = null
  /** Track message IDs we sent, so we can ignore our own echoes from the relay */
  private sentMessageIds = new Set<string>()
  /** Gate incoming messages until the doc handle is confirmed ready (avoids automerge-repo 60s timeout) */
  private docReady = false
  /** Doc handle reference for sending full state on reconnect */
  private docHandle: DocHandle<any> | null = null

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

  /** Set the doc handle for reconnect full-state sync */
  setDocHandle(handle: DocHandle<any>): void {
    this.docHandle = handle
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

        // Handle sync-request: another device asks for our full state
        if (payload.syncRequest) {
          void this.sendFullState()
          return
        }

        // Decrypt the sync data with our personal key
        const encryptedChange = {
          ciphertext: new Uint8Array(payload.ciphertext),
          nonce: new Uint8Array(payload.nonce),
          spaceId: '__personal__',
          generation: 0,
          fromDid: envelope.fromDid,
        }
        const syncData = await EncryptedSyncService.decryptChange(encryptedChange, this.personalKey)

        // If this is a full-state payload (from sendFullState on reconnect),
        // merge it directly into the doc via Automerge.merge.
        if (payload.fullState && this.docHandle) {
          try {
            const remoteDoc = Automerge.load(syncData)
            this.docHandle.update((doc: any) => {
              return Automerge.merge(doc, remoteDoc as any)
            })
          } catch (mergeErr) {
            console.debug('[PersonalNetworkAdapter] Full-state merge failed:', mergeErr)
          }
        } else {
          // Reconstruct the automerge-repo message
          const message: Message = {
            type: payload.messageType || 'sync',
            senderId: envelope.fromDid as PeerId,
            targetId: this.peerId!,
            documentId: this.documentId,
            data: syncData,
          }
          this.emit('message', message)
        }
      } catch (err) {
        console.debug('[PersonalNetworkAdapter] Failed to process message:', err)
      }
    })

    this.ready = true
    this.readyResolve?.()
    this.emit('ready' as any, undefined)

    // After reconnect: send full state + request sync from other devices.
    // This mirrors the Yjs approach — explicit full-state exchange after offline periods.
    this.unsubStateChange = this.messaging.onStateChange((state) => {
      if (state === 'connected' && this.docReady) {
        console.debug('[PersonalNetworkAdapter] Reconnected — sending full state + sync request')
        void this.sendFullState()
        void this.sendSyncRequest()
      }
    })
  }

  send(message: Message): void {
    if (!this.ready) return
    if (!message.data || !this.documentId) return
    // Only send messages for our personal document
    if (message.documentId !== this.documentId) return

    // Fire-and-forget async encryption + send
    void this.sendEncrypted(message.data, message.type)
  }

  disconnect(): void {
    if (this.unsubMessage) {
      this.unsubMessage()
      this.unsubMessage = null
    }
    if (this.unsubStateChange) {
      this.unsubStateChange()
      this.unsubStateChange = null
    }
    this.sentMessageIds.clear()
    this.docReady = false
    this.ready = false
  }

  // --- Private helpers ---

  /** Send the full Automerge document state to other devices */
  private async sendFullState(): Promise<void> {
    if (!this.docHandle) return
    const doc = this.docHandle.doc()
    if (!doc) return

    try {
      const fullState = Automerge.save(doc)
      if (fullState.length > 0) {
        await this.sendEncrypted(fullState, 'sync', true)
      }
    } catch (err) {
      console.debug('[PersonalNetworkAdapter] Failed to send full state:', err)
    }
  }

  /** Request other devices to send their full state */
  private async sendSyncRequest(): Promise<void> {
    const messageId = crypto.randomUUID()
    this.sentMessageIds.add(messageId)
    setTimeout(() => this.sentMessageIds.delete(messageId), 30_000)

    const envelope = {
      v: 1 as const,
      id: messageId,
      type: 'personal-sync' as const,
      fromDid: this.myDid,
      toDid: this.myDid,
      createdAt: new Date().toISOString(),
      encoding: 'json' as const,
      payload: JSON.stringify({ syncRequest: true }),
      signature: '',
    }

    try {
      await this.messaging.send(envelope)
    } catch {
      // Silently ignore
    }
  }

  /** Encrypt and send data as a personal-sync message */
  private async sendEncrypted(data: Uint8Array, messageType: string, fullState = false): Promise<void> {
    try {
      const encrypted = await EncryptedSyncService.encryptChange(
        data,
        this.personalKey,
        '__personal__',
        0,
        this.myDid,
      )

      const payload: Record<string, unknown> = {
        messageType,
        ciphertext: Array.from(encrypted.ciphertext),
        nonce: Array.from(encrypted.nonce),
      }
      if (fullState) payload.fullState = true

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
  }
}
