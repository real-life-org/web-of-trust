import { NetworkAdapter } from '@automerge/automerge-repo'
import type { PeerId, DocumentId } from '@automerge/automerge-repo'
import type { Message } from '@automerge/automerge-repo'
import type { PeerMetadata } from '@automerge/automerge-repo'
import type { MessagingAdapter } from '@web_of_trust/core/ports'
import type { GroupKeyService } from '@web_of_trust/core/services'
import { EncryptedSyncService } from '@web_of_trust/core/services'
import { signEnvelope, verifyEnvelope } from '@web_of_trust/core/crypto'

/**
 * EncryptedMessagingNetworkAdapter — Bridge between automerge-repo and our MessagingAdapter.
 *
 * Responsibilities:
 * - Translates automerge-repo sync messages to/from encrypted MessageEnvelopes
 * - Routes messages through our existing MessagingAdapter (WebSocket relay)
 * - Encrypts outgoing sync data with per-space AES-256-GCM group keys
 * - Decrypts incoming sync data using GroupKeyService
 * - Maps DocumentId -> SpaceId for key lookup
 * - Maps PeerId = DID for routing
 */
export class EncryptedMessagingNetworkAdapter extends NetworkAdapter {
  private messaging: MessagingAdapter
  private identity: { getDid(): string; sign(data: string): Promise<string> }
  private groupKeyService: GroupKeyService
  private ready = false
  private readyResolve?: () => void
  private readyPromise: Promise<void>
  private unsubMessage?: () => void
  /** Track message IDs we sent, so we can ignore our own echoes from the relay */
  private sentMessageIds = new Set<string>()
  /** Phantom peerId used for multi-device self-sync */
  private selfPeerId: string | null = null

  // Document -> Space mapping (needed to find the right group key)
  private docToSpace = new Map<DocumentId, string>()

  // Known peers per space
  private spacePeers = new Map<string, Set<string>>() // spaceId -> Set<DID>

  constructor(
    messaging: MessagingAdapter,
    identity: { getDid(): string; sign(data: string): Promise<string> },
    groupKeyService: GroupKeyService,
  ) {
    super()
    this.messaging = messaging
    this.identity = identity
    this.groupKeyService = groupKeyService
    this.readyPromise = new Promise(resolve => {
      this.readyResolve = resolve
    })
  }

  // --- NetworkAdapter interface ---

  isReady(): boolean {
    return this.ready
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata

    // Listen for incoming content messages from our MessagingAdapter
    this.unsubMessage = this.messaging.onMessage(async (envelope) => {
      if (envelope.type !== 'content') return

      // Skip our own messages echoed back by the relay (multi-device: fromDid === toDid)
      if (this.sentMessageIds.has(envelope.id)) {
        this.sentMessageIds.delete(envelope.id)
        return
      }

      // Verify envelope signature — reject unsigned or forged messages
      if (envelope.signature) {
        const valid = await verifyEnvelope(envelope)
        if (!valid) {
          console.warn('[EncryptedSync] Rejected message with invalid signature from', envelope.fromDid)
          return
        }
      }

      try {
        const payload = JSON.parse(envelope.payload)
        // Only handle automerge-repo sync messages (have syncData field)
        if (!payload.syncData) return

        const spaceId = payload.spaceId as string
        const generation = payload.generation as number

        // Get the group key for decryption
        const groupKey = this.groupKeyService.getKeyByGeneration(spaceId, generation)
        if (!groupKey) {
          // Expected when sync messages arrive before space metadata (race condition)
          console.debug(`[EncryptedSync] No group key yet for space ${spaceId} gen ${generation} — will sync after metadata arrives`)
          return
        }

        // Decrypt the sync data
        const encryptedChange = {
          ciphertext: new Uint8Array(payload.ciphertext),
          nonce: new Uint8Array(payload.nonce),
          spaceId,
          generation,
          fromDid: envelope.fromDid,
        }
        const syncData = await EncryptedSyncService.decryptChange(encryptedChange, groupKey)

        // Find the documentId for this space
        const documentId = payload.documentId as DocumentId
        if (!documentId) return

        // If message is from our own DID (other device), use phantom peerId
        // so automerge-repo routes the response correctly
        const senderId = (envelope.fromDid === this.identity.getDid() && this.selfPeerId)
          ? this.selfPeerId as PeerId
          : envelope.fromDid as PeerId

        // Reconstruct the automerge-repo message
        const message: Message = {
          type: payload.messageType || 'sync',
          senderId,
          targetId: this.peerId!,
          documentId,
          data: syncData,
        }

        // Emit to automerge-repo
        this.emit('message', message)
      } catch (err) {
        // Silently ignore malformed or undecryptable messages
        console.debug('EncryptedMessagingNetworkAdapter: failed to process message', err)
      }
    })

    this.ready = true
    this.readyResolve?.()
    this.emit('ready' as any, undefined)
  }

  send(message: Message): void {
    if (!this.ready) return
    if (!message.data || !message.documentId) return

    const spaceId = this.docToSpace.get(message.documentId)
    if (!spaceId) return

    const groupKey = this.groupKeyService.getCurrentKey(spaceId)
    if (!groupKey) return

    const generation = this.groupKeyService.getCurrentGeneration(spaceId)

    // Resolve phantom self-peer to actual DID
    const targetId = message.targetId as string
    const toDid = (targetId === this.selfPeerId)
      ? this.identity.getDid()
      : targetId

    // Fire-and-forget async encryption + send
    void (async () => {
      try {
        const encrypted = await EncryptedSyncService.encryptChange(
          message.data!,
          groupKey,
          spaceId,
          generation,
          this.identity.getDid(),
        )

        const payload = {
          syncData: true,
          spaceId,
          documentId: message.documentId,
          messageType: message.type,
          generation,
          ciphertext: Array.from(encrypted.ciphertext),
          nonce: Array.from(encrypted.nonce),
        }

        const messageId = crypto.randomUUID()
        // Track this ID so we ignore the echo from relay
        this.sentMessageIds.add(messageId)
        // Clean up after 30s to prevent memory leak
        setTimeout(() => this.sentMessageIds.delete(messageId), 30_000)

        const envelope = {
          v: 1 as const,
          id: messageId,
          type: 'content' as const,
          fromDid: this.identity.getDid(),
          toDid,
          createdAt: new Date().toISOString(),
          encoding: 'json' as const,
          payload: JSON.stringify(payload),
          signature: '',
        }

        await signEnvelope(envelope, (data) => this.identity.sign(data))
        await this.messaging.send(envelope)
      } catch (err) {
        console.debug('[EncryptedSync] Failed to send sync message:', err)
      }
    })()
  }

  disconnect(): void {
    this.unsubMessage?.()
    this.unsubMessage = undefined
    this.sentMessageIds.clear()
    this.ready = false
  }

  // --- Space/Document registration ---

  /**
   * Register a document -> space mapping.
   * Needed so we can look up the right group key when sending/receiving.
   */
  registerDocument(documentId: DocumentId, spaceId: string): void {
    this.docToSpace.set(documentId, spaceId)
  }

  /**
   * Unregister a document mapping.
   */
  unregisterDocument(documentId: DocumentId): void {
    this.docToSpace.delete(documentId)
  }

  /**
   * Register a peer (DID) as a member of a space.
   * Emits peer-candidate so automerge-repo starts syncing with this peer.
   */
  registerSpacePeer(spaceId: string, memberDid: string): void {
    let peers = this.spacePeers.get(spaceId)
    if (!peers) {
      peers = new Set()
      this.spacePeers.set(spaceId, peers)
    }

    if (peers.has(memberDid)) return // Already registered
    peers.add(memberDid)

    // Tell automerge-repo about this peer
    this.emit('peer-candidate', {
      peerId: memberDid as PeerId,
      peerMetadata: { isEphemeral: true },
    })
  }

  /**
   * Register a phantom peer representing "self on another device".
   * Uses a different peerId so automerge-repo doesn't skip it as self,
   * but send() routes messages to our own DID (relay delivers to other devices).
   */
  registerSelfPeer(spaceId: string): void {
    if (!this.selfPeerId) {
      this.selfPeerId = `${this.identity.getDid()}#other-device`
    }
    this.registerSpacePeer(spaceId, this.selfPeerId)
  }

  /**
   * Unregister a peer from a space.
   */
  unregisterSpacePeer(spaceId: string, memberDid: string): void {
    const peers = this.spacePeers.get(spaceId)
    if (!peers) return
    peers.delete(memberDid)

    // Check if this peer is still in any other space
    for (const [, otherPeers] of this.spacePeers) {
      if (otherPeers.has(memberDid)) return // Still in another space
    }

    // Peer is in no spaces — disconnect
    this.emit('peer-disconnected', { peerId: memberDid as PeerId })
  }
}
