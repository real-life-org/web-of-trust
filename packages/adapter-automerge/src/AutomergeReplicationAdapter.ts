import { Repo, parseAutomergeUrl, type DocumentId, type AutomergeUrl, type PeerId } from '@automerge/automerge-repo'
import type { StorageAdapterInterface } from '@automerge/automerge-repo'
import type { DocHandle } from '@automerge/automerge-repo'
import * as Automerge from '@automerge/automerge'
import type { ReplicationAdapter, SpaceHandle, TransactOptions, Subscribable, MessagingAdapter, MessageIdHistoryPort, SpaceMetadataStorage, KeyManagementPort, MemberUpdatePendingStore, WireMessage } from '@web_of_trust/core/ports'
import type { IdentitySession, SpaceInfo, SpaceMemberChange, IncomingSpaceInvite, ReplicationState } from '@web_of_trust/core/types'
import {
  createSpaceKey, rotateSpaceKey, importKey, processMemberUpdate,
  resolveMemberUpdatesAgainstCanonical, canonicalEventSetAnswersPending,
  buildSpaceInviteBody, applySpaceInviteBody, buildKeyRotationBody, applyKeyRotationBody,
  deliverInboxMessage, receiveInboxMessage,
} from '@web_of_trust/core/application'
import type { LocalImpact } from '@web_of_trust/core/application'
import type {
  ProtocolCryptoAdapter, MemberUpdateSignal, SeenMemberUpdateSignal, SpaceInviteBody, KeyRotationBody,
  DidResolver, DidcommPlaintextMessage, InboxAckLocalOutcome, InboxMessageKind,
  MembershipEvent,
} from '@web_of_trust/core/protocol'
import {
  decryptOneShot, encryptOneShot, assertMemberUpdateBody, decodeBase64Url,
  assertSpaceInviteBody, assertKeyRotationBody,
  SPACE_INVITE_MESSAGE_TYPE, MEMBER_UPDATE_MESSAGE_TYPE, KEY_ROTATION_MESSAGE_TYPE,
  isDidcommMessage, isEncryptedInboxMessageType, INBOX_MESSAGE_TYPE,
  createAckMessage, evaluateInboxAckDisposition, createDidKeyResolver,
  formatMembershipEventKey, parseMembershipEventKey, resolveActiveMembers, assertMembershipEvent,
} from '@web_of_trust/core/protocol'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { VaultClient, base64ToUint8, VaultPushScheduler, InMemoryKeyManagementAdapter, InMemoryMemberUpdatePendingStore, InMemoryMessageIdHistory } from '@web_of_trust/core/adapters'
import { EncryptedMessagingNetworkAdapter } from './EncryptedMessagingNetworkAdapter'
import { CompactionService } from './CompactionService'
import {
  decodeSpaceInviteSnapshotPayload,
  encodeSpaceInviteSnapshotPayload,
  type SpaceInviteSnapshotPayload,
} from './space-invite-snapshot'

/**
 * Dekodiertes Inbox-Nachrichten-Ergebnis (accept-Zweig von receiveInboxMessage):
 * Inner-JWS verifiziert; die Message-ID wird erst bei konklusivem Ausgang in
 * der History recorded (Sync 003 Z.466 + Z.620-622, siehe handleInboxEnvelope).
 * senderDid ist der kryptographisch authentifizierte Sender (Sync 003
 * Z.460-464), NICHT das Envelope-Routing-from — löst #189-SPEC-DEFERRED S1 auf.
 */
interface DecodedInboxMessage {
  type: string
  senderDid: string
  body: Record<string, unknown>
  outerId: string
  extensionFields: Record<string, unknown>
}

function inboxMessageKindForType(type: string): InboxMessageKind {
  switch (type) {
    case SPACE_INVITE_MESSAGE_TYPE: return 'space-invite'
    case MEMBER_UPDATE_MESSAGE_TYPE: return 'member-update'
    case KEY_ROTATION_MESSAGE_TYPE: return 'key-rotation'
    case INBOX_MESSAGE_TYPE: return 'inbox'
    default: return 'unknown'
  }
}

type PendingSpaceMessageReason = 'unknown-space' | 'future-rotation'

/**
 * Durabler Puffer fuer key-rotation-Nachrichten, die noch nicht anwendbar sind
 * (VE-6a/VE-6b, Sync 002 Z.171-172/Z.231-235). Anders als im Yjs-Adapter gibt
 * es hier KEINEN content-Pfad-Puffer: der Old-World-content-Kanal laeuft ueber
 * den EncryptedMessagingNetworkAdapter. ACHTUNG CHECK-4-Befund (siehe
 * Kommentar dort): dessen Drop bei fehlender Generation heilt im laufenden
 * Sync NICHT strukturell — der content-Pending-Puffer ist ein offener
 * Stop-6-Scope-Entscheid.
 */
interface PendingSpaceMessage {
  spaceId: string
  /**
   * DIDComm-Inbox-Klartext (key-rotation): bereits verifiziert; die durable
   * Pufferung ist ein konklusiver Ausgang, daher recorded der Empfangspfad die
   * Message-ID direkt nach dem Buffern (Sync 003 Z.620-622). Die Wiedervorlage
   * laeuft NICHT erneut durch receiveInboxMessage, sonst wuerde die
   * Message-ID-History sie abweisen.
   */
  decoded: DecodedInboxMessage
  receivedAt: number
  reason: PendingSpaceMessageReason
  keyGeneration?: number
}

class PendingMessageNotDurableError extends Error {}

type DurablePendingStore = CompactStore & { list(): Promise<string[]> }

interface SpaceState {
  info: SpaceInfo
  documentId: DocumentId
  documentUrl: AutomergeUrl
  handles: Set<AutomergeSpaceHandle<any>>
  memberEncryptionKeys: Map<string, Uint8Array>
  // Pending member-update UX-Flags (Sync 005 Z.183-184). KEIN kanonischer State.
  // VE-7: beim Space-Restore aus dem KONFIGURIERTEN MemberUpdatePendingStore
  // re-deriviert (derivePendingMemberUpdateFlags); der Default-Store ist
  // InMemory — ein Pending ueberlebt den App-Neustart produktiv erst mit der
  // durablen Store-Verdrahtung (1.D).
  pendingRemoval?: { effectiveKeyGeneration: number }
  pendingAddition?: { effectiveKeyGeneration: number }
  // VE-1: Digest des Membership-Stands (createdBy + Event-Keys) — der
  // Doc-Change-Handler feuert auf JEDE Doc-Aenderung, der Digest filtert auf
  // membership-relevante Aenderungen (Analogon zum _members-Observer in Yjs).
  lastMembershipDigest?: string
  // Review-M1 Sequenzierung: zuletzt eingeplante Observer-Resolution-Chain —
  // handleMemberUpdate wartet sie ab, damit eine AELTERE kanonische Aenderung
  // nicht das gleich gespeicherte Pending aufloest (Z.194: die Aufloesung
  // gehoert dem NAECHSTEN Space-Sync, nicht dem vorherigen).
  membershipResolutionChain?: Promise<void>
  unsubDocChange?: () => void
}

/** Duck-typed interface for CompactStorageManager / InMemoryCompactStore */
export interface CompactStore {
  save(docId: string, binary: Uint8Array): Promise<void>
  load(docId: string): Promise<Uint8Array | null>
  delete(docId: string): Promise<void>
}

export interface AutomergeReplicationAdapterConfig {
  identity: IdentitySession
  messaging: MessagingAdapter
  /** Broker URLs advertised in space-invite bodies (Sync 005 Z.42). */
  brokerUrls?: readonly string[]
  /** Capability validity window override (default 6 months, Sync 003 Z.249). */
  capabilityValidityMs?: number
  /** New: automerge-repo metadata storage (no docBinary) */
  metadataStorage?: SpaceMetadataStorage
  /** Optional: automerge-repo StorageAdapter for doc persistence (e.g. IndexedDB) */
  repoStorage?: StorageAdapterInterface
  /** Optional: CompactStore for single-snapshot-per-doc persistence */
  compactStore?: CompactStore
  /** Optional: vault URL for persistent encrypted doc storage */
  vaultUrl?: string
  /** Optional: only restore spaces matching this filter (e.g. by appTag) */
  spaceFilter?: (info: SpaceInfo) => boolean
  /** Optional: protocol crypto adapter (defaults to WebCryptoProtocolCryptoAdapter) */
  crypto?: ProtocolCryptoAdapter
  /** Optional: key management port (defaults to InMemoryKeyManagementAdapter) */
  keyManagement?: KeyManagementPort
  /** Optional: member-update pending store (defaults to InMemoryMemberUpdatePendingStore) */
  memberUpdateStore?: MemberUpdatePendingStore
  /** DID-Resolver für Inner-JWS-Verifikation (Default: did:key, wie verifyEnvelope bisher). */
  didResolver?: DidResolver
  /** Replay-Schutz Sync 003 Z.466 (Default: InMemory; durable Store kommt mit 1.D). */
  messageIdHistory?: MessageIdHistoryPort
}

class AutomergeSpaceHandle<T> implements SpaceHandle<T> {
  readonly id: string
  private spaceState: SpaceState
  private docHandle: DocHandle<T>
  private vaultScheduler: VaultPushScheduler | null
  private compactScheduler: VaultPushScheduler | null
  private remoteUpdateCallbacks = new Set<() => void>()
  private closed = false
  private localChanging = false
  private unsubChange?: () => void

  constructor(spaceState: SpaceState, docHandle: DocHandle<T>, vaultScheduler: VaultPushScheduler | null, compactScheduler: VaultPushScheduler | null) {
    this.id = spaceState.info.id
    this.spaceState = spaceState
    this.docHandle = docHandle
    this.vaultScheduler = vaultScheduler
    this.compactScheduler = compactScheduler

    // Listen for doc changes — distinguish local from remote via flag
    const handler = () => {
      if (!this.localChanging) {
        this._notifyRemoteUpdate()
      }
    }
    this.docHandle.on('change', handler)
    this.unsubChange = () => this.docHandle.off('change', handler)
  }

  info(): SpaceInfo {
    return { ...this.spaceState.info }
  }

  getDoc(): T {
    return this.docHandle.doc() as T
  }

  getMeta(): import('@web_of_trust/core').SpaceDocMeta {
    return {}
  }

  transact(fn: (doc: T) => void, options?: TransactOptions): void {
    if (this.closed) throw new Error('Handle is closed')
    this.localChanging = true
    try {
      this.docHandle.change(fn as any)
    } finally {
      this.localChanging = false
    }
    // Schedule vault push — immediate for explicit actions, debounced for streaming
    if (this.vaultScheduler) {
      if (options?.stream) {
        this.vaultScheduler.pushDebounced()
      } else {
        this.vaultScheduler.pushImmediate()
      }
    }
    // Schedule CompactStore push — immediate for explicit actions, debounced for streaming
    if (this.compactScheduler) {
      if (options?.stream) {
        this.compactScheduler.pushDebounced()
      } else {
        this.compactScheduler.pushImmediate()
      }
    }
  }

  onRemoteUpdate(callback: () => void): () => void {
    this.remoteUpdateCallbacks.add(callback)
    return () => {
      this.remoteUpdateCallbacks.delete(callback)
    }
  }

  _notifyRemoteUpdate(): void {
    // No vault push here — the sender already pushed to vault.
    // But DO persist locally to CompactStore (debounced) so we have the merged state.
    if (this.compactScheduler) {
      this.compactScheduler.pushDebounced()
    }
    for (const cb of this.remoteUpdateCallbacks) {
      cb()
    }
  }

  close(): void {
    this.closed = true
    this.unsubChange?.()
    this.remoteUpdateCallbacks.clear()
    this.spaceState.handles.delete(this)
  }
}

export class AutomergeReplicationAdapter implements ReplicationAdapter {
  private identity: IdentitySession
  private messaging: MessagingAdapter
  private keyManagement: KeyManagementPort
  private readonly memberUpdateStore: MemberUpdatePendingStore
  private readonly didResolver: DidResolver
  private readonly messageIdHistory: MessageIdHistoryPort
  private readonly crypto: ProtocolCryptoAdapter
  private readonly brokerUrls: readonly string[]
  private readonly capabilityValidityMs?: number
  private metadataStorage: SpaceMetadataStorage | null
  private repoStorage: StorageAdapterInterface | undefined
  private compactStore: CompactStore | null = null
  private vault: VaultClient | null = null
  private spaces = new Map<string, SpaceState>()
  private state: ReplicationState = 'idle'
  private memberChangeCallbacks = new Set<(change: SpaceMemberChange) => void>()
  private spaceInviteListeners = new Set<(invite: IncomingSpaceInvite) => void>()
  private spacesSubscribers = new Set<(value: SpaceInfo[]) => void>()
  private unsubscribeMessaging: (() => void) | null = null
  /** Local seq counter per doc — avoids a getDocInfo HTTP call (and its 404) on first push */
  private vaultSeqs = new Map<string, number>()
  /** VaultPushScheduler per space — handles immediate/debounced vault pushes */
  private vaultSchedulers = new Map<string, VaultPushScheduler>()
  /** VaultPushScheduler per space for CompactStore (2s debounce) */
  private compactSchedulers = new Map<string, VaultPushScheduler>()
  /** Optional filter to restrict which spaces are restored (e.g. by appTag) */
  private spaceFilter: ((info: SpaceInfo) => boolean) | null

  // Buffer fuer key-rotation-Nachrichten, die erst nach Space-/Key-Ankunft
  // anwendbar sind (VE-6a/VE-6b) — durabel via CompactStore-Prefix-Keys.
  private pendingMessages = new Map<string, PendingSpaceMessage[]>()
  private processingPendingSpaces = new Set<string>()
  private static readonly PENDING_MESSAGE_PREFIX = '__wot_pending_space_message__:'

  private repo!: Repo
  private networkAdapter!: EncryptedMessagingNetworkAdapter

  constructor(config: AutomergeReplicationAdapterConfig) {
    this.identity = config.identity
    this.messaging = config.messaging
    this.keyManagement = config.keyManagement ?? new InMemoryKeyManagementAdapter()
    this.memberUpdateStore = config.memberUpdateStore ?? new InMemoryMemberUpdatePendingStore()
    this.didResolver = config.didResolver ?? createDidKeyResolver()
    this.messageIdHistory = config.messageIdHistory ?? new InMemoryMessageIdHistory()
    this.crypto = config.crypto ?? new WebCryptoProtocolCryptoAdapter()
    this.brokerUrls = config.brokerUrls ?? []
    this.capabilityValidityMs = config.capabilityValidityMs
    this.metadataStorage = config.metadataStorage ?? null
    this.repoStorage = config.repoStorage
    this.compactStore = config.compactStore ?? null
    this.spaceFilter = config.spaceFilter ?? null
    if (config.vaultUrl) {
      this.vault = new VaultClient(config.vaultUrl, config.identity)
    }
  }

  async start(): Promise<void> {
    // Create the network adapter (bridge to our MessagingAdapter)
    this.networkAdapter = new EncryptedMessagingNetworkAdapter(
      this.messaging,
      this.identity,
      this.keyManagement,
      this.crypto,
    )

    // Create the automerge-repo Repo
    this.repo = new Repo({
      peerId: this.identity.getDid() as PeerId,
      network: [this.networkAdapter],
      storage: this.repoStorage,
      // Share all documents with all peers (our NetworkAdapter handles routing)
      sharePolicy: async () => true,
    })

    // VE-6 (Sync 002 Z.171-172): durabel gepufferte key-rotations VOR dem
    // Space-Restore laden — der Restore replayed sie pro Space.
    await this.restorePendingMessages()

    // Restore persisted space metadata and group keys
    await this.restoreSpacesFromMetadata()

    this.state = 'idle'
    this._notifySpacesSubscribers()

    // Listen for application-level messages (invites, key rotation, member updates)
    this.unsubscribeMessaging = this.messaging.onMessage(
      (message) => this.handleMessage(message)
    )
  }

  /**
   * Restore spaces from metadata storage.
   * Called on start() and can be called again after remote sync
   * delivers new space metadata (e.g. multi-device sync).
   * Only loads spaces that aren't already known.
   */
  async restoreSpacesFromMetadata(): Promise<void> {
    if (!this.metadataStorage || !this.repo) return

    const persisted = await this.metadataStorage.loadAllSpaceMetadata()
    let changed = false
    for (const meta of persisted) {
      // Skip spaces we already know about
      if (this.spaces.has(meta.info.id)) continue

      // Skip spaces that don't match the filter (cross-app isolation)
      if (this.spaceFilter && !this.spaceFilter(meta.info as SpaceInfo)) continue

      const memberKeys = new Map<string, Uint8Array>()
      for (const [did, key] of Object.entries(meta.memberEncryptionKeys)) {
        memberKeys.set(did, key)
      }

      const spaceState: SpaceState = {
        info: meta.info,
        documentId: meta.documentId as DocumentId,
        documentUrl: meta.documentUrl as AutomergeUrl,
        handles: new Set(),
        memberEncryptionKeys: memberKeys,
      }
      this.spaces.set(meta.info.id, spaceState)

      // Register document with NetworkAdapter
      this.networkAdapter.registerDocument(spaceState.documentId, meta.info.id)

      // Register peers for this space
      for (const memberDid of meta.info.members) {
        if (memberDid !== this.identity.getDid()) {
          this.networkAdapter.registerSpacePeer(meta.info.id, memberDid)
        }
      }
      // Register self-as-other-device for multi-device sync
      this.networkAdapter.registerSelfPeer(meta.info.id)

      // Restore group keys first (needed for decrypting sync messages)
      const keys = await this.metadataStorage.loadGroupKeys(meta.info.id)
      for (const k of keys) {
        await importKey(this.keyManagement, k.spaceId, k.generation, k.key)
      }

      // Try CompactStore first (fastest — local snapshot, no decryption)
      let docRestored = false
      if (this.compactStore) {
        const restoredFromCompact = await this._restoreFromCompactStore(spaceState)
        if (restoredFromCompact) {
          docRestored = true
          console.log('[ReplicationAdapter] Restored space from CompactStore:', meta.info.name || meta.info.id)
        }
      }

      // Try vault second (avoids repo.find() putting doc in 'unavailable' state)
      if (!docRestored && this.vault) {
        const restoredFromVault = await this._restoreFromVault(spaceState)
        if (restoredFromVault) {
          docRestored = true
          console.log('[ReplicationAdapter] Restored space from vault:', meta.info.name || meta.info.id)
        }
      }

      if (!docRestored) {
        // Find the doc handle (triggers loading from storage or sync from peers)
        // Use short timeout — if not locally available, _waitForDoc handles async sync
        try {
          const handle = await this.repo.find(spaceState.documentUrl, {
            allowableStates: ['ready', 'unavailable'],
            signal: AbortSignal.timeout(2000),
          })
          docRestored = handle.isReady()
        } catch {
          // Timeout — doc not available yet
        }

        if (docRestored) {
          console.log('[ReplicationAdapter] Restored space from metadata:', meta.info.name || meta.info.id)
        } else {
          // No vault, vault empty, and doc not locally available — wait for live sync
          console.log('[ReplicationAdapter] Space registered, waiting for doc sync:', meta.info.name || meta.info.id)
          this._waitForDoc(spaceState)
        }
      }
      changed = true

      if (docRestored) {
        // VE-1: die members-Projektion kommt aus dem Event-Set des Docs — die
        // PersonalDoc-Metadata ist nur ein Cache (Seed im Attach).
        this.attachMembershipObserver(spaceState)
      }

      // VE-7 (Sync 005 Z.253): Pending-Flags aus dem konfigurierten
      // MemberUpdatePendingStore re-derivieren. Der Bestaetigungs-Sync bei
      // App-Start laeuft AM-seitig ueber den automerge-repo-Sync nach dem
      // Peer-Registrieren oben (VE-6d, siehe requestSync-Kommentar inkl.
      // CHECK-4-Grenze) plus die Vault-/CompactStore-Restore-Pfade.
      await this.derivePendingMemberUpdateFlags(spaceState)
      // Review-M1 (b): der wiederhergestellte kanonische Stand kann die Antwort
      // auf offene Pendings bereits tragen (canonical-first vor dem Neustart
      // bzw. Crash zwischen savePending und Resolution) — dann sofort
      // aufloesen statt auf einen neuen Sync zu warten (Sync 005 Z.253:
      // Bestaetigungs-Sync bei App-Start erneut versuchen). Unbeantwortete
      // Pendings bleiben offen.
      await this.resolveCanonicallyAnsweredMemberUpdates(spaceState)
      if (!this.spaces.has(meta.info.id)) continue // Restore-Resolution hat den Space aufgeraeumt

      // VE-6 (Sync 002 Z.237): durabel gepufferte key-rotations dieses Space
      // bei App-Start erneut pruefen.
      await this.processPendingForSpace(meta.info.id)
    }

    if (changed) {
      this._notifySpacesSubscribers()
    }
  }

  /**
   * Try to restore a space doc from the vault.
   * Returns true if doc was successfully imported from vault.
   */
  private async _restoreFromVault(spaceState: SpaceState): Promise<boolean> {
    if (!this.vault) return false

    const groupKey = await this.keyManagement.getCurrentKey(spaceState.info.id)
    if (!groupKey) {
      console.warn('[ReplicationAdapter] No group key for vault restore:', spaceState.info.name || spaceState.info.id)
      return false
    }

    try {
      const vaultData = await this.vault.getChanges(spaceState.info.id)

      // Try snapshot first
      if (vaultData.snapshot?.data) {
        const packed = base64ToUint8(vaultData.snapshot.data)
        const nonceLen = packed[0]
        const nonce = packed.slice(1, 1 + nonceLen)
        const ciphertext = packed.slice(1 + nonceLen)

        // OneShot vault snapshot: rebuild blob = nonce ‖ ciphertext+tag (Sync 001 Z.103).
        const blob = new Uint8Array(nonce.length + ciphertext.length)
        blob.set(nonce, 0)
        blob.set(ciphertext, nonce.length)
        const docBinary = await decryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, blob })

        const docHandle = this.repo.import<any>(docBinary, {
          docId: spaceState.documentId,
        })
        if (!docHandle.isReady()) docHandle.doneLoading()

        // Apply incremental changes after snapshot
        for (const change of vaultData.changes) {
          const changePacked = base64ToUint8(change.data)
          const changeNonceLen = changePacked[0]
          const changeNonce = changePacked.slice(1, 1 + changeNonceLen)
          const changeCiphertext = changePacked.slice(1 + changeNonceLen)

          const changeBlob = new Uint8Array(changeNonce.length + changeCiphertext.length)
          changeBlob.set(changeNonce, 0)
          changeBlob.set(changeCiphertext, changeNonce.length)
          const changeBinary = await decryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, blob: changeBlob })

          docHandle.merge(this.repo.import<any>(changeBinary, undefined as any) as any)
        }

        await this.repo.flush([spaceState.documentId])
        // Seed local seq counter from vault data
        const maxSeq = Math.max(
          vaultData.snapshot?.upToSeq ?? 0,
          ...vaultData.changes.map((c: any) => c.seq ?? 0),
        )
        if (maxSeq > 0) this.vaultSeqs.set(spaceState.info.id, maxSeq)
        return true
      }

      // No snapshot — try applying changes directly
      if (vaultData.changes.length > 0) {
        // First change becomes the doc — OneShot vault change (Sync 001 Z.103).
        const firstPacked = base64ToUint8(vaultData.changes[0].data)
        const firstNonceLen = firstPacked[0]
        const firstNonce = firstPacked.slice(1, 1 + firstNonceLen)
        const firstCiphertext = firstPacked.slice(1 + firstNonceLen)

        const firstBlob = new Uint8Array(firstNonce.length + firstCiphertext.length)
        firstBlob.set(firstNonce, 0)
        firstBlob.set(firstCiphertext, firstNonce.length)
        const firstBinary = await decryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, blob: firstBlob })

        const docHandle = this.repo.import<any>(firstBinary, {
          docId: spaceState.documentId,
        })
        if (!docHandle.isReady()) docHandle.doneLoading()

        // Apply remaining changes
        for (let i = 1; i < vaultData.changes.length; i++) {
          const changePacked = base64ToUint8(vaultData.changes[i].data)
          const changeNonceLen = changePacked[0]
          const changeNonce = changePacked.slice(1, 1 + changeNonceLen)
          const changeCiphertext = changePacked.slice(1 + changeNonceLen)

          const changeBlob = new Uint8Array(changeNonce.length + changeCiphertext.length)
          changeBlob.set(changeNonce, 0)
          changeBlob.set(changeCiphertext, changeNonce.length)
          const changeBinary = await decryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, blob: changeBlob })

          docHandle.merge(this.repo.import<any>(changeBinary, undefined as any) as any)
        }

        await this.repo.flush([spaceState.documentId])
        // Seed local seq counter from vault data
        const maxChangeSeq = Math.max(...vaultData.changes.map((c: any) => c.seq ?? 0))
        if (maxChangeSeq > 0) this.vaultSeqs.set(spaceState.info.id, maxChangeSeq)
        return true
      }
    } catch (err) {
      const spaceName = spaceState.info.name || spaceState.info.id
      if (err instanceof DOMException && err.name === 'OperationError') {
        console.warn(`[ReplicationAdapter] Vault decryption failed for "${spaceName}" — likely removed from space or key rotated`)
      } else {
        console.warn('[ReplicationAdapter] Vault restore failed for', spaceName, ':', err)
      }
    }

    return false
  }

  /**
   * Try to restore a space doc from the CompactStore.
   * Returns true if doc was successfully imported.
   */
  private async _restoreFromCompactStore(spaceState: SpaceState): Promise<boolean> {
    if (!this.compactStore) return false

    try {
      const binary = await this.compactStore.load(spaceState.info.id)
      if (!binary) return false

      const docHandle = this.repo.import<any>(binary, {
        docId: spaceState.documentId,
      })
      if (!docHandle.isReady()) docHandle.doneLoading()
      await this.repo.flush([spaceState.documentId])
      return true
    } catch (err) {
      console.warn('[ReplicationAdapter] CompactStore restore failed for', spaceState.info.name || spaceState.info.id, ':', err)
      return false
    }
  }

  /**
   * Save a snapshot to the CompactStore.
   * Two-phase: save with history immediately (fast), then compact in Worker.
   */
  private async _saveToCompactStore(spaceState: SpaceState): Promise<void> {
    if (!this.compactStore) return

    const docHandle = this.repo.handles[spaceState.documentId]
    const doc = docHandle?.doc()
    if (!doc) return

    // Phase 1: Save with history (fast, no main-thread block)
    const withHistory = Automerge.save(doc)
    await this.compactStore.save(spaceState.info.id, withHistory)

    // Phase 2: Compact in Web Worker (strips history, reduces size)
    const compactionService = CompactionService.getInstance()
    const compacted = await compactionService.compact(withHistory)
    if (compacted && compacted.length > 0) {
      await this.compactStore.save(spaceState.info.id, compacted)
    }
  }

  private async _pushSnapshotToVault(spaceState: SpaceState): Promise<void> {
    if (!this.vault) return

    const groupKey = await this.keyManagement.getCurrentKey(spaceState.info.id)
    if (!groupKey) return

    const docHandle = this.repo.handles[spaceState.documentId]
    const doc = docHandle?.doc()
    if (!doc) return

    // Save with history (fast), then compact in Worker before pushing to vault
    const withHistory = Automerge.save(doc)
    const compactionService = CompactionService.getInstance()
    const docBinary = await compactionService.compact(withHistory)

    const encrypted = await encryptOneShot({
      crypto: this.crypto,
      spaceContentKey: groupKey,
      plaintext: docBinary,
    })

    // Use local seq counter (avoids getDocInfo HTTP call + browser 404 log on first push)
    const currentSeq = this.vaultSeqs.get(spaceState.info.id) ?? 0
    const nextSeq = currentSeq + 1

    await this.vault.putSnapshot(
      spaceState.info.id,
      encrypted.ciphertextTag,
      encrypted.nonce,
      nextSeq,
    )
    this.vaultSeqs.set(spaceState.info.id, nextSeq)
  }

  /**
   * Background wait for a space doc that isn't locally available yet.
   * The doc may arrive via sync from another device.
   */
  private _waitForDoc(spaceState: SpaceState): void {
    void (async () => {
      try {
        // Wait up to 30s for the doc to arrive via sync
        const handle = await this.repo.find(spaceState.documentUrl, {
          allowableStates: ['ready'],
          signal: AbortSignal.timeout(30_000),
        })
        if (handle.isReady() && this.spaces.has(spaceState.info.id)) {
          console.log('[ReplicationAdapter] Doc arrived via sync for space:', spaceState.info.name || spaceState.info.id)
          // VE-1: Projektion + Observer erst jetzt — der Doc-Handle existiert
          // erst nach Ankunft via Sync.
          this.attachMembershipObserver(spaceState)
          this._notifySpacesSubscribers()
        }
      } catch {
        // Doc didn't arrive in time — that's ok, will retry on next restoreSpacesFromMetadata()
        console.log('[ReplicationAdapter] Doc did not arrive within timeout for space:', spaceState.info.name || spaceState.info.id)
      }
    })()
  }

  async stop(): Promise<void> {
    if (this.unsubscribeMessaging) {
      this.unsubscribeMessaging()
      this.unsubscribeMessaging = null
    }
    // Destroy vault schedulers
    for (const scheduler of this.vaultSchedulers.values()) scheduler.destroy()
    this.vaultSchedulers.clear()
    // Destroy compact store schedulers
    for (const scheduler of this.compactSchedulers.values()) scheduler.destroy()
    this.compactSchedulers.clear()
    this.vaultSeqs.clear()
    // In-memory cache only. Durable pending messages remain in CompactStore
    // until they are applied or the space is explicitly deleted.
    this.pendingMessages.clear()
    // Close all handles
    for (const space of this.spaces.values()) {
      space.unsubDocChange?.()
      space.unsubDocChange = undefined
      for (const handle of space.handles) {
        handle.close()
      }
    }
    // Shutdown the repo
    if (this.repo) {
      this.networkAdapter.disconnect()
      await this.repo.shutdown()
    }
    this.state = 'idle'
  }

  getState(): ReplicationState {
    return this.state
  }

  async createSpace<T>(type: 'personal' | 'shared', initialDoc: T, meta?: { name?: string; description?: string; appTag?: string; modules?: string[] }): Promise<SpaceInfo> {
    const spaceId = crypto.randomUUID()
    const myDid = this.identity.getDid()

    // Create doc in automerge-repo
    const docHandle = this.repo.create<T>(initialDoc)
    await docHandle.whenReady()

    // Set shared metadata in the doc's _meta object. appTag included: invited members must
    // inherit cross-app isolation (the invite carries no plaintext spaceInfo).
    docHandle.change((d: any) => {
      d._meta = d._meta ?? {}
      if (meta?.name) d._meta.name = meta.name
      if (meta?.description) d._meta.description = meta.description
      if (meta?.modules) d._meta.modules = meta.modules
      if (meta?.appTag) d._meta.appTag = meta.appTag
      // VE-2: Creator-DID einmalig im synchronisierten Doc — ersetzt die
      // members[0]-Admin-Approximation (divergierte beim Invitee auf den Inviter).
      d.createdBy = myDid
      // VE-1 (Sync 005 Z.163): kanonische Mitgliederliste als grow-only
      // Event-Set in doc.members — der Creator ist active@0.
      const selfEvent: MembershipEvent = { did: myDid, status: 'active', sinceGeneration: 0 }
      d.members = { [formatMembershipEventKey(selfEvent)]: selfEvent }
    })

    // Create group key + capability key pair + owner self-capability
    await createSpaceKey({ crypto: this.crypto, keyPort: this.keyManagement, spaceId, ownerDid: this.identity.getDid(), validityDurationMs: this.capabilityValidityMs })

    // Register document -> space mapping
    this.networkAdapter.registerDocument(docHandle.documentId, spaceId)

    // Register self-as-other-device as peer for multi-device sync
    // Use a different peerId suffix so automerge-repo doesn't think it's talking to itself
    this.networkAdapter.registerSelfPeer(spaceId)

    const info: SpaceInfo = {
      id: spaceId,
      type,
      name: meta?.name,
      description: meta?.description,
      modules: meta?.modules,
      appTag: meta?.appTag,
      members: [myDid],
      createdBy: myDid,
      createdAt: new Date().toISOString(),
    }

    const spaceState: SpaceState = {
      info,
      documentId: docHandle.documentId,
      documentUrl: docHandle.url,
      handles: new Set(),
      memberEncryptionKeys: new Map(),
    }
    this.spaces.set(spaceId, spaceState)
    this.attachMembershipObserver(spaceState)
    this._notifySpacesSubscribers()

    await this._persistSpaceMetadata(spaceState)
    // Flush repo so the doc is persisted to IndexedDB
    await this.repo.flush([docHandle.documentId])

    // Save initial snapshot to CompactStore (fire-and-forget)
    this._saveToCompactStore(spaceState).catch(() => {})

    // Push initial snapshot to vault (fire-and-forget)
    this._pushSnapshotToVault(spaceState).catch(() => {})

    return { ...info }
  }

  async getSpaces(): Promise<SpaceInfo[]> {
    return this._getSpacesSnapshot()
  }

  watchSpaces(): Subscribable<SpaceInfo[]> {
    return {
      subscribe: (callback: (value: SpaceInfo[]) => void) => {
        this.spacesSubscribers.add(callback)
        return () => { this.spacesSubscribers.delete(callback) }
      },
      getValue: () => this._getSpacesSnapshot(),
    }
  }

  private _getSpacesSnapshot(): SpaceInfo[] {
    return Array.from(this.spaces.values()).map(s => ({ ...s.info }))
  }

  private _notifySpacesSubscribers(): void {
    const snapshot = this._getSpacesSnapshot()
    for (const cb of this.spacesSubscribers) {
      cb(snapshot)
    }
  }

  async getSpace(spaceId: string): Promise<SpaceInfo | null> {
    const space = this.spaces.get(spaceId)
    if (!space) return null
    return { ...space.info }
  }

  async openSpace<T>(spaceId: string): Promise<SpaceHandle<T>> {
    const space = this.spaces.get(spaceId)
    if (!space) {
      throw new Error(`Unknown space: ${spaceId}`)
    }

    // Use Promise.race to enforce our own timeout (automerge-repo's internal
    // withTimeout is 60s and ignores the signal for cached handles)
    const docHandle = await Promise.race([
      this.repo.find<T>(space.documentUrl, {
        allowableStates: ['ready', 'unavailable'],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Space document timeout: ${spaceId}`)), 10_000)
      ),
    ])
    if (!docHandle.isReady()) {
      throw new Error(`Space document not ready: ${spaceId}`)
    }

    // Create or reuse VaultPushScheduler for this space
    let scheduler = this.vaultSchedulers.get(spaceId) ?? null
    if (!scheduler && this.vault) {
      scheduler = new VaultPushScheduler({
        pushFn: () => this._pushSnapshotToVault(space),
        getHeadsFn: () => {
          const doc = docHandle.doc()
          return doc ? Automerge.getHeads(doc).join(',') : null
        },
        debounceMs: 5000,
      })
      this.vaultSchedulers.set(spaceId, scheduler)
    }

    // Create or reuse CompactStore scheduler (2s debounce)
    let compactSched = this.compactSchedulers.get(spaceId) ?? null
    if (!compactSched && this.compactStore) {
      compactSched = new VaultPushScheduler({
        pushFn: () => this._saveToCompactStore(space),
        getHeadsFn: () => {
          const doc = docHandle.doc()
          return doc ? Automerge.getHeads(doc).join(',') : null
        },
        debounceMs: 2000,
      })
      this.compactSchedulers.set(spaceId, compactSched)
    }

    const handle = new AutomergeSpaceHandle<T>(space, docHandle, scheduler, compactSched)
    space.handles.add(handle)

    return handle
  }

  async addMember(
    spaceId: string,
    memberDid: string,
    memberEncryptionPublicKey: Uint8Array,
  ): Promise<void> {
    const space = this.spaces.get(spaceId)
    if (!space) throw new Error(`Unknown space: ${spaceId}`)

    // C3 (Sync 005 Z.42): brokerUrls MUST be non-empty for a space-invite. Fail fast
    // BEFORE any state mutation so a misconfigured runtime cannot leave a half-added
    // member (stored encryption key / extended members list) behind.
    if (this.brokerUrls.length === 0) {
      throw new Error('addMember/invite requires brokerUrls in AutomergeReplicationAdapterConfig (Sync 005 Z.42)')
    }

    const myDid = this.identity.getDid()

    // RE-INVITE-GUARD (VE-1): existiert fuer die DID ein removed-Event mit
    // sinceGeneration >= aktueller Generation, wuerde ein active-Event auf der
    // aktuellen Generation per Z.305 (hoehere Generation gewinnt) bzw. per
    // removed-Tie-Break verlieren. Tie-Break-Folge: erst rotieren (neue
    // Generation), dann active@newGen schreiben. Das ist zugleich sicherheitlich
    // korrekt — der zuvor Entfernte kennt die alten Keys.
    let currentGeneration = await this.keyManagement.getCurrentGeneration(spaceId)
    const docHandleForGuard = this.repo.handles[space.documentId]
    const removalGenerations = this.readMembershipEvents(docHandleForGuard?.doc())
      .filter((event) => event.did === memberDid && event.status === 'removed')
      .map((event) => event.sinceGeneration)
    while (removalGenerations.some((generation) => generation >= currentGeneration)) {
      currentGeneration = await this.rotateSpaceKeyAndDistribute(space)
    }

    // Store encryption public key
    space.memberEncryptionKeys.set(memberDid, memberEncryptionPublicKey)

    // VE-1: kanonisches active-Event VOR dem Invite-Send, damit der
    // encryptedDocSnapshot die vollstaendige Mitgliederliste inkl. des Invitees
    // traegt. Projektion space.info.members + Peer-Registrierung uebernimmt
    // der Doc-Change-Handler (ein Update-Pfad).
    // ACHTUNG Alt-Spaces: Spaces ohne members-Events kollabieren beim ersten
    // Write auf die Event-Projektion (die gecachte Liste wird durch die
    // aktiven DIDs aus dem Event-Set ersetzt — hier nur der Invitee).
    // Bewusster Bruch, Alt-Spaces sind neu zu erstellen
    // (Anton-Entscheid 2026-06-11).
    this.writeMembershipEvent(space, {
      did: memberDid,
      status: 'active',
      sinceGeneration: currentGeneration,
      addedBy: myDid,
    })

    // Spec-conformant invite body (Sync 005 Z.62-103): all content keys + capability +
    // signing key. SPEC-APPROX: adminDids = [createdBy] (full list in 1.B.3-admin-management).
    const inviteBody = await buildSpaceInviteBody({
      keyPort: this.keyManagement,
      spaceId,
      recipientDid: memberDid,
      brokerUrls: this.brokerUrls,
      adminDids: [this.spaceCreatorDid(space)],
      validityDurationMs: this.capabilityValidityMs,
    })

    // Demo-Extension (VE-5, outside the spec body): the initial doc snapshot rides as
    // extension field next to the ECIES container (OneShot blob under the current
    // content key, Base64URL) — NOT in SpaceInviteBody, NOT im Inner-JWS (selbst
    // verschlüsselt, kein Autoritätsträger). M2 (Review): die documentUrl
    // (automerge-repo Doc-Routing — der Empfänger importiert unter derselben
    // docId, damit automerge-repo via NetworkAdapter synct) reist IM
    // verschlüsselten Blob statt als unauthentifizierte Wire-Extension: AES-GCM
    // schützt die Integrität, ein untrusted Broker kann die Doc-Bindung nicht
    // austauschen (Sync 005 Z.68-90 kennt kein documentUrl-Feld im Body).
    // Display metadata (name/description/image/modules) travels inside the
    // encrypted doc's _meta.
    const groupKey = (await this.keyManagement.getKeyByGeneration(spaceId, inviteBody.currentKeyGeneration))!
    const docHandle = this.repo.handles[space.documentId]
    const doc = docHandle?.doc()
    if (!doc) throw new Error(`Cannot access doc for space: ${spaceId}`)
    const docBinary = Automerge.save(doc)
    const docSnapshot = await encryptOneShot({
      crypto: this.crypto,
      spaceContentKey: groupKey,
      plaintext: encodeSpaceInviteSnapshotPayload({ documentUrl: space.documentUrl, docBinary }),
    })

    // Sync 003 Z.446-456: Klartext-Body → Inner-JWS (Identity-Key) → ECIES für den
    // Empfänger → DIDComm-Envelope. Key-Material reist nie im Klartext.
    const envelope = await deliverInboxMessage({
      type: SPACE_INVITE_MESSAGE_TYPE,
      body: inviteBody as unknown as Record<string, unknown>,
      from: myDid,
      to: memberDid,
      recipientEncryptionPublicKey: memberEncryptionPublicKey,
      sign: (input) => this.identity.signEd25519(input),
      crypto: this.crypto,
      extensionFields: { encryptedDocSnapshot: docSnapshot.blobBase64Url },
    })
    await this.messaging.send(envelope)

    // VE-3: Die frueheren Backfill-member-updates an den Invitee sind ersatzlos
    // entfallen — der Invite-Snapshot traegt mit VE-1 das kanonische
    // doc.members-Event-Set, Backfill erzeugte nur widerspruechliche
    // Pending-Signale.

    // Notify existing members about the new member (member-update). member-update ist
    // eine Inbox-Nachricht: ECIES für den jeweiligen Empfänger (Sync 003 Z.500 MUSS).
    const generation = inviteBody.currentKeyGeneration
    for (const existingDid of space.info.members) {
      if (existingDid === myDid || existingDid === memberDid) continue

      const encPub = space.memberEncryptionKeys.get(existingDid)
      if (!encPub) {
        // Ohne Empfänger-Encryption-Key keine spec-konforme Zustellung möglich —
        // kein Klartext-Fallback (Sync 003 Z.500). Key-Discovery via Sync 004
        // (keyAgreement im DID-Dokument) ist der vorgesehene Vervollständigungspfad.
        console.warn('[ReplicationAdapter] No encryption key for', existingDid, '— skipping member-update delivery')
        continue
      }

      const updateEnvelope = await deliverInboxMessage({
        type: MEMBER_UPDATE_MESSAGE_TYPE,
        body: {
          spaceId,
          action: 'added',
          memberDid,
          effectiveKeyGeneration: generation,
        },
        from: myDid,
        to: existingDid,
        recipientEncryptionPublicKey: encPub,
        sign: (input) => this.identity.signEd25519(input),
        crypto: this.crypto,
      })
      try { await this.messaging.send(updateEnvelope) } catch { /* offline */ }
    }

    await this._persistSpaceMetadata(space)

    // Push updated snapshot to vault (fire-and-forget)
    this._pushSnapshotToVault(space).catch(() => {})

    // Notify member change listeners
    for (const cb of this.memberChangeCallbacks) {
      cb({ spaceId, did: memberDid, action: 'added' })
    }
  }

  async removeMember(spaceId: string, memberDid: string): Promise<void> {
    const space = this.spaces.get(spaceId)
    if (!space) throw new Error(`Unknown space: ${spaceId}`)

    const myDid = this.identity.getDid()
    // Den Encryption-Key des Entfernten VOR dem Löschen sichern — er bekommt unten
    // noch sein member-update (Sync 005 Z.238) als ECIES-Inbox-Nachricht.
    const removedMemberEncryptionKey = space.memberEncryptionKeys.get(memberDid)
    space.memberEncryptionKeys.delete(memberDid)

    // Sync 005 Z.229-231: die Mitgliederlisten-Aenderung ist die kanonische
    // CRDT-Operation und passiert VOR der Rotation — als removed@newGen, damit
    // das Event gegen konkurrierende active-Events aelterer Generationen gewinnt
    // (Z.305). Projektion space.info.members + Peer-Deregistrierung uebernimmt
    // der Doc-Change-Handler (ein Update-Pfad).
    // ACHTUNG Alt-Spaces: Spaces ohne members-Events kollabieren beim ersten
    // Write auf die Event-Projektion (die gecachte Liste wird durch die
    // aktiven DIDs aus dem Event-Set ersetzt — hier leer). Bewusster Bruch,
    // Alt-Spaces sind neu zu erstellen (Anton-Entscheid 2026-06-11).
    const newGeneration = (await this.keyManagement.getCurrentGeneration(spaceId)) + 1
    this.writeMembershipEvent(space, { did: memberDid, status: 'removed', sinceGeneration: newGeneration })

    // Rotate group key + fresh capability key pair + self-capability und an die
    // REMAINING members verteilen (Sync 005 Z.230/Z.276). The removed member
    // is NOT in memberEncryptionKeys (deleted above), so it does not receive a
    // key-rotation — it only receives a member-update below (Sync 005 Z.238).
    await this.rotateSpaceKeyAndDistribute(space)

    // Notify remaining members AND the removed member (Sync 005 Z.238). member-update
    // ist eine Inbox-Nachricht: ECIES für den jeweiligen Empfänger (Sync 003 Z.500 MUSS) —
    // der Group-Key-OneShot-Pfad ist tot.
    const notifyDids = [...space.info.members, memberDid]
    const clearBody = {
      spaceId,
      memberDid,
      action: 'removed' as const,
      effectiveKeyGeneration: newGeneration,
    }

    for (const did of notifyDids) {
      if (did === myDid) continue

      const encPub = did === memberDid ? removedMemberEncryptionKey : space.memberEncryptionKeys.get(did)
      if (!encPub) {
        // Ohne Empfänger-Encryption-Key keine spec-konforme Zustellung möglich —
        // kein Klartext-Fallback (Sync 003 Z.500). Key-Discovery via Sync 004
        // (keyAgreement im DID-Dokument) ist der vorgesehene Vervollständigungspfad.
        console.warn('[ReplicationAdapter] No encryption key for', did, '— skipping member-update delivery')
        continue
      }

      const updateEnvelope = await deliverInboxMessage({
        type: MEMBER_UPDATE_MESSAGE_TYPE,
        body: clearBody,
        from: myDid,
        to: did,
        recipientEncryptionPublicKey: encPub,
        sign: (input) => this.identity.signEd25519(input),
        crypto: this.crypto,
      })
      try { await this.messaging.send(updateEnvelope) } catch { /* offline */ }
    }

    await this._persistSpaceMetadata(space)

    // Re-encrypt and push snapshot with new generation key so the Vault always
    // has a snapshot decryptable with the current key (fire-and-forget).
    this._pushSnapshotToVault(space).catch(() => {})

    // Notify member change listeners
    for (const cb of this.memberChangeCallbacks) {
      cb({ spaceId, did: memberDid, action: 'removed' })
    }
  }

  /**
   * Rotiert den Space-Key auf Generation+1 und verteilt die key-rotation an
   * alle Empfaenger in memberEncryptionKeys. Gemeinsamer Pfad fuer removeMember
   * (Sync 005 Z.230/Z.276) und den Re-Invite-Guard in addMember (VE-1).
   * Multi-Device-Verteilung der eigenen Keys laeuft AM-seitig ueber die
   * PersonalDoc-Metadata (_persistSpaceMetadata speichert alle Generationen) —
   * die eigene DID braucht keine key-rotation-Nachricht. Liefert die neue
   * Generation.
   */
  private async rotateSpaceKeyAndDistribute(space: SpaceState): Promise<number> {
    const spaceId = space.info.id
    const myDid = this.identity.getDid()

    await rotateSpaceKey({ crypto: this.crypto, keyPort: this.keyManagement, spaceId, ownerDid: myDid, validityDurationMs: this.capabilityValidityMs })
    const newGeneration = await this.keyManagement.getCurrentGeneration(spaceId)

    for (const [did, encPubKey] of space.memberEncryptionKeys.entries()) {
      if (did === myDid) continue

      const rotationBody = await buildKeyRotationBody({
        keyPort: this.keyManagement,
        spaceId,
        newGeneration,
        recipientDid: did,
        validityDurationMs: this.capabilityValidityMs,
      })
      // Sync 003 Z.446-456/Z.500: Inner-JWS + ECIES für den Empfänger — content key +
      // signing key + capability never plaintext.
      const envelope = await deliverInboxMessage({
        type: KEY_ROTATION_MESSAGE_TYPE,
        body: rotationBody as unknown as Record<string, unknown>,
        from: myDid,
        to: did,
        recipientEncryptionPublicKey: encPubKey,
        sign: (input) => this.identity.signEd25519(input),
        crypto: this.crypto,
      })
      await this.messaging.send(envelope)
    }
    return newGeneration
  }

  /**
   * VE-2: Creator-DID als Admin-Approximation (knownAdminDids = [createdBy]).
   * SPEC-APPROX: Fallback members[0] nur fuer Alt-Spaces ohne createdBy-Feld;
   * die volle Admin-Liste kommt mit 1.B.3-admin-management.
   */
  private spaceCreatorDid(space: SpaceState): string {
    return space.info.createdBy ?? space.info.members[0]
  }

  /**
   * Liest das doc.members-Event-Set (VE-1) defensiv: Eintraege, deren Value
   * nicht als MembershipEvent validiert oder deren Key nicht zum Value passt,
   * werden uebersprungen — ein fehlerhafter Peer darf die Projektion nicht
   * kippen.
   */
  private readMembershipEvents(doc: unknown): MembershipEvent[] {
    const events: MembershipEvent[] = []
    const members = (doc as { members?: unknown } | undefined)?.members
    if (members === null || members === undefined || typeof members !== 'object' || Array.isArray(members)) {
      return events
    }
    for (const [key, value] of Object.entries(members as Record<string, unknown>)) {
      try {
        // Automerge-Proxy → plain object, damit assertMembershipEvent die
        // Key-Menge prueft.
        const plain = value !== null && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : value
        assertMembershipEvent(plain)
        const parts = parseMembershipEventKey(key)
        if (parts.did !== plain.did || parts.sinceGeneration !== plain.sinceGeneration || parts.status !== plain.status) {
          throw new Error('membership-event key/value mismatch')
        }
        events.push(plain)
      } catch (err) {
        console.warn('[ReplicationAdapter] Skipping invalid membership event:', key, err)
      }
    }
    return events
  }

  /**
   * Deterministischer Doc-Bootstrap fuer Invites OHNE Snapshot-Binary
   * (Review-Minor): alle Peers, die ab leerem docBinary initialisieren,
   * erzeugen mit festem Actor (aus der spaceId abgeleitet) und time 0 die
   * byte-identische Initial-Change inklusive members-Container — der
   * CRDT-Merge dedupliziert sie, konkurrierende Container-Erstellung
   * (Property-Konflikt, Event-Verlust) ist fuer diesen Pfad strukturell
   * ausgeschlossen. Der Container existiert damit, BEVOR irgendein Peer ein
   * Membership-Event schreiben kann.
   */
  private inviteBootstrapBinary(spaceId: string): Uint8Array {
    const actor = Array.from(new TextEncoder().encode(spaceId))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    const seeded = Automerge.change(
      Automerge.init<{ members: Record<string, unknown> }>({ actor }),
      { time: 0 },
      (d) => { d.members = {} },
    )
    return Automerge.save(seeded)
  }

  /**
   * Grow-only Schreiber (VE-1): Events werden ausschliesslich hinzugefuegt, nie
   * ueberschrieben oder geloescht — konkurrierende Schreiber treffen verschiedene
   * Record-Keys, derselbe Key traegt denselben semantischen Inhalt (idempotent).
   * AM-idiomatisch als change()-Block.
   *
   * Grenze des lazy-Inits unten (Review-Minor, bewusst akzeptiert): legt er den
   * Container an, kann ein KONKURRIERENDER Erst-Write eines anderen Peers Events
   * per Property-Konflikt verlieren (Automerge haelt konkurrierende Zuweisungen
   * auf denselben Key als Multi-Value; Writes in den unterlegenen Container sind
   * in der Merge-Sicht unsichtbar). NEUE Flows treffen diese Grenze nicht mehr:
   * createSpace und der Invite-Apply (inviteBootstrapBinary, deterministischer
   * Seed) legen den Container vorab an. Erreichbar bleibt sie nur fuer
   * Alt-Spaces ohne members-Events — dort gilt der akzeptierte Bruch
   * (Anton-Entscheid 2026-06-11): Alt-Spaces sind neu zu erstellen.
   */
  private writeMembershipEvent(space: SpaceState, event: MembershipEvent): void {
    const docHandle = this.repo.handles[space.documentId]
    const doc = docHandle?.doc() as { members?: Record<string, unknown> } | undefined
    if (!docHandle || !doc) throw new Error(`Cannot access doc for space: ${space.info.id}`)
    const key = formatMembershipEventKey(event)
    if (doc.members && key in doc.members) return
    docHandle.change((d: any) => {
      if (!d.members) d.members = {}
      d.members[key] = { ...event }
    })
  }

  /**
   * VE-1: space.info.members ist eine read-only Projektion des doc.members-
   * Event-Sets. EIN Update-Pfad: der Doc-Change-Handler (lokal + remote)
   * berechnet die Projektion via resolveActiveMembers, reconciliert die
   * Sync-Peers, persistiert die Metadata und stoesst die VE-4-Resolution an
   * (Analogon zum _members-Observer im Yjs-Adapter).
   */
  private attachMembershipObserver(space: SpaceState): void {
    if (space.unsubDocChange) return
    const docHandle = this.repo.handles[space.documentId]
    if (!docHandle) return
    const handler = () => this.onSpaceDocMembershipChanged(space)
    docHandle.on('change', handler)
    space.unsubDocChange = () => docHandle.off('change', handler)
    this.seedMembershipProjection(space)
  }

  private computeMembershipProjection(doc: unknown): { digest: string; createdBy?: string; members: string[] | null } {
    const createdByRaw = (doc as { createdBy?: unknown } | undefined)?.createdBy
    const createdBy = typeof createdByRaw === 'string' ? createdByRaw : undefined
    const events = this.readMembershipEvents(doc)
    const digest = JSON.stringify([createdBy ?? null, events.map((event) => formatMembershipEventKey(event)).sort()])
    // Ohne Events (Alt-Space / Bootstrap vor dem ersten Sync) bleibt die
    // bestehende Projektion stehen, bis der CRDT-Merge Events liefert
    // (Sync 002 Z.158: ein Snapshot rollt bekannte Ops nicht zurueck).
    const members = events.length > 0 ? resolveActiveMembers(events) : null
    return { digest, createdBy, members }
  }

  /** Uebernimmt createdBy + members-Projektion in info und reconciliert die Sync-Peers. */
  private applyMembershipProjection(space: SpaceState, projection: { createdBy?: string; members: string[] | null }): boolean {
    let changed = false
    if (projection.createdBy !== undefined && projection.createdBy !== space.info.createdBy) {
      space.info = { ...space.info, createdBy: projection.createdBy }
      changed = true
    }
    if (projection.members !== null && JSON.stringify(projection.members) !== JSON.stringify(space.info.members)) {
      // Peer-Reconciliation: AM-Aequivalent der members-basierten Sende-Schleife
      // im Yjs-Adapter — neue aktive Members syncen, entfernte nicht mehr.
      const myDid = this.identity.getDid()
      const previous = new Set(space.info.members)
      const next = new Set(projection.members)
      for (const did of projection.members) {
        if (did !== myDid && !previous.has(did)) this.networkAdapter.registerSpacePeer(space.info.id, did)
      }
      for (const did of previous) {
        if (did !== myDid && !next.has(did)) this.networkAdapter.unregisterSpacePeer(space.info.id, did)
      }
      space.info = { ...space.info, members: projection.members }
      changed = true
    }
    return changed
  }

  /**
   * Initiale Projektion beim Attach (createSpace/Invite-Apply/Restore): Digest
   * + info-Stand aus dem Doc uebernehmen, Peers registrieren — OHNE
   * vollstaendige Resolution und OHNE Metadata-Write: ein Restore/Import ist
   * kein Space-Sync (Sync 005 Z.194: vollstaendige Aufloesung erst nach dem
   * NAECHSTEN Space-Sync). Bereits BEANTWORTETE Pendings loest der Restore-
   * Pfad separat auf (Review-M1 (b), resolveCanonicallyAnsweredMemberUpdates
   * in restoreSpacesFromMetadata).
   */
  private seedMembershipProjection(space: SpaceState): void {
    const doc = this.repo.handles[space.documentId]?.doc()
    if (!doc) return
    const projection = this.computeMembershipProjection(doc)
    space.lastMembershipDigest = projection.digest
    this.applyMembershipProjection(space, projection)
    // Bootstrap-Peers (idempotent): auch die Faelle ohne Projektion-Diff
    // (z.B. Restore, wo Metadata-Cache und Doc uebereinstimmen) syncen.
    const myDid = this.identity.getDid()
    for (const did of space.info.members) {
      if (did !== myDid) this.networkAdapter.registerSpacePeer(space.info.id, did)
    }
  }

  private onSpaceDocMembershipChanged(space: SpaceState): void {
    const doc = this.repo.handles[space.documentId]?.doc()
    if (!doc) return
    const projection = this.computeMembershipProjection(doc)
    if (projection.digest === space.lastMembershipDigest) return
    space.lastMembershipDigest = projection.digest

    const changed = this.applyMembershipProjection(space, projection)
    if (changed) this._notifySpacesSubscribers()

    if (projection.members === null) return
    // #181b-Analogon: der Digest triggert auch bei reinen Event-Aenderungen
    // ohne Projektion-Aenderung. Danach die VE-4-Resolution (Sync 005
    // Z.194-198) — sequenziell, damit ein Resolution-Cleanup
    // (deleteSpaceMetadata) nicht mit dem Metadata-Write racet.
    const members = projection.members
    // Review-M1 Sequenzierung: die Chain wird am Space-State gemerkt, damit
    // handleMemberUpdate sie VOR savePending abwarten kann (sonst loeste die
    // hier eingeplante Resolution ein NACH ihr gespeichertes Pending gegen den
    // aelteren kanonischen Stand auf — Deadlock-Variante des M1-Befunds).
    space.membershipResolutionChain = this._persistSpaceMetadata(space)
      .then(() => this.resolvePendingMemberUpdates(space, members))
      .catch((err) => console.warn('[ReplicationAdapter] member-update resolution failed:', err))
  }

  /**
   * VE-4 (Sync 005 Z.194-198 MUSS): loest Pending-member-updates gegen die
   * kanonische Mitgliederliste auf — aufgerufen bei jeder kanonischen
   * doc.members-Aenderung (Doc-Change-Handler). confirmed (Z.196-197) und
   * discarded (Z.198, Widerspruch: verwerfen, kanonischen State behalten)
   * werden via resolvePending aus dem Pending-Store entfernt; die UX-Flags
   * werden aus dem verbleibenden Store-Stand re-deriviert (discarded setzt
   * Flags zurueck, loest aber KEIN Cleanup aus).
   */
  private async resolvePendingMemberUpdates(space: SpaceState, canonicalActiveMembers: readonly string[]): Promise<void> {
    const pending = await this.memberUpdateStore.listSeenForSpace(space.info.id)
    await this.applyMemberUpdateResolution(space, canonicalActiveMembers, pending)
  }

  /**
   * Review-M1 (Sync 005 Z.194/Z.253): loest NUR die Pendings auf, deren Antwort
   * das kanonische doc.members-Event-Set BEREITS traegt (canonicalEventSet-
   * AnswersPending, generationssicher inkl. removed-Tie-Break). Noetig fuer die
   * canonical-first-Reihenfolge: das Doc-Update reist per Z.231-Design vor der
   * Rotation und ist mit dem alten Key entschluesselbar — der Doc-Change-
   * Handler lief dann VOR savePending mit leerer Pending-Liste, und ohne
   * diesen Pfad wuerde das Pending nie aufgeloest (Deadlock). Laeuft nach
   * savePending (handleMemberUpdate, replayFutureMemberUpdates) und beim
   * Restore mit nicht-leerem Event-Set. Konservativ: ohne feststehende Antwort
   * bleibt das Pending offen — die vollstaendige Aufloesung gehoert dem
   * naechsten Space-Sync (Doc-Change-Handler-Pfad).
   */
  private async resolveCanonicallyAnsweredMemberUpdates(space: SpaceState): Promise<void> {
    const doc = this.repo.handles[space.documentId]?.doc()
    if (!doc) return
    const events = this.readMembershipEvents(doc)
    if (events.length === 0) return
    const pending = await this.memberUpdateStore.listSeenForSpace(space.info.id)
    const answered = pending.filter((signal) => canonicalEventSetAnswersPending(events, signal))
    if (answered.length === 0) return
    await this.applyMemberUpdateResolution(space, resolveActiveMembers(events), answered)
  }

  private async applyMemberUpdateResolution(
    space: SpaceState,
    canonicalActiveMembers: readonly string[],
    pending: readonly SeenMemberUpdateSignal[],
  ): Promise<void> {
    const spaceId = space.info.id
    // Reentranz-Guard (Review-M1): die Resolution feuert aus Doc-Change-,
    // savePending- und Restore-Pfad — nach einem Cleanup (Space deregistriert)
    // ist jede noch anstehende Resolution ein No-op (kein Doppel-Cleanup).
    if (this.spaces.get(spaceId) !== space) return
    if (pending.length === 0) return

    const resolution = resolveMemberUpdatesAgainstCanonical({
      pending,
      canonicalActiveMembers,
      localDid: this.identity.getDid(),
    })
    for (const signal of resolution.confirmed) {
      await this.memberUpdateStore.resolvePending(spaceId, signal)
    }
    for (const signal of resolution.discarded) {
      await this.memberUpdateStore.resolvePending(spaceId, signal)
    }
    await this.derivePendingMemberUpdateFlags(space)

    if (resolution.localRemovalConfirmed) {
      // Sync 005 Z.253 Weg (a): erst die kanonische Bestaetigung der eigenen
      // Entfernung macht den lokalen Austritt dauerhaft — Cleanup ueber die
      // leaveSpace-Mechanik, AUSSCHLIESSLICH aus diesem Resolution-Pfad.
      // Bestaetigungsweg (b) CAPABILITY_GENERATION_STALE ist SPEC-DEFERRED
      // (Broker-Runtime-Check fehlt, Broker-Conformance-Slice).
      await this.cleanupSpaceLocally(spaceId)
    }
  }

  /**
   * VE-7: pendingRemoval/pendingAddition aus dem KONFIGURIERTEN Pending-Store
   * re-derivieren — pro action gewinnt die hoechste effectiveKeyGeneration;
   * konkurrieren beide actions, gewinnt die hoehere Generation, bei
   * Gleichstand konservativ removed (analog zum Membership-Tie-Break). Nur
   * autorisierte Pendings tragen UX-Wirkung (Sync 005 Z.183-184). Laeuft beim
   * Space-Restore und nach jeder Resolution.
   */
  private async derivePendingMemberUpdateFlags(space: SpaceState): Promise<void> {
    const seen = await this.memberUpdateStore.listSeenForSpace(space.info.id)
    const localDid = this.identity.getDid()
    let removal: number | undefined
    let addition: number | undefined
    for (const signal of seen) {
      if (signal.memberDid !== localDid) continue
      if (signal.storedDisposition !== 'store-pending-and-sync') continue
      if (signal.action === 'removed') {
        removal = removal === undefined ? signal.effectiveKeyGeneration : Math.max(removal, signal.effectiveKeyGeneration)
      } else {
        addition = addition === undefined ? signal.effectiveKeyGeneration : Math.max(addition, signal.effectiveKeyGeneration)
      }
    }
    if (removal !== undefined && addition !== undefined) {
      if (addition > removal) removal = undefined
      else addition = undefined
    }
    if (removal !== undefined) {
      space.pendingRemoval = { effectiveKeyGeneration: removal }
      delete space.pendingAddition
    } else if (addition !== undefined) {
      space.pendingAddition = { effectiveKeyGeneration: addition }
      delete space.pendingRemoval
    } else {
      delete space.pendingRemoval
      delete space.pendingAddition
    }
  }

  /** Wendet die lokale UX-Wirkung eines member-update an (Sync 005 Z.183-184). */
  private applyMemberUpdateLocalImpact(space: SpaceState, localImpact: LocalImpact, signal: MemberUpdateSignal): void {
    switch (localImpact) {
      case 'mark-removal-pending':
        space.pendingRemoval = { effectiveKeyGeneration: signal.effectiveKeyGeneration }
        delete space.pendingAddition // mutually exclusive
        break
      case 'mark-addition-pending':
        space.pendingAddition = { effectiveKeyGeneration: signal.effectiveKeyGeneration }
        delete space.pendingRemoval // mutually exclusive
        break
      case 'none':
        break
    }
  }

  /**
   * VE-6c (Sync 005 Z.205 + Sync 002 Z.235 "in aufsteigender Generation"):
   * nach einem erfolgreichen rotation-apply laufen future-gepufferte
   * member-updates, deren effectiveKeyGeneration die neue lokale Generation
   * erreicht hat, erneut durch processMemberUpdate (Disposition entscheidet)
   * und werden via resolveFuture aus dem Future-Buffer in den Seen-Zustand
   * ueberfuehrt.
   */
  private async replayFutureMemberUpdates(spaceId: string): Promise<void> {
    const space = this.spaces.get(spaceId)
    if (!space) return
    // Review-M1 Sequenzierung (wie handleMemberUpdate): eingeplante
    // Observer-Resolution vor dem Re-Speichern der Future-Signale abschliessen.
    if (space.membershipResolutionChain) await space.membershipResolutionChain
    const localKeyGeneration = await this.keyManagement.getCurrentGeneration(spaceId)
    const future = await this.memberUpdateStore.listFutureForSpace(spaceId)
    const actionable = future
      .filter((signal) => signal.effectiveKeyGeneration <= localKeyGeneration)
      .sort((a, b) => a.effectiveKeyGeneration - b.effectiveKeyGeneration)

    for (const signal of actionable) {
      const result = await processMemberUpdate({
        signal,
        policy: {
          localKeyGeneration: await this.keyManagement.getCurrentGeneration(spaceId),
          knownAdminDids: [this.spaceCreatorDid(space)],
          knownMemberDids: space.info.members,
          seenUpdates: await this.memberUpdateStore.listSeenForSpace(spaceId),
        },
        store: this.memberUpdateStore,
        localDid: this.identity.getDid(),
      })
      await this.memberUpdateStore.resolveFuture(spaceId, signal)
      this.applyMemberUpdateLocalImpact(space, result.localImpact, signal)
      // Kein zusaetzlicher Catch-up-Trigger: der Auto-Sync von automerge-repo
      // laeuft ohnehin (VE-6d).
    }

    // Review-M1 (a): auch nach dem Future-Replay gegen den bereits bekannten
    // kanonischen Stand aufloesen — die kanonische Aenderung kann der Rotation
    // vorausgereist sein (Z.231-Reihenfolge).
    if (actionable.length > 0) {
      await this.resolveCanonicallyAnsweredMemberUpdates(space)
    }
  }

  onMemberChange(callback: (change: SpaceMemberChange) => void): () => void {
    this.memberChangeCallbacks.add(callback)
    return () => {
      this.memberChangeCallbacks.delete(callback)
    }
  }

  /** Decoded space-invite event — the wire payload is an ECIES container, so UI must subscribe here. */
  onSpaceInvite(callback: (invite: IncomingSpaceInvite) => void): () => void {
    this.spaceInviteListeners.add(callback)
    return () => { this.spaceInviteListeners.delete(callback) }
  }

  private emitSpaceInvite(invite: IncomingSpaceInvite): void {
    for (const cb of this.spaceInviteListeners) cb(invite)
  }

  /** Leave a space (User-Flow): clean up local state, metadata, group keys, compact store */
  async leaveSpace(spaceId: string): Promise<void> {
    await this.cleanupSpaceLocally(spaceId)
  }

  /**
   * Gemeinsame Cleanup-Mechanik fuer den User-Flow (leaveSpace) und den
   * Resolution-Pfad (kanonisch bestaetigte eigene Entfernung, Sync 005 Z.253
   * Weg a). K3-Verbot bleibt: ein member-update allein erreicht diesen Pfad
   * NIE — nur die Aufloesung gegen die kanonische Mitgliederliste.
   *
   * AM-Aequivalente der Yjs-Destruktor-Liste: Repo-Doc-Handle schliessen +
   * repo.delete statt doc.destroy; Metadata/GroupKeys/Pending/CompactStore/
   * Vault-Doc loeschen; NetworkAdapter-Routing (Doc + Space-Peers) abbauen.
   *
   * VE-5 (Befund 13): die Outbox wird NICHT angefasst — OutboxEntry traegt
   * keinen spaceId-Index (Content-Envelopes haben die spaceId nur im
   * verschluesselten Payload), eine Space-Zuordnung ist nicht zuverlaessig
   * moeglich. Z.191/253-konform: verbleibende Eintraege scheitern/altern im
   * normalen Retry-Pfad (maxRetries-Drop im OutboxMessagingAdapter).
   */
  private async cleanupSpaceLocally(spaceId: string): Promise<void> {
    const space = this.spaces.get(spaceId)
    if (space) {
      space.unsubDocChange?.()
      space.unsubDocChange = undefined
      for (const handle of space.handles) handle.close()
      try {
        this.repo.delete(space.documentId)
      } catch (err) {
        console.warn('[ReplicationAdapter] Failed to delete repo doc for', spaceId, err)
      }
      this.networkAdapter.unregisterDocument(space.documentId)
      this.networkAdapter.unregisterSpace(spaceId)
      this.spaces.delete(spaceId)
    }

    // Clean up schedulers + seq cache
    this.vaultSchedulers.get(spaceId)?.destroy()
    this.vaultSchedulers.delete(spaceId)
    this.compactSchedulers.get(spaceId)?.destroy()
    this.compactSchedulers.delete(spaceId)
    this.vaultSeqs.delete(spaceId)

    // Remove from persistent storage (PersonalDoc-Metadata + CompactStore)
    if (this.metadataStorage) {
      await this.metadataStorage.deleteSpaceMetadata(spaceId)
      await this.metadataStorage.deleteGroupKeys(spaceId)
    }
    await this.deletePendingMessagesForSpace(spaceId)
    if (this.compactStore) {
      await this.compactStore.delete(spaceId).catch(() => {})
    }

    // Delete space doc from Vault
    if (this.vault) {
      await this.vault.deleteDoc(spaceId).catch(() => {})
    }

    this._notifySpacesSubscribers()
  }

  async updateSpace(_spaceId: string, _meta: import('@web_of_trust/core').SpaceDocMeta): Promise<void> {
    throw new Error('updateSpace not implemented for Automerge adapter')
  }

  async getKeyGeneration(spaceId: string): Promise<number> {
    return this.keyManagement.getCurrentGeneration(spaceId)
  }

  async requestSync(_spaceId: string): Promise<void> {
    // VE-6d: No-op — einen expliziten Request-Send wie den Old-World-
    // `sendSpaceSyncRequest` des Yjs-Adapters (dort SPEC-APPROX) gibt es in
    // dieser Architektur nicht; den verlustfreien Normalbetrieb traegt der
    // laufende automerge-repo-Sync (Tests 8/9: Cross-Peer-Konvergenz).
    // CHECK-4-BEFUND (experimentell widerlegte Selbstheilung): wurde eine
    // content-Nachricht mangels Key gedroppt, liefert der laufende Sync sie
    // NICHT nach (sentHashes-Suppression, endloser Heads-Ping-Pong; siehe
    // EncryptedMessagingNetworkAdapter). Der normative Catch-up nach
    // Rotation-Apply (Sync 002 Z.231 "sync-request ausloesen") ist AM-seitig
    // damit OFFEN — Stop-6-Scope-Entscheid (content-Pending-Puffer und/oder
    // Peer-Lifecycle im Netzwerk-Adapter) steht aus. Recovery heute:
    // Vault-/CompactStore-Restore-Pfade.
  }

  // --- VE-6a/VE-6b: durabler Pending-Buffer fuer key-rotation (Sync 002 Z.171-172) ---

  private getDurablePendingStore(): DurablePendingStore | null {
    if (!this.compactStore) return null
    if (typeof (this.compactStore as DurablePendingStore).list !== 'function') return null
    return this.compactStore as DurablePendingStore
  }

  private pendingMessageStorageKey(spaceId: string, messageId: string): string {
    return `${AutomergeReplicationAdapter.PENDING_MESSAGE_PREFIX}${spaceId}:${messageId}`
  }

  private addPendingMessageToMemory(message: PendingSpaceMessage): void {
    const current = this.pendingMessages.get(message.spaceId) ?? []
    const next = current.filter((m) => m.decoded.outerId !== message.decoded.outerId)
    next.push(message)
    this.pendingMessages.set(message.spaceId, next)
  }

  private async bufferPendingSpaceMessage(message: PendingSpaceMessage): Promise<void> {
    this.addPendingMessageToMemory(message)

    const store = this.getDurablePendingStore()
    if (!store) {
      throw new PendingMessageNotDurableError('Cannot ACK pending space message without a durable pending store')
    }

    try {
      const encoded = new TextEncoder().encode(JSON.stringify(message))
      await store.save(this.pendingMessageStorageKey(message.spaceId, message.decoded.outerId), encoded)
    } catch (err) {
      throw new PendingMessageNotDurableError(`Failed to persist pending space message: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async restorePendingMessages(): Promise<void> {
    const store = this.getDurablePendingStore()
    if (!store) return

    const keys = await store.list()
    for (const key of keys) {
      if (!key.startsWith(AutomergeReplicationAdapter.PENDING_MESSAGE_PREFIX)) continue
      const stored = await store.load(key)
      if (!stored) continue
      try {
        const message = JSON.parse(new TextDecoder().decode(stored)) as PendingSpaceMessage
        if (!message.spaceId || !message.decoded?.outerId) throw new Error('Invalid pending message')
        this.addPendingMessageToMemory(message)
      } catch {
        await store.delete(key).catch(() => {})
      }
    }
  }

  private async deletePendingSpaceMessage(spaceId: string, messageId: string): Promise<void> {
    const current = this.pendingMessages.get(spaceId)
    if (current) {
      const next = current.filter((m) => m.decoded.outerId !== messageId)
      if (next.length > 0) {
        this.pendingMessages.set(spaceId, next)
      } else {
        this.pendingMessages.delete(spaceId)
      }
    }

    const store = this.getDurablePendingStore()
    if (store) {
      await store.delete(this.pendingMessageStorageKey(spaceId, messageId)).catch(() => {})
    }
  }

  private async deletePendingMessagesForSpace(spaceId: string): Promise<void> {
    this.pendingMessages.delete(spaceId)

    const store = this.getDurablePendingStore()
    if (!store) return
    const prefix = `${AutomergeReplicationAdapter.PENDING_MESSAGE_PREFIX}${spaceId}:`
    const keys = await store.list()
    await Promise.all(keys.filter((key) => key.startsWith(prefix)).map((key) => store.delete(key).catch(() => {})))
  }

  private async processPendingForSpace(spaceId: string): Promise<void> {
    if (this.processingPendingSpaces.has(spaceId)) return
    const pending = this.pendingMessages.get(spaceId)
    if (!pending || pending.length === 0) return

    this.processingPendingSpaces.add(spaceId)
    try {
      // Sync 002 Z.235: in aufsteigender Generation erneut pruefen;
      // future-rotation vor unknown-space bei Generationsgleichstand.
      const reasonPriority: Record<PendingSpaceMessageReason, number> = {
        'future-rotation': 0,
        'unknown-space': 1,
      }
      const ordered = [...pending].sort((a, b) => {
        const genA = a.keyGeneration ?? Number.MAX_SAFE_INTEGER
        const genB = b.keyGeneration ?? Number.MAX_SAFE_INTEGER
        if (genA !== genB) return genA - genB
        return reasonPriority[a.reason] - reasonPriority[b.reason]
      })

      for (const message of ordered) {
        const messageId = message.decoded.outerId
        const stillPending = this.pendingMessages.get(spaceId)?.some((m) => m.decoded.outerId === messageId)
        if (!stillPending) continue
        await this.deletePendingSpaceMessage(spaceId, messageId)
        await this.handlePendingSpaceMessage(message)
      }
    } finally {
      this.processingPendingSpaces.delete(spaceId)
    }
  }

  private async handlePendingSpaceMessage(message: PendingSpaceMessage): Promise<void> {
    // Bereits verifizierter + replay-recordeter Inbox-Klartext — der Replay läuft
    // bewusst NICHT erneut durch receiveInboxMessage (Message-ID-History würde die
    // eigene Wiedervorlage abweisen). Das ack/1.0 ist beim Buffern bereits gesendet
    // (durably-buffered-pending) — hier kein zweites ack. Anti-loop: ein weiterhin
    // zukünftiger Stand re-buffert (korrekt), alles andere ist konklusiv.
    if (message.decoded.type === KEY_ROTATION_MESSAGE_TYPE) {
      await this.handleKeyRotation(message.decoded)
    }
  }

  async _persistSpaceMetadata(space: SpaceState): Promise<void> {
    if (!this.metadataStorage) return
    // Review-M1 Reentranz: eine noch eingeplante Doc-Change-Handler-Chain darf
    // nach einem Resolution-Cleanup keine Ghost-Metadata fuer den entfernten
    // Space zurueckschreiben.
    if (this.spaces.get(space.info.id) !== space) return

    const memberEncryptionKeys: Record<string, Uint8Array> = {}
    for (const [did, key] of space.memberEncryptionKeys.entries()) {
      memberEncryptionKeys[did] = key
    }

    await this.metadataStorage.saveSpaceMetadata({
      info: space.info,
      documentId: space.documentId,
      documentUrl: space.documentUrl,
      memberEncryptionKeys,
    })

    // Persist all group key generations
    const generation = await this.keyManagement.getCurrentGeneration(space.info.id)
    for (let g = 0; g <= generation; g++) {
      const key = await this.keyManagement.getKeyByGeneration(space.info.id, g)
      if (key && key.length > 0) {
        await this.metadataStorage.saveGroupKey({ spaceId: space.info.id, generation: g, key })
      }
    }
  }

  private async handleMessage(message: WireMessage): Promise<void> {
    // VE-1/VE-8 Familien-Split (Sync 003 Z.328-341): DIDComm-Inbox-Familie
    // (space-invite/member-update/key-rotation als ECIES+Inner-JWS) vs.
    // Old-World-CRDT-Sync-Kanal (content). Kein Typ existiert in beiden Familien.
    if (isDidcommMessage(message)) {
      await this.handleInboxEnvelope(message)
      return
    }
    // Old-World-Envelopes haben hier keine Cases mehr: content läuft über den
    // EncryptedMessagingNetworkAdapter (eigene Signatur-Prüfung dort);
    // sync-request/sync-response are no longer needed (automerge-repo handles sync).
  }

  /**
   * Empfangspfad der DIDComm-Inbox-Familie: receiveInboxMessage (ECIES-Decrypt +
   * Inner-JWS-Prüfungen 1-4 + Message-ID-History) → Typ-Dispatch → ack/1.0 nach
   * Ack-Disposition (K1: ACK-Ownership liegt HIER, nicht im Transport-Adapter).
   */
  private async handleInboxEnvelope(message: DidcommPlaintextMessage): Promise<void> {
    const type = message.type
    // inbox/1.0 (Attestations) gehört dem Reception-Host an der Composition Root (VE-9).
    if (type === INBOX_MESSAGE_TYPE || !isEncryptedInboxMessageType(type)) return

    const result = await receiveInboxMessage({
      message,
      ownDid: this.identity.getDid(),
      decryptEcies: (ecies) => this.identity.decryptForMe({
        ephemeralPublicKey: decodeBase64Url(ecies.epk),
        nonce: decodeBase64Url(ecies.nonce),
        ciphertext: decodeBase64Url(ecies.ciphertext),
      }),
      crypto: this.crypto,
      didResolver: this.didResolver,
      messageIdHistory: this.messageIdHistory,
    })

    if (result.decision === 'reject') {
      if (result.reason === 'replay') {
        // Sync 003 Z.619: "als Duplikat sicher erkannt" erfüllt die ACK-Vorbedingung —
        // ohne ack würde die Relay-Redelivery (getUnacked) die Queue stauen (1.6).
        const disposition = evaluateInboxAckDisposition({
          messageKind: inboxMessageKindForType(type),
          decryption: 'complete',
          innerVerification: 'complete',
          replayCheck: 'duplicate-known',
          localOutcome: { kind: 'duplicate', source: 'replay-history' },
        })
        if (disposition.action === 'send-ack') await this.sendInboxAck(message.id)
        return
      }
      // K1-Pflicht: fehlgeschlagene Verarbeitung → KEIN ack/1.0 — die Nachricht
      // bleibt in der Relay-Queue (Redelivery-Pfad). 'may-ack-invalid-and-drop'
      // wird bewusst nicht genutzt.
      console.warn('[ReplicationAdapter] Rejected inbox message:', result.reason, type)
      return
    }

    // Reines Datenobjekt (ohne Workflow-Closures) — Handler reichen decoded
    // ggf. weiter, dort darf keine Record-Closure mitreisen.
    const decoded: DecodedInboxMessage = {
      type: result.type,
      senderDid: result.senderDid,
      body: result.body,
      outerId: result.outerId,
      extensionFields: result.extensionFields,
    }
    let outcome: InboxAckLocalOutcome
    try {
      outcome = await this.dispatchDecodedInboxMessage(decoded)
    } catch (err) {
      console.debug('[ReplicationAdapter] Inbox message processing failed:', err)
      outcome = { kind: 'processing-incomplete', waitingOn: 'durable-apply' }
    }

    const disposition = evaluateInboxAckDisposition({
      messageKind: inboxMessageKindForType(type),
      decryption: 'complete',
      innerVerification: 'complete',
      replayCheck: 'unique',
      localOutcome: outcome,
    })
    // Sync 003 Z.466 + Z.620-622: erst ein konklusiver Ausgang (angewendet /
    // durabel gepuffert / deterministisch ungültig) macht die id zu
    // "verarbeitet" → jetzt recorden, damit eine weitere Redelivery als Replay
    // endet. Nicht-konklusive Ausgänge (do-not-ack) lassen die History frei —
    // die Relay-Redelivery ist der Recovery-Pfad und darf nicht als Replay
    // mit duplicate-known-ack verloren gehen.
    if (disposition.action === 'do-not-ack') return
    await result.recordProcessed()
    if (disposition.action === 'send-ack') {
      await this.sendInboxAck(decoded.outerId)
    }
  }

  private async dispatchDecodedInboxMessage(decoded: DecodedInboxMessage): Promise<InboxAckLocalOutcome> {
    switch (decoded.type) {
      case SPACE_INVITE_MESSAGE_TYPE:
        return this.handleSpaceInvite(decoded)
      case MEMBER_UPDATE_MESSAGE_TYPE:
        return this.handleMemberUpdate(decoded)
      case KEY_ROTATION_MESSAGE_TYPE:
        return this.handleKeyRotation(decoded)
      default:
        return { kind: 'invalid-rejected', rejection: 'unknown-required-type', authoritativeStateChanged: false }
    }
  }

  /** ack/1.0 an den Broker (Sync 003 Z.594-609): thid = body.messageId = Original-id. */
  private async sendInboxAck(originalMessageId: string): Promise<void> {
    try {
      const ack = createAckMessage({
        id: crypto.randomUUID(),
        from: this.identity.getDid(),
        createdTime: Math.floor(Date.now() / 1000),
        thid: originalMessageId,
        body: { messageId: originalMessageId },
      })
      await this.messaging.send(ack)
    } catch (err) {
      console.warn('[ReplicationAdapter] Failed to send ack/1.0 for', originalMessageId, err)
    }
  }

  private async handleSpaceInvite(decoded: DecodedInboxMessage): Promise<InboxAckLocalOutcome> {
    // Malformed Body ist deterministisch ungültig → konklusiv invalid-rejected
    // (record, Redelivery endet über die Replay-Disposition) — konsistent zu
    // member-update/key-rotation; im Swallow-All-try würde er als
    // processing-incomplete nie geackt (Endlos-Redelivery).
    let body: SpaceInviteBody
    try {
      assertSpaceInviteBody(decoded.body)
      body = decoded.body
    } catch (err) {
      console.warn('[ReplicationAdapter] Rejected space-invite: malformed body', err)
      return { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false }
    }

    try {
      const spaceId = body.spaceId
      const existing = this.spaces.get(spaceId)

      // M2 (Review): documentUrl + Doc-Snapshot reisen zusammen im Group-Key-
      // verschlüsselten Blob — eine unauthentifizierte Wire-Extension könnte ein
      // untrusted Broker austauschen und den Empfänger dauerhaft an eine fremde
      // documentId binden (Sync 005 Z.68-90: der signierte Body kennt kein
      // documentUrl-Feld). Der Decrypt-Key kommt direkt aus dem Inner-JWS-
      // signierten Invite-Body; Validierung VOR applySpaceInviteBody, damit ein
      // kaputter Blob keinen partiellen Key-State (Keys ohne Space-State)
      // hinterlässt.
      const snapshotBlob = decoded.extensionFields.encryptedDocSnapshot
      let snapshotPayload: SpaceInviteSnapshotPayload | null = null
      if (typeof snapshotBlob === 'string' && snapshotBlob.length > 0) {
        try {
          const currentKeyMaterial = body.spaceContentKeys.find(
            (keyMaterial) => keyMaterial.generation === body.currentKeyGeneration,
          )
          // assertSpaceInviteBody garantiert currentKeyGeneration = höchste
          // vorhandene Generation — der Key existiert immer.
          const plaintext = await decryptOneShot({
            crypto: this.crypto,
            spaceContentKey: decodeBase64Url(currentKeyMaterial!.key),
            blob: decodeBase64Url(snapshotBlob),
          })
          snapshotPayload = decodeSpaceInviteSnapshotPayload(plaintext)
        } catch (err) {
          console.warn('[ReplicationAdapter] Rejected space-invite with invalid snapshot payload', spaceId, err)
          return { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false }
        }
      }

      // Für einen bislang unbekannten Space ist der Snapshot-Payload Pflicht —
      // er trägt die documentUrl, unter der der repo-Doc-Handle des Senders
      // importiert wird.
      let senderDocId: DocumentId | null = null
      if (!existing) {
        if (!snapshotPayload) {
          console.warn('[ReplicationAdapter] Rejected space-invite without snapshot payload for unknown space', spaceId)
          return { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false }
        }
        try {
          senderDocId = parseAutomergeUrl(snapshotPayload.documentUrl as AutomergeUrl).documentId
        } catch {
          console.warn('[ReplicationAdapter] Rejected space-invite with malformed documentUrl for unknown space', spaceId)
          return { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false }
        }
      }

      const result = await applySpaceInviteBody({
        crypto: this.crypto,
        keyPort: this.keyManagement,
        body,
        recipientDid: this.identity.getDid(),
        // Sync 003 Z.460-464: senderDid aus verifiziertem Inner-JWS, nicht aus
        // Envelope-Routing. Löst #189-SPEC-DEFERRED S1 auf.
        senderDid: decoded.senderDid,
      })
      if (result.decision === 'reject') {
        console.warn('[ReplicationAdapter] Rejected space-invite:', result.reason, 'from', decoded.senderDid)
        return { kind: 'invalid-rejected', rejection: 'inner-verification-failed', authoritativeStateChanged: false }
      }

      // Demo-Extension (VE-5): der Doc-Snapshot (Automerge-Binary) kommt aus dem
      // oben validierten Snapshot-Payload. Ein leeres docBinary ist zulässig —
      // Inhalt kommt via Live-Sync.
      const docBinary = snapshotPayload && snapshotPayload.docBinary.length > 0
        ? snapshotPayload.docBinary
        : null

      // If space already exists (discovered via metadata restore / multi-device sync),
      // merge the snapshot instead of ignoring it — the existing doc may be empty
      if (existing) {
        if (docBinary) {
          const existingHandle = this.repo.handles[existing.documentId]
          existingHandle?.merge(this.repo.import<any>(docBinary, undefined as any) as any)
        }
        this.emitSpaceInvite({ spaceId, spaceName: existing.info.name, fromDid: decoded.senderDid })
        return { kind: 'applied', durable: true }
      }

      // Import the doc into automerge-repo with the SAME documentId as the sender
      // so automerge-repo can sync them via the NetworkAdapter. Die documentUrl
      // stammt aus dem GCM-geschützten Snapshot-Payload (M2) und wurde oben
      // validiert. repo.import() is what creates the doc handle under the
      // sender's docId — ohne Snapshot-Binary wird der deterministische
      // Bootstrap importiert (members-Container-Seed, Review-Minor): Inhalt
      // kommt via regulaeren Live-Sync.
      const docHandle = this.repo.import<any>(docBinary ?? this.inviteBootstrapBinary(spaceId), { docId: senderDocId! })
      // Note: repo.import() with docId does NOT call doneLoading() (automerge-repo bug),
      // so whenReady() would timeout. The doc IS loaded though — call doneLoading() ourselves.
      if (!docHandle.isReady()) {
        docHandle.doneLoading()
      }

      // Register document -> space mapping
      this.networkAdapter.registerDocument(docHandle.documentId, spaceId)

      // Display metadata travels inside the encrypted doc's _meta — SpaceInviteBody carries
      // no spaceInfo (Sync 005). Invited spaces are 'shared'; appTag rides in _meta so
      // cross-app isolation survives the invite; createdAt has no in-repo consumer.
      const doc = docHandle.doc() as { createdBy?: unknown; name?: unknown; _meta?: Record<string, unknown> } | undefined
      const docMeta = doc?._meta ?? {}
      // VE-1/VE-3: die Mitgliederliste kommt aus dem doc.members-Event-Set des
      // Invite-Snapshots — nicht mehr aus der [senderDid, ownDid]-Konstruktion
      // plus Backfill. Der Snapshot ist dabei nicht autoritativ (Sync 002
      // Z.158): das Event-Set konvergiert via CRDT-Merge, der Snapshot rollt
      // nichts zurueck. Nur ein Invite mit leerem Doc-Binary startet mit der
      // nicht-autoritativen [sender, self]-Saat, bis der Doc-Sync das Event-Set
      // liefert (der Doc-Change-Handler ersetzt die Saat dann).
      const membershipEvents = this.readMembershipEvents(doc)
      const members = membershipEvents.length > 0
        ? resolveActiveMembers(membershipEvents)
        : Array.from(new Set([decoded.senderDid, this.identity.getDid()]))

      // Register self-as-other-device for multi-device sync; die Member-Peers
      // registriert der Projektion-Seed in attachMembershipObserver.
      this.networkAdapter.registerSelfPeer(spaceId)

      const info: SpaceInfo = {
        id: spaceId,
        type: 'shared',
        name: typeof docMeta.name === 'string' ? docMeta.name : (typeof doc?.name === 'string' ? doc.name : undefined),
        description: typeof docMeta.description === 'string' ? docMeta.description : undefined,
        image: typeof docMeta.image === 'string' ? docMeta.image : undefined,
        modules: Array.isArray(docMeta.modules) ? docMeta.modules as string[] : undefined,
        appTag: typeof docMeta.appTag === 'string' ? docMeta.appTag : undefined,
        // VE-2: Creator-DID aus dem synchronisierten Doc — beim Invitee ist
        // der Inviter (senderDid) NICHT zwingend der Creator/Admin.
        createdBy: typeof doc?.createdBy === 'string' ? doc.createdBy : undefined,
        members,
        createdAt: new Date().toISOString(),
      }

      const spaceState: SpaceState = {
        info,
        documentId: docHandle.documentId,
        documentUrl: docHandle.url,
        handles: new Set(),
        memberEncryptionKeys: new Map(),
      }
      this.spaces.set(spaceId, spaceState)
      this.attachMembershipObserver(spaceState)
      this._notifySpacesSubscribers()

      await this._persistSpaceMetadata(spaceState)
      // Flush repo so the doc is persisted to IndexedDB
      await this.repo.flush([docHandle.documentId])

      // Save to CompactStore (fire-and-forget)
      this._saveToCompactStore(spaceState).catch(() => {})

      // Push to vault for multi-device persistence (fire-and-forget)
      this._pushSnapshotToVault(spaceState).catch(() => {})

      // VE-6b Replay-Hook: durabel gepufferte Nachrichten fuer diesen Space
      // (key-rotation vor dem Invite, reason 'unknown-space') jetzt erneut
      // pruefen — der Authority-Check laeuft erst hier mit Admin-Snapshot.
      await this.processPendingForSpace(spaceId)

      // Notify listeners so UI updates when invited to a space
      for (const cb of this.memberChangeCallbacks) {
        cb({ spaceId, did: this.identity.getDid(), action: 'added' })
      }
      this.emitSpaceInvite({ spaceId, spaceName: info.name, fromDid: decoded.senderDid })
      return { kind: 'applied', durable: true }
    } catch (err) {
      console.debug('[ReplicationAdapter] Failed to handle space invite:', err)
      return { kind: 'processing-incomplete', waitingOn: 'durable-apply' }
    }
  }

  private async handleKeyRotation(decoded: DecodedInboxMessage): Promise<InboxAckLocalOutcome> {
    try {
      assertKeyRotationBody(decoded.body)
    } catch (err) {
      console.warn('[ReplicationAdapter] Rejected key-rotation: malformed body', err)
      return { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false }
    }
    const body: KeyRotationBody = decoded.body

    // C1 (Sync 005 Z.230): authority snapshot from local state. An unknown
    // space cannot be authorized (no admin snapshot) → VE-6b (Sync 005 Z.202):
    // durabel puffern (reason 'unknown-space') + ack statt Endlos-Redelivery;
    // der Authority-Check laeuft beim Replay nach dem space-invite-Apply
    // (processPendingForSpace-Hook im Invite-Pfad). SPEC-APPROX (VE-2):
    // createdBy als alleiniger Admin (full Admin list in 1.B.3-admin-management).
    const space = this.spaces.get(body.spaceId)
    if (!space) {
      try {
        await this.bufferPendingSpaceMessage({
          spaceId: body.spaceId,
          decoded,
          receivedAt: Date.now(),
          reason: 'unknown-space',
          keyGeneration: body.generation,
        })
      } catch (err) {
        if (!(err instanceof PendingMessageNotDurableError)) throw err
        // Ohne durablen Pending-Store: kein ack (Sync 003 Z.620 verbietet ack
        // fuer volatile Puffer) — die Relay-Redelivery ist der Recovery-Pfad.
        return {
          kind: 'pending',
          durability: 'not-buffered',
          dependencies: [{ kind: 'missing-space-invite', docId: body.spaceId }],
        }
      }
      return {
        kind: 'pending',
        durability: 'durable',
        dependencies: [{ kind: 'missing-space-invite', docId: body.spaceId }],
      }
    }
    const knownAdminDids = [this.spaceCreatorDid(space)]

    const result = await applyKeyRotationBody({
      crypto: this.crypto,
      keyPort: this.keyManagement,
      body,
      recipientDid: this.identity.getDid(),
      // Sync 003 Z.460-464: senderDid aus verifiziertem Inner-JWS, nicht aus
      // Envelope-Routing. Löst #189-SPEC-DEFERRED S1 auf.
      senderDid: decoded.senderDid,
      knownAdminDids,
    })

    if (result.decision === 'reject') {
      console.warn('[ReplicationAdapter] Rejected key-rotation:', result.reason, 'from', decoded.senderDid)
      return { kind: 'invalid-rejected', rejection: 'inner-verification-failed', authoritativeStateChanged: false }
    }
    if (result.decision === 'future-buffer') {
      // VE-6a (Sync 002 Z.233 MUSS): future-rotation durabel puffern + ack —
      // ersetzt den #189-not-buffered-Drop (Redelivery-Behelf).
      try {
        await this.bufferPendingSpaceMessage({
          spaceId: body.spaceId,
          decoded,
          receivedAt: Date.now(),
          reason: 'future-rotation',
          keyGeneration: body.generation,
        })
      } catch (err) {
        if (!(err instanceof PendingMessageNotDurableError)) throw err
        // Ohne durablen Pending-Store: kein ack (Sync 003 Z.620 verbietet ack für
        // volatile Puffer) — die Relay-Redelivery ist der Recovery-Pfad.
        return {
          kind: 'pending',
          durability: 'not-buffered',
          dependencies: [{ kind: 'missing-key-generation', docId: body.spaceId, keyGeneration: body.generation - 1 }],
        }
      }
      return {
        kind: 'pending',
        durability: 'durable',
        dependencies: [{ kind: 'missing-key-generation', docId: body.spaceId, keyGeneration: body.generation - 1 }],
      }
    }
    if (result.decision !== 'apply') {
      // ignore-stale-or-duplicate: lokaler State ist bereits auf/jenseits dieser
      // Generation — konklusiv verarbeitet, ack verhindert sinnlose Redelivery.
      console.warn('[ReplicationAdapter] Ignored key-rotation:', result.decision, body.spaceId, body.generation)
      return { kind: 'applied', durable: true }
    }

    // applied: persist all key generations to metadata (multi-device durability),
    // then replay pending.
    await this._persistSpaceMetadata(space)
    await this.deletePendingSpaceMessage(body.spaceId, decoded.outerId)
    // Sync 002 Z.235: gepufferte future-rotations in aufsteigender Generation
    // erneut pruefen, sobald die Luecke geschlossen ist.
    await this.processPendingForSpace(body.spaceId)
    // VE-6c: future-gepufferte member-updates, deren Generation jetzt erreicht
    // ist, re-verarbeiten (aufsteigend, Sync 002 Z.235).
    await this.replayFutureMemberUpdates(body.spaceId)
    // VE-6d (Sync 002 Z.231 "sync-request ausloesen"): kein expliziter
    // Catch-up-Send — siehe requestSync-Kommentar. CHECK-4-Befund: fuer
    // waehrend der Key-Luecke gedroppte content-Nachrichten ist der Catch-up
    // AM-seitig OFFEN (Stop-6-Scope-Entscheid).
    return { kind: 'applied', durable: true }
  }

  private async handleMemberUpdate(decoded: DecodedInboxMessage): Promise<InboxAckLocalOutcome> {
    // K4: validate the clear protocol body before mapping to a signal. Der Klartext-Body
    // kommt aus dem verifizierten Inner-JWS-Payload — member-update ist eine
    // ECIES-Inbox-Nachricht (Sync 003 Z.500), immer mit eigenem Key lesbar.
    try {
      assertMemberUpdateBody(decoded.body)
    } catch (err) {
      console.warn('[ReplicationAdapter] Rejected member-update: malformed body', err)
      return { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false }
    }
    const body = decoded.body

    const space = this.spaces.get(body.spaceId)
    if (!space) {
      // Unbekannter Space: kein ack → Relay-Redelivery, bis der zugehörige
      // space-invite angekommen ist (Sync 003 Z.620-622).
      return {
        kind: 'pending',
        durability: 'not-buffered',
        dependencies: [{ kind: 'missing-space-invite', docId: body.spaceId }],
      }
    }

    // Review-M1 Sequenzierung: eine bereits eingeplante Observer-Resolution
    // (von einer AELTEREN kanonischen Aenderung) muss abgeschlossen sein,
    // BEVOR dieses member-update klassifiziert und gespeichert wird — sonst
    // wuerde sie das frische Pending gegen den aelteren kanonischen Stand
    // aufloesen (Z.194: die Aufloesung gehoert dem NAECHSTEN Space-Sync).
    if (space.membershipResolutionChain) await space.membershipResolutionChain

    // Authority-Split (Sync 005 Z.169-177): membership authority lives in the
    // application workflow, NOT the adapter. The adapter maps wire→signal, delegates
    // classification, and applies only the local pending UX flag.
    // SPEC-APPROX (VE-2): createdBy als alleiniger Admin; full Admin-Liste folgt
    // im 1.B.3-admin-management-Slice.
    const signal: MemberUpdateSignal = {
      spaceId: body.spaceId,
      action: body.action,
      memberDid: body.memberDid,
      effectiveKeyGeneration: body.effectiveKeyGeneration,
      // Sync 003 Z.460-464: signerDid aus verifiziertem Inner-JWS, nicht aus
      // Envelope-Routing. Löst #189-SPEC-DEFERRED S1 auf.
      signerDid: decoded.senderDid,
    }
    const result = await processMemberUpdate({
      signal,
      policy: {
        localKeyGeneration: await this.keyManagement.getCurrentGeneration(body.spaceId),
        knownAdminDids: [this.spaceCreatorDid(space)],
        knownMemberDids: space.info.members,
        seenUpdates: await this.memberUpdateStore.listSeenForSpace(body.spaceId),
      },
      store: this.memberUpdateStore,
      localDid: this.identity.getDid(),
    })

    // K3 (Sync 005 Z.183-184 + Z.191): member-update is a pending UX signal only.
    // NO spaces.delete, NO deleteSpaceMetadata, NO handle.close, NO peer (un)register,
    // NO member-list mutation — durable state survives. Canonical cleanup happens
    // ONLY on the resolution path (Sync 005 Z.253 Weg a).
    this.applyMemberUpdateLocalImpact(space, result.localImpact, signal)

    // Review-M1 (a): traegt das kanonische Event-Set die Antwort bereits (die
    // kanonische Aenderung reiste VOR dem member-update ein), wird das soeben
    // gespeicherte Pending sofort aufgeloest — inkl. localRemovalConfirmed →
    // Cleanup. Der Doc-Change-Handler allein wuerde es nie wieder anfassen
    // (Deadlock). K3 bleibt gewahrt: der Cleanup haengt weiter an der
    // KANONISCHEN Bestaetigung, nicht am member-update selbst.
    await this.resolveCanonicallyAnsweredMemberUpdates(space)

    // VE-6d (Sync 005 Z.183-184/Z.204 "Space-Catch-Up ausloesen"): kein
    // expliziter Catch-up-Send fuer result.triggerSpaceCatchUp — siehe
    // requestSync-Kommentar (laufender automerge-repo-Sync; CHECK-4-Befund:
    // fuer gedroppte content-Nachrichten OFFEN, Stop-6-Scope-Entscheid).
    console.debug('[ReplicationAdapter] member-update disposition:', result.disposition)
    // Alle Workflow-Dispositionen sind ackable (Signal via memberUpdateStore
    // recorded bzw. konklusiv ignoriert); die durable Store-Verdrahtung ist
    // 1.D-Scope (heute InMemory-Default, wie #188).
    return result.ackable
      ? { kind: 'applied', durable: true }
      : { kind: 'processing-incomplete', waitingOn: 'durable-apply' }
  }
}
