import { NetworkAdapter } from '@automerge/automerge-repo'
import type { PeerId, DocumentId } from '@automerge/automerge-repo'
import type { Message } from '@automerge/automerge-repo'
import type { PeerMetadata } from '@automerge/automerge-repo'
import type { MessagingAdapter, KeyManagementPort } from '@web_of_trust/core/ports'
import type { MessageEnvelope } from '@web_of_trust/core/types'
import type { ProtocolCryptoAdapter } from '@web_of_trust/core/protocol'
import { decryptOneShot, encryptOneShot } from '@web_of_trust/core/protocol'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { InMemoryKeyManagementAdapter } from '@web_of_trust/core/adapters'
import { signEnvelope, verifyEnvelope } from '@web_of_trust/core/crypto'

/**
 * blocked-by-key-Meldung (F-1/B1, Sync 002 Z.173 MUSS): eine gueltige
 * content-Nachricht mit vorhandener keyGeneration darf bei fehlendem
 * Key-Material NICHT verworfen werden. Der Handler (Replication-Adapter)
 * puffert den ROHEN Envelope (Ciphertext + Sender-Metadaten + docId/spaceId
 * im Payload) durabel und feedet ihn nach Key-Ankunft via
 * replayContentEnvelope erneut durch denselben Empfangspfad.
 */
export interface BlockedContentMessage {
  spaceId: string
  keyGeneration: number
  envelope: MessageEnvelope
}

/**
 * EncryptedMessagingNetworkAdapter — Bridge between automerge-repo and our MessagingAdapter.
 *
 * Responsibilities:
 * - Translates automerge-repo sync messages to/from encrypted MessageEnvelopes
 * - Routes messages through our existing MessagingAdapter (WebSocket relay)
 * - Encrypts outgoing sync data with per-space AES-256-GCM group keys
 * - Decrypts incoming sync data using the KeyManagementPort
 * - Maps DocumentId -> SpaceId for key lookup
 * - Maps PeerId = DID for routing
 */
export class EncryptedMessagingNetworkAdapter extends NetworkAdapter {
  private messaging: MessagingAdapter
  private identity: { getDid(): string; sign(data: string): Promise<string> }
  private keyManagement: KeyManagementPort
  private crypto: ProtocolCryptoAdapter
  private ready = false
  private readyResolve?: () => void
  private readyPromise: Promise<void>
  private unsubMessage?: () => void
  /** Track message IDs we sent, so we can ignore our own echoes from the relay */
  private sentMessageIds = new Set<string>()
  /** Phantom peerId used for multi-device self-sync */
  private selfPeerId: string | null = null
  /** F-1 (Sync 002 Z.173): Hook fuer blocked-by-key-Pufferung statt Drop. */
  private onContentBlocked: ((blocked: BlockedContentMessage) => Promise<void>) | null = null

  // Document -> Space mapping (needed to find the right group key)
  private docToSpace = new Map<DocumentId, string>()

  // VE-7 (Slice A Phase 4): spaceIds whose steady-state sync the log path owns.
  // For these, the automerge-repo native content/full-state send is a NO-OP
  // (the log-entry JWS carries the update) and incoming content is ignored — so
  // `expect(sentTypes).not.toContain('content')` holds and there is no double-apply.
  private logSyncManagedSpaces = new Set<string>()

  // Known peers per space
  private spacePeers = new Map<string, Set<string>>() // spaceId -> Set<DID>

  constructor(
    messaging: MessagingAdapter,
    identity: { getDid(): string; sign(data: string): Promise<string> },
    keyManagement?: KeyManagementPort,
    crypto?: ProtocolCryptoAdapter,
  ) {
    super()
    this.messaging = messaging
    this.identity = identity
    this.keyManagement = keyManagement ?? new InMemoryKeyManagementAdapter()
    this.crypto = crypto ?? new WebCryptoProtocolCryptoAdapter()
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

    // Listen for incoming content messages from our MessagingAdapter.
    // content existiert nur in der Old-World-Envelope-Familie — DIDComm-Inbox-Typen
    // (Type-URIs) fallen durch denselben Guard (VE-8 Familien-Split).
    this.unsubMessage = this.messaging.onMessage(async (incoming) => {
      if (incoming.type !== 'content') return
      const envelope = incoming as MessageEnvelope

      // Skip our own messages echoed back by the relay (multi-device: fromDid === toDid)
      if (this.sentMessageIds.has(envelope.id)) {
        this.sentMessageIds.delete(envelope.id)
        return
      }

      await this.processContentEnvelope(envelope)
    })

    this.ready = true
    this.readyResolve?.()
    this.emit('ready' as any, undefined)
  }

  /**
   * F-1: registriert den blocked-by-key-Handler (Replication-Adapter). Ohne
   * Handler (Standalone-Betrieb in Unit-Tests) kann eine Nachricht mit
   * unbekannter Generation nicht gepuffert werden und bleibt unangewendet.
   */
  setContentBlockedHandler(handler: (blocked: BlockedContentMessage) => Promise<void>): void {
    this.onContentBlocked = handler
  }

  /**
   * Replay-Eingang fuer blocked-by-key gepufferte content-Envelopes (F-1,
   * Sync 002 Z.231/Z.235): exakt derselbe Decrypt-→repo-Pfad wie der
   * Live-Empfang, kein Sonderpfad. Ist der Key weiterhin unbekannt, meldet
   * der Pfad erneut blocked (der Handler re-buffert).
   */
  async replayContentEnvelope(envelope: MessageEnvelope): Promise<void> {
    await this.processContentEnvelope(envelope)
  }

  /** Gemeinsamer Empfangspfad fuer Live-Empfang und Pending-Replay (F-1). */
  private async processContentEnvelope(envelope: MessageEnvelope): Promise<void> {
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

      // VE-7 (Slice A Phase 4): a log-sync-managed space converges via the log
      // path only — ignore any stray content envelope (no double-apply, no
      // blocked-by-key buffering on the dead content channel).
      if (this.logSyncManagedSpaces.has(spaceId)) return

      // Get the group key for decryption
      const groupKey = await this.keyManagement.getKeyByGeneration(spaceId, generation)
      if (!groupKey) {
        // Sync 002 Z.173 (MUSS): eine gueltige Nachricht mit vorhandener
        // keyGeneration wird bei fehlendem Key-Material NICHT verworfen,
        // sondern als blocked-by-key gemeldet — der Replication-Adapter
        // puffert den rohen Envelope durabel und replayt ihn nach
        // rotation-apply bzw. beim start()-Restore (aufsteigend nach
        // Generation, Z.231/Z.235) erneut durch DIESEN Pfad. Der fruehere
        // endgueltige Drop heilte im laufenden Sync nachweislich nicht
        // (sentHashes-Suppression des Senders, endloser Heads-Ping-Pong —
        // Ex-CHECK-4-Befund, Pin-Test invertiert in
        // AutomergeGenerationGapRecovery.test.ts).
        if (this.onContentBlocked) {
          await this.onContentBlocked({ spaceId, keyGeneration: generation, envelope })
          return
        }
        // Standalone-Betrieb ohne Replication-Adapter: kein Buffer verdrahtet.
        console.debug(`[EncryptedSync] No group key for space ${spaceId} gen ${generation} and no blocked-content handler — message not applied`)
        return
      }

      // Decrypt the sync data — OneShot random-nonce messaging payload (Sync 001 Z.103).
      const nonce = new Uint8Array(payload.nonce)
      const ciphertextTag = new Uint8Array(payload.ciphertext)
      const blob = new Uint8Array(nonce.length + ciphertextTag.length)
      blob.set(nonce, 0)
      blob.set(ciphertextTag, nonce.length)
      const syncData = await decryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, blob })

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
  }

  send(message: Message): void {
    if (!this.ready) return
    if (!message.data || !message.documentId) return

    const spaceId = this.docToSpace.get(message.documentId)
    if (!spaceId) return

    // VE-7 (Slice A Phase 4): under log-sync the content/full-state channel is a
    // NO-OP — the log-entry JWS carries the update. This is the structural
    // guarantee behind `expect(sentTypes).not.toContain('content')`.
    if (this.logSyncManagedSpaces.has(spaceId)) return

    // Resolve phantom self-peer to actual DID
    const targetId = message.targetId as string
    const toDid = (targetId === this.selfPeerId)
      ? this.identity.getDid()
      : targetId

    // Fire-and-forget async encryption + send. Key lookups are async now, so
    // they run inside the IIFE where await is legal — send() must stay sync and
    // return void per the automerge-repo NetworkAdapter contract.
    void (async () => {
      try {
        // F4 (Review): Label und Key atomar zur SELBEN Generation lesen —
        // die Generation EINMAL bestimmen, dann den Key GENAU dieser
        // Generation holen. Zwei getrennte Current-Reads (getCurrentKey +
        // getCurrentGeneration) oeffneten ein Rotations-Fenster, in dem die
        // Nachricht mit gen N verschluesselt, aber gen N+1 GELABELT reiste —
        // Gift fuer den blocked-by-key-Buffer (F-1): ein falsch gelabelter
        // Ciphertext replayt unter der falschen Generation und scheitert
        // fuer immer.
        const generation = await this.keyManagement.getCurrentGeneration(spaceId)
        const groupKey = await this.keyManagement.getKeyByGeneration(spaceId, generation)
        if (!groupKey) return

        const encrypted = await encryptOneShot({
          crypto: this.crypto,
          spaceContentKey: groupKey,
          plaintext: message.data!,
        })

        const payload = {
          syncData: true,
          spaceId,
          documentId: message.documentId,
          messageType: message.type,
          generation,
          ciphertext: Array.from(encrypted.ciphertextTag),
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
   * VE-7 (Slice A Phase 4): mark/unmark a space as log-sync-managed. When marked,
   * the native automerge-repo content send for that space is a NO-OP and incoming
   * content for it is ignored — the log path is the single steady-state channel.
   */
  setLogSyncManaged(spaceId: string, managed: boolean): void {
    if (managed) this.logSyncManagedSpaces.add(spaceId)
    else this.logSyncManagedSpaces.delete(spaceId)
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
   * Deregistriert einen ganzen Space (leaveSpace/Resolution-Cleanup, VE-5):
   * entfernt das Peer-Set des Space; Peers, die danach in keinem anderen
   * Space mehr vorkommen, werden getrennt (inkl. Phantom-Self-Peer).
   */
  unregisterSpace(spaceId: string): void {
    const peers = this.spacePeers.get(spaceId)
    if (!peers) return
    this.spacePeers.delete(spaceId)
    for (const did of peers) {
      let stillPresent = false
      for (const otherPeers of this.spacePeers.values()) {
        if (otherPeers.has(did)) { stillPresent = true; break }
      }
      if (!stillPresent) this.emit('peer-disconnected', { peerId: did as PeerId })
    }
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
