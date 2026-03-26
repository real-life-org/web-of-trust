/**
 * YjsPersonalSyncAdapter — Multi-device sync for Yjs Personal Doc
 *
 * Bridges the Y.Doc to the MessagingAdapter for encrypted multi-device sync.
 * Equivalent to PersonalNetworkAdapter but for Yjs instead of Automerge.
 *
 * - Listens to Y.Doc 'update' events
 * - Encrypts updates with the personal key (EncryptedSyncService)
 * - Sends encrypted updates via MessagingAdapter to self (other devices)
 * - Receives encrypted updates from other devices, decrypts, applies to Y.Doc
 */
import * as Y from 'yjs'
import type { MessagingAdapter } from '@web.of.trust/core'
import { EncryptedSyncService, signEnvelope } from '@web.of.trust/core'

export class YjsPersonalSyncAdapter {
  private doc: Y.Doc
  private messaging: MessagingAdapter
  private personalKey: Uint8Array
  private myDid: string
  private unsubDocUpdate: (() => void) | null = null
  private unsubMessage: (() => void) | null = null
  private unsubStateChange: (() => void) | null = null
  private started = false
  /** Track message IDs we sent, so we ignore our own echoes from the relay */
  private sentMessageIds = new Set<string>()
  private signFn?: (data: string) => Promise<string>

  constructor(doc: Y.Doc, messaging: MessagingAdapter, personalKey: Uint8Array, myDid: string, signFn?: (data: string) => Promise<string>) {
    this.doc = doc
    this.messaging = messaging
    this.personalKey = personalKey
    this.myDid = myDid
    this.signFn = signFn
  }

  start(): void {
    if (this.started) return
    this.started = true

    // Send full state on start and on every reconnect — other devices may have
    // missed earlier updates (e.g., Device 2 joins after Device 1 already has data)
    this.sendFullState()

    // Re-send full state + request sync whenever messaging reconnects
    this.unsubStateChange = this.messaging.onStateChange((state) => {
      if (state === 'connected' && this.started) {
        this.sendFullState()
        this.sendSyncRequest()
      }
    })

    // Listen for local Y.Doc changes → encrypt and send to other devices
    const updateHandler = (update: Uint8Array, origin: any) => {
      // Only send local changes (not changes received from remote)
      if (origin === 'remote') return
      void this.sendUpdate(update)
    }
    this.doc.on('update', updateHandler)
    this.unsubDocUpdate = () => this.doc.off('update', updateHandler)

    // Listen for incoming messages → decrypt and apply to Y.Doc
    this.unsubMessage = this.messaging.onMessage(async (envelope) => {
      if ((envelope.type as string) !== 'personal-sync') return

      // Skip our own messages echoed back by the relay
      if (this.sentMessageIds.has(envelope.id)) {
        this.sentMessageIds.delete(envelope.id)
        return
      }

      try {
        const payload = JSON.parse(envelope.payload)

        // Handle sync-request: another device asks for our full state
        if (payload.syncRequest) {
          this.sendFullState()
          return
        }

        const encryptedChange = {
          ciphertext: new Uint8Array(payload.ciphertext),
          nonce: new Uint8Array(payload.nonce),
          spaceId: '__personal__',
          generation: 0,
          fromDid: envelope.fromDid,
        }

        const updateData = await EncryptedSyncService.decryptChange(encryptedChange, this.personalKey)

        // Apply to Y.Doc with 'remote' origin (prevents re-sending)
        Y.applyUpdate(this.doc, updateData, 'remote')
      } catch (err) {
        console.debug('[YjsPersonalSync] Failed to process message:', err)
      }
    })

    // Request full state from other devices (they may have data we missed)
    this.sendSyncRequest()
  }

  private sendSyncRequest(): void {
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

    if (this.signFn) {
      void signEnvelope(envelope, this.signFn).then(signed =>
        this.messaging.send(signed)
      ).catch(() => {})
    } else {
      void this.messaging.send(envelope).catch(() => {})
    }
  }

  private sendFullState(): void {
    const fullState = Y.encodeStateAsUpdate(this.doc)
    if (fullState.length > 1) {
      void this.sendUpdate(fullState)
    }
  }

  private async sendUpdate(update: Uint8Array): Promise<void> {
    try {
      const encrypted = await EncryptedSyncService.encryptChange(
        update,
        this.personalKey,
        '__personal__',
        0,
        this.myDid,
      )

      const payload = {
        ciphertext: Array.from(encrypted.ciphertext),
        nonce: Array.from(encrypted.nonce),
      }

      const messageId = crypto.randomUUID()
      this.sentMessageIds.add(messageId)
      // Clean up after 30s to prevent memory leak
      setTimeout(() => this.sentMessageIds.delete(messageId), 30_000)

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

      if (this.signFn) {
        const signed = await signEnvelope(envelope, this.signFn)
        await this.messaging.send(signed)
      } else {
        await this.messaging.send(envelope)
      }
    } catch {
      // Silently ignore send failures (offline, etc.)
    }
  }

  destroy(): void {
    if (this.unsubDocUpdate) {
      this.unsubDocUpdate()
      this.unsubDocUpdate = null
    }
    if (this.unsubMessage) {
      this.unsubMessage()
      this.unsubMessage = null
    }
    if (this.unsubStateChange) {
      this.unsubStateChange()
      this.unsubStateChange = null
    }
    this.sentMessageIds.clear()
    this.started = false
  }
}
