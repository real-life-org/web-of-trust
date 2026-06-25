import { Repo, parseAutomergeUrl, type DocumentId, type AutomergeUrl, type PeerId } from '@automerge/automerge-repo'
import type { StorageAdapterInterface } from '@automerge/automerge-repo'
import type { DocHandle } from '@automerge/automerge-repo'
import * as Automerge from '@automerge/automerge'
import type { ReplicationAdapter, SpaceHandle, TransactOptions, Subscribable, MessagingAdapter, MessageIdHistoryPort, SpaceMetadataStorage, KeyManagementPort, MemberUpdatePendingStore, WireMessage, DocLogStore } from '@web_of_trust/core/ports'
import type { IdentitySession, SpaceInfo, SpaceMemberChange, IncomingSpaceInvite, ReplicationState, MessageEnvelope } from '@web_of_trust/core/types'
import {
  createSpaceKey, rotateSpaceKey, importKey, processMemberUpdate,
  resolveMemberUpdatesAgainstCanonical, canonicalEventSetAnswersPending,
  buildSpaceInviteBody, applySpaceInviteBody, buildKeyRotationBody, applyKeyRotationBody,
  deliverInboxMessage, receiveInboxMessage,
  runTwoPhaseRemoval, recoverPendingRemovals,
} from '@web_of_trust/core/application'
import type { LocalImpact, SecureRemovalDeps } from '@web_of_trust/core/application'
import type {
  ProtocolCryptoAdapter, MemberUpdateSignal, SeenMemberUpdateSignal, SpaceInviteBody, KeyRotationBody,
  DidResolver, DidcommPlaintextMessage, InboxAckLocalOutcome, InboxMessageKind,
  MembershipEvent, AdminEntry,
} from '@web_of_trust/core/protocol'
import {
  decryptOneShot, encryptOneShot, assertMemberUpdateBody, decodeBase64Url, encodeBase64Url,
  assertSpaceInviteBody, assertKeyRotationBody,
  SPACE_INVITE_MESSAGE_TYPE, MEMBER_UPDATE_MESSAGE_TYPE, KEY_ROTATION_MESSAGE_TYPE,
  isDidcommMessage, isEncryptedInboxMessageType, INBOX_MESSAGE_TYPE,
  createAckMessage, evaluateInboxAckDisposition, createDidKeyResolver,
  formatMembershipEventKey, parseMembershipEventKey, resolveActiveMembers, resolveMembershipWinner, assertMembershipEvent,
  resolveActiveAdmins, assertAdminEntry,
  LogSyncCoordinator, AuthorMismatchError, createSpaceCapabilityJws,
  createSpaceRegisterMessageWithSigner, createSpaceRotateMessageWithSigner,
  LOG_ENTRY_MESSAGE_TYPE, SYNC_RESPONSE_MESSAGE_TYPE,
} from '@web_of_trust/core/protocol'
import type { LogSyncEngineHooks, CapabilitySource, ControlFrameReceipt, WriteRejectHandler } from '@web_of_trust/core/protocol'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { VaultClient, base64ToUint8, VaultPushScheduler, InMemoryKeyManagementAdapter, InMemoryMemberUpdatePendingStore, InMemoryMessageIdHistory, createRestoreCloneHandler } from '@web_of_trust/core/adapters'
import { EncryptedMessagingNetworkAdapter } from './EncryptedMessagingNetworkAdapter'
import { spaceIdToDocumentId } from './automerge-doc-id'
import { frameChanges, unframeChanges } from './automerge-change-framing'
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

type PendingSpaceMessageReason = 'unknown-space' | 'blocked-by-key' | 'future-rotation'

/**
 * Durabler Puffer fuer Nachrichten, die noch nicht anwendbar sind (VE-6a/
 * VE-6b + F-1, Sync 002 Z.171-173/Z.231-235): key-rotations (future-rotation/
 * unknown-space, DIDComm-Inbox-Klartext) UND content-Sync-Nachrichten mit
 * unbekannter keyGeneration (blocked-by-key, roher Old-World-Envelope aus dem
 * EncryptedMessagingNetworkAdapter — Spiegel des Yjs-content-Puffers).
 */
interface PendingSpaceMessage {
  spaceId: string
  /**
   * Old-World-Envelope (CRDT-Sync-Kanal: content, blocked-by-key — F-1).
   * Der Replay laeuft durch denselben Decrypt-→repo-Pfad wie der Live-
   * Empfang (replayContentEnvelope); der content-Kanal hat KEINE
   * ack-Semantik (Sync 002 Z.202 / Sync 003 Z.638) — die Pufferung ist rein
   * empfaengerseitig.
   */
  envelope?: MessageEnvelope
  /**
   * DIDComm-Inbox-Klartext (key-rotation): bereits verifiziert; die durable
   * Pufferung ist ein konklusiver Ausgang, daher recorded der Empfangspfad die
   * Message-ID direkt nach dem Buffern (Sync 003 Z.620-622). Die Wiedervorlage
   * laeuft NICHT erneut durch receiveInboxMessage, sonst wuerde die
   * Message-ID-History sie abweisen.
   */
  decoded?: DecodedInboxMessage
  receivedAt: number
  reason: PendingSpaceMessageReason
  keyGeneration?: number
}

function pendingMessageId(message: PendingSpaceMessage): string {
  return message.envelope?.id ?? message.decoded?.outerId ?? ''
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
  // Slice A Phase 4 / VE-2/3: the log-path change observer's unsubscribe. The
  // observer captures LOCAL Automerge changes (getChanges before→after) and
  // routes them through the LogSyncCoordinator. Separate from the membership
  // observer above (which only re-projects info.members/admins).
  unsubLogChange?: () => void
  // VE-3 LOOP-GUARD: set while applyRemoteUpdate() applies a decrypted remote
  // change, so the log-path change observer does NOT emit a new log-entry for a
  // remote-originated change (the Automerge pendant of Yjs origin='remote').
  applyingRemoteLog?: boolean
  // Slice SR / B3: set while the secure-removal COMMIT applies the membership-removal
  // change, so the steady-state log-path observer does NOT fire its fire-and-forget
  // write for it. The commit captures the change + writes it via an EXPLICIT,
  // awaitable, error-propagating coordinator.writeLocalUpdate so the durable
  // membership-removal entry is persisted BEFORE the PendingRemoval staging is deleted.
  // Distinct from applyingRemoteLog (a remote apply) — this is a LOCAL commit whose
  // durable write is taken over by commitMembershipEventDurable.
  suppressLogForLocalCommit?: boolean
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
  /**
   * Slice A / VE-2..9 (Phase 4): durable per-(deviceId,docId) log store for the
   * Sync 002/003 log path. When provided together with `enableLogSync`, the
   * adapter wires the primary steady-state CRDT sync through the
   * LogSyncCoordinator (encrypted log-entry envelopes + space-register +
   * present-capability + sync-request catch-up) instead of the legacy
   * automerge-repo content/full-state broadcast. The wire docId is the canonical
   * UUID spaceId (VE-9), never the native base58 documentId.
   */
  docLogStore?: DocLogStore
  /**
   * Enable the Sync 002/003 log path as the primary steady-state sync path
   * (VE-2..9, Phase 4). Requires `docLogStore` and a `sendControlFrame`-capable
   * messaging adapter. Default false: the legacy automerge-repo content path
   * stays the default (VE-7 hard-disables it when on). NO global default flip
   * (P5/VE-11).
   */
  enableLogSync?: boolean
  /**
   * Stable per-device UUID for the log-entry seq namespace (per (deviceId,docId)).
   * Defaults to a fresh random UUID. SHOULD be the same stable id the messaging
   * adapter registers with the broker.
   */
  deviceId?: string
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

  // Slice A Phase 4 / VE-2..9: log-path infrastructure (mirrors the Yjs adapter).
  private readonly docLogStore?: DocLogStore
  private readonly logSyncEnabled: boolean
  /** Active per-device UUID (re-bound process-wide by a restore-clone, VE-4/VE-5). */
  private deviceId: string
  /** True once the store-bound deviceId has been resolved (BLOCKER-1b). */
  private deviceIdResolved = false
  /** Per-space LogSyncCoordinator (engine-neutral orchestration), keyed by spaceId UUID. */
  private coordinators = new Map<string, LogSyncCoordinator>()
  private docLogStoreInitialized = false

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
    this.docLogStore = config.docLogStore
    this.deviceId = config.deviceId ?? crypto.randomUUID()
    // The log path is the primary steady-state path only when both a durable log
    // store and a control-frame-capable messaging adapter are present (VE-9/VE-11).
    this.logSyncEnabled =
      config.enableLogSync === true &&
      this.docLogStore !== undefined &&
      typeof (this.messaging as MessagingAdapter).sendControlFrame === 'function'
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

    // F-1/B1 (Sync 002 Z.173 MUSS): content-Nachrichten mit unbekannter
    // keyGeneration werden nicht gedroppt, sondern als blocked-by-key
    // gepuffert (durables CompactStore-Pending-Muster) und nach rotation-
    // apply bzw. beim start()-Restore erneut durch den Live-Empfangspfad
    // gefeedet (processPendingForSpace → replayContentEnvelope).
    this.networkAdapter.setContentBlockedHandler(async (blocked) => {
      try {
        await this.bufferPendingSpaceMessage({
          spaceId: blocked.spaceId,
          envelope: blocked.envelope,
          receivedAt: Date.now(),
          reason: 'blocked-by-key',
          keyGeneration: blocked.keyGeneration,
        })
      } catch (err) {
        if (!(err instanceof PendingMessageNotDurableError)) throw err
        // Der content-Kanal hat KEINE ack-Semantik (Sync 002 Z.202 / Sync 003
        // Z.638) — anders als bei key-rotation haengt hier keine ack-
        // Entscheidung an der Durabilitaet. Ohne durablen Store traegt der
        // In-Memory-Buffer die Recovery innerhalb der Session; Neustart-
        // Durabilitaet liefert der konfigurierte CompactStore.
      }
    })

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

    // Listen for application-level messages (invites, key rotation, member updates)
    // BEFORE restoreSpacesFromMetadata: under log-sync the restore runs the
    // per-space catch-up (present-capability → sync-request), and the broker's
    // sync-RESPONSE comes back as a routed message that MUST reach handleMessage →
    // the coordinator. Registering the handler after the restore would let the
    // cold-start catch-up time out (Phase 4 VE-9(d) regression). A log-path message
    // for a not-yet-restored space is harmlessly dropped (the sync-request is only
    // sent once a space's coordinator exists).
    this.unsubscribeMessaging = this.messaging.onMessage(
      (message) => this.handleMessage(message)
    )

    // Restore persisted space metadata and group keys
    await this.restoreSpacesFromMetadata()

    // Slice SR / VE-C3: resume any durable pending removals staged before a crash —
    // retry the space-rotate confirmations + commit (idempotent). Best-effort; a
    // still-pending removal stays staged for the next start.
    await this.recoverPendingRemovalsOnce()

    this.state = 'idle'
    this._notifySpacesSubscribers()
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

      // VE-9 Cold-Start Re-Map: under log-sync the native base58 documentId is
      // session-/instance-local and is RE-DERIVED from the canonical UUID spaceId
      // (the only persistent/wire identity) on every start — NOT trusted from the
      // persisted metadata. Under the deterministic mapping the two are equal, but
      // re-deriving makes the UUID the single source of truth and survives a
      // metadata that stored a stale/foreign base58 id.
      const restoredDocumentId = this.logSyncEnabled
        ? spaceIdToDocumentId(meta.info.id)
        : (meta.documentId as DocumentId)
      const restoredDocumentUrl = this.logSyncEnabled
        ? (`automerge:${restoredDocumentId}` as AutomergeUrl)
        : (meta.documentUrl as AutomergeUrl)

      const spaceState: SpaceState = {
        info: meta.info,
        documentId: restoredDocumentId,
        documentUrl: restoredDocumentUrl,
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

      // VE-9/VE-4 (Phase 4) cold-start: under log-sync the doc MUST exist locally
      // (under the UUID-derived base58 docId) so the membership projection + the
      // coordinator can read/applyChanges even with NO CompactStore/vault snapshot.
      // If nothing restored a ready handle, import the deterministic bootstrap
      // under the derived docId NOW (before resolveCanonicallyAnsweredMemberUpdates
      // reads doc()), making the doc ready and the membership observer safe to
      // attach. The full log is replayed via catchUp below.
      if (this.logSyncEnabled && !docRestored) {
        const handle = this.repo.handles[spaceState.documentId]
        if (!handle || !handle.isReady()) {
          const bootstrap = this.repo.import<unknown>(this.inviteBootstrapBinary(meta.info.id), {
            docId: spaceState.documentId,
          })
          if (!bootstrap.isReady()) bootstrap.doneLoading()
        }
        docRestored = true
      }

      if (docRestored) {
        // VE-1: die members-Projektion kommt aus dem Event-Set des Docs — die
        // PersonalDoc-Metadata ist nur ein Cache (Seed im Attach).
        this.attachMembershipObserver(spaceState)
      }

      // VE-7 (Sync 005 Z.253): Pending-Flags aus dem konfigurierten
      // MemberUpdatePendingStore re-derivieren. Der Bestaetigungs-Sync bei
      // App-Start laeuft AM-seitig ueber den automerge-repo-Sync nach dem
      // Peer-Registrieren oben (VE-6d, siehe requestSync-Kommentar) plus
      // die Vault-/CompactStore-Restore-Pfade.
      await this.derivePendingMemberUpdateFlags(spaceState)
      // Review-M1 (b): der wiederhergestellte kanonische Stand kann die Antwort
      // auf offene Pendings bereits tragen (canonical-first vor dem Neustart
      // bzw. Crash zwischen savePending und Resolution) — dann sofort
      // aufloesen statt auf einen neuen Sync zu warten (Sync 005 Z.253:
      // Bestaetigungs-Sync bei App-Start erneut versuchen). Unbeantwortete
      // Pendings bleiben offen.
      await this.resolveCanonicallyAnsweredMemberUpdates(spaceState)
      if (!this.spaces.has(meta.info.id)) continue // Restore-Resolution hat den Space aufgeraeumt

      // VE-6 (Sync 002 Z.237) + F-1: durabel gepufferte Nachrichten dieses
      // Space (key-rotations + blocked-by-key-Content) bei App-Start erneut
      // pruefen — der start()-Restore-Replay-Hook.
      await this.processPendingForSpace(meta.info.id)

      // VE-9/VE-4 (Phase 4) cold-start catch-up: the doc handle exists (restored
      // or bootstrapped above) under the UUID-derived base58 docId. Attach the log
      // observer and run the catch-up (present-capability → sync-request → full log
      // replay) so the cold-started device converges from the broker log alone. The
      // UUID spaceId is the wire/seq identity; the base58 docId was re-derived.
      if (this.logSyncEnabled) {
        this.attachLogChangeObserver(spaceState)
        const coordinator = await this.getOrCreateCoordinator(spaceState)
        if (coordinator) {
          await coordinator.catchUp().catch((err) =>
            console.warn('[ReplicationAdapter] restore log catch-up failed:', err),
          )
        }
      }
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
   *
   * F-1-Restart-Befund (Sync 002 Z.158/Z.171): der Space-Doc-Snapshot MUSS
   * die Change-Lineage erhalten — Automerge.save(doc) ist bereits die
   * komprimierte Spaltenform INKLUSIVE History. Die fruehere Phase-2-
   * "Kompaktierung" (JSON-Roundtrip + Automerge.from) erzeugte ein NEUES Doc
   * mit frischen Change-Hashes; ein Restore davon konnte keinerlei
   * inkrementelle Changes mehr anwenden (deren Dependencies zeigen auf die
   * weggeworfene Lineage) — weder den Live-Sync-Catch-up noch den
   * blocked-by-key-Replay (F-1, experimentell belegt im Neustart-Test).
   * Z.158 verlangt das Gegenteil: ein Snapshot rollt bekannte Ops nicht
   * zurueck. History-Pruning OHNE Lineage-Bruch bietet Automerge derzeit
   * nicht; die Vault-/PersonalDoc-Pfade kompaktieren weiterhin (eigener
   * Recovery-Kanal, dokumentierte Grenze).
   */
  private async _saveToCompactStore(spaceState: SpaceState): Promise<void> {
    if (!this.compactStore) return

    const docHandle = this.repo.handles[spaceState.documentId]
    const doc = docHandle?.doc()
    if (!doc) return

    await this.compactStore.save(spaceState.info.id, Automerge.save(doc))
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
      // Slice A Phase 4: detach the log-path change observer too.
      space.unsubLogChange?.()
      space.unsubLogChange = undefined
      for (const handle of space.handles) {
        handle.close()
      }
    }
    // Drop the per-space coordinators (a fresh start() re-creates them lazily).
    this.coordinators.clear()
    // Review-M1 (Fix-Runde, Spiegel des Yjs-stop()-Teardowns): die Space-Map
    // leeren, damit die Reentranz-Guards (applyMemberUpdateResolution,
    // resolvePendingMemberUpdates, _persistSpaceMetadata) nachlaufende
    // Resolution-Chains nach dem Stop zu No-ops machen — sonst koennte eine
    // verkettete Chain NACH stop() noch Pendings konsumieren und destruktiv
    // gegen die (von einer Nachfolger-Instanz geteilten) Stores aufraeumen.
    // start() restauriert die Spaces ohnehin frisch aus der Metadata; die
    // alten States referenzieren das heruntergefahrene Repo.
    this.spaces.clear()
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

    // M2 (Review): das Creator-Doc startet auf demselben deterministischen
    // Bootstrap-Binary wie der Invite-Apply (inviteBootstrapBinary: fester
    // Actor aus der spaceId, time 0, leerer members-Container). Die
    // Container-Erzeugung ist damit in ALLEN Pfaden byte-identisch — der
    // CRDT-Merge dedupliziert sie. Vorher legte createSpace den Container
    // mit RANDOM Actor an: gemergt mit einem Bootstrap-Doc (Invite mit
    // leerem docBinary) war das ein Property-Konflikt, die Events der
    // unterlegenen Seite verschwanden aus der Merge-Sicht.
    // BREAKING (deklarierter Alt-Space-Bruch): die Initial-Change
    // bestehender createSpace-Docs aendert sich.
    // VE-9 (Phase 4): under log-sync the native base58 documentId is DERIVED from
    // the canonical UUID spaceId (deterministic + reversible), so every device
    // re-maps the same base58 id from the same UUID on cold-start, and the wire
    // docId (UUID) stays in sync with the repo's docId. Outside log-sync the
    // legacy random documentId is kept (the invite snapshot carries the
    // documentUrl) — no behaviour change for the 146 baseline tests.
    const docHandle = this.logSyncEnabled
      ? this.repo.import<T>(this.inviteBootstrapBinary(spaceId), { docId: spaceIdToDocumentId(spaceId) })
      : this.repo.import<T>(this.inviteBootstrapBinary(spaceId))
    if (!docHandle.isReady()) {
      docHandle.doneLoading()
    }

    // Set initial app doc + shared metadata in the doc's _meta object. appTag
    // included: invited members must inherit cross-app isolation (the invite
    // carries no plaintext spaceInfo).
    docHandle.change((d: any) => {
      Object.assign(d, initialDoc)
      d._meta = d._meta ?? {}
      if (meta?.name) d._meta.name = meta.name
      if (meta?.description) d._meta.description = meta.description
      if (meta?.modules) d._meta.modules = meta.modules
      if (meta?.appTag) d._meta.appTag = meta.appTag
      // F-6 Kollisionsschutz: kanonische WoT-Felder liegen unter dem
      // reservierten Unterstrich-Praefix im Doc-Root (_createdBy/_members,
      // Konvention wie _meta; Spiegel der Yjs-Y.Map `_members`) — App-Daten
      // duerfen eigene members-/createdBy-Schluessel tragen, ohne die
      // Membership-Autoritaet zu kippen. Die Doc-interne Form ist Gegenstand
      // von wot-spec#99.
      // VE-2: Creator-DID einmalig im synchronisierten Doc — ersetzt die
      // members[0]-Admin-Approximation (divergierte beim Invitee auf den Inviter).
      d._createdBy = myDid
      // VE-1 (Sync 005 Z.163): kanonische Mitgliederliste als grow-only
      // Event-Set in doc._members — der Creator ist active@0. Der Container
      // selbst stammt aus dem deterministischen Seed (M2), hier wird nur
      // hineingeschrieben.
      const selfEvent: MembershipEvent = { did: myDid, status: 'active', sinceGeneration: 0 }
      d._members[formatMembershipEventKey(selfEvent)] = selfEvent
      // VE-1 (Sync 005 Z.111-130/Z.221): kanonische Admin-Liste als grow-only
      // Add-only-Set in doc._admins (Spiegel der Yjs-Y.Map `_admins`,
      // reservierter Root-Key) — der Creator ist initialer Admin. Schreiber sind
      // ausschliesslich createSpace (hier) + promoteToAdmin. info.admins ist die
      // Projektion der AKTIVEN Admins (resolveActiveAdmins ∩ aktive _members).
      if (!d._admins) d._admins = {}
      d._admins[myDid] = { did: myDid }
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
      admins: [myDid],
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

    // VE-8/VE-2 (Sync 002 §207): under log-sync the creator runs the closed
    // first-publication sequence — space-register → present-capability →
    // sync-request — and attaches the log-path change observer BEFORE any user
    // edit, so the first local write appends seq=0. The initial doc seed (above)
    // rode in the encrypted invite snapshot, NOT as a log entry (the observer is
    // attached only now, mirroring the Yjs setupSpaceSync ordering).
    if (this.logSyncEnabled) {
      this.attachLogChangeObserver(spaceState)
      const coordinator = await this.getOrCreateCoordinator(spaceState)
      if (coordinator) {
        await coordinator.ensurePublished().catch((err) => {
          if (err instanceof AuthorMismatchError) {
            console.error('[ReplicationAdapter] AUTHOR_MISMATCH during createSpace publish:', err.message)
          } else {
            console.debug('[ReplicationAdapter] first-publication deferred (will retry):', err)
          }
        })
        // VE-4 (self-contained log): the creator's INITIAL doc seed (members/admins/
        // meta) was written to the Automerge doc BEFORE the observer attached, so it
        // is NOT yet in the log. Publish it as the first log-entry (seq=0, full
        // state) so a cold-start device with NO snapshot reconstructs the doc purely
        // from `leere heads → kompletter Log`. Subsequent edits append from seq=1.
        await this.writeFullStateViaLog(spaceState)
      }
    }

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
    // signing key. adminDids = volle aktive Admin-Liste (1.B.3-admin-management;
    // EXISTIERENDES Array-Feld, kein neues Wire-Feld — STOP-2/Risk 8).
    const inviteBody = await buildSpaceInviteBody({
      keyPort: this.keyManagement,
      spaceId,
      recipientDid: memberDid,
      brokerUrls: this.brokerUrls,
      adminDids: this.spaceAdminDids(space),
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
    // doc._members-Event-Set, Backfill erzeugte nur widerspruechliche
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

    // VE-3 (Sync 005 Z.229 "ein Admin"): removeMember ist Admin-Recht. Der Guard
    // sitzt VOR jeder Doc-Mutation/Rotation (Risk 4) — ein Nicht-Admin darf weder
    // ein removed-Event schreiben noch den Key rotieren (CRDT-Vandalismus-Fläche).
    // Self-Leave (memberDid === myDid) ist davon ausgenommen: ein Member darf sich
    // selbst entfernen (der dedizierte Leave-Pfad ist leaveSpace, removeMember(self)
    // bleibt fuer Symmetrie offen). Client-Defense-in-depth, NICHT die CRDT-Level-
    // Autoritaet (#99, deferred).
    if (memberDid !== myDid && !this.spaceAdminDids(space).includes(myDid)) {
      throw new Error(`Not authorized to remove members from space ${spaceId}: caller is not an admin`)
    }

    // Slice SR / VE-C1: under the log-sync path, member removal MUST run the
    // two-phase broker-enforced flow (stage → all home brokers confirm space-rotate
    // → commit). The legacy content path (enableLogSync=false) keeps the original
    // single-phase rotate-and-distribute below, UNCHANGED.
    if (this.logSyncEnabled) {
      await this.removeMemberSecure(space, memberDid)
      return
    }

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

    await this.distributeMemberRemovedUpdate(space, memberDid, newGeneration, removedMemberEncryptionKey)

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
   * Notify remaining members AND the removed member of a removal (Sync 005 Z.238)
   * as ECIES-Inbox member-updates (Sync 003 Z.500). The removed member's encryption
   * key is captured before its deletion from memberEncryptionKeys and passed in.
   * Shared by the legacy and the Slice SR commit paths.
   */
  private async distributeMemberRemovedUpdate(
    space: SpaceState,
    memberDid: string,
    newGeneration: number,
    removedMemberEncryptionKey: Uint8Array | undefined,
  ): Promise<void> {
    const spaceId = space.info.id
    const myDid = this.identity.getDid()
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
  }

  /**
   * Slice SR / VE-C1 — two-phase secure removal over the log-sync path. Stages the
   * removal + next-gen key material durably, sends a space-rotate to every home
   * broker, and commits (membership event + key-rotation + member-update + snapshot)
   * ONLY once all brokers confirm. Throws {@link RemovalPendingNotEnforcedError} if
   * staging succeeded but enforcement did not complete (durable; retried by VE-C3).
   */
  private async removeMemberSecure(space: SpaceState, memberDid: string): Promise<void> {
    // Ensure the durable log store is initialized (it owns the pending-removal
    // staging area used by the two-phase workflow).
    const docLogStore = await this.ensureDocLogStore()
    if (!docLogStore) throw new Error('secure removal requires a durable docLogStore')
    const removedEncKey = space.memberEncryptionKeys.get(memberDid)
    await runTwoPhaseRemoval(this.buildSecureRemovalDeps(space, removedEncKey), memberDid)
  }

  /**
   * Build the engine-neutral {@link SecureRemovalDeps} for a space. The home-broker
   * set is {@link AutomergeReplicationAdapterConfig.brokerUrls} (FIXED at removal
   * start). commitRemoval performs the engine-specific membership-event +
   * distribution AFTER the staged generation is activated by the workflow.
   */
  private buildSecureRemovalDeps(
    space: SpaceState,
    removedEncKey: Uint8Array | undefined,
  ): SecureRemovalDeps {
    const spaceId = space.info.id
    const myDid = this.identity.getDid()
    return {
      crypto: this.crypto,
      keyPort: this.keyManagement,
      docLogStore: this.docLogStore!,
      spaceId,
      ownerDid: myDid,
      validityDurationMs: this.capabilityValidityMs,
      homeBrokerSet: this.brokerUrls,
      createRotateFrame: async (newGeneration, newCapVerificationKey) =>
        createSpaceRotateMessageWithSigner({
          spaceId,
          newSpaceCapabilityVerificationKey: encodeBase64Url(newCapVerificationKey),
          newGeneration,
          kid: this.authorKid(),
          sign: (input) => this.identity.signEd25519(input),
        }),
      sendSpaceRotate: async (brokerUrl, frame) => {
        // SF (single-home path): only confirm the broker the workflow asked us to send
        // to if it IS the active broker (brokerUrls[0]) — the coordinator sends over the
        // current connection, so confirming a staged OLD broker would mark the wrong
        // broker enforced after a config change. A generic Error routes the removal to
        // the pending branch (RemovalPendingNotEnforcedError) instead of confirming.
        const activeBroker = this.brokerUrls[0]
        if (brokerUrl !== activeBroker) {
          throw new Error(
            `secure removal: staged broker ${brokerUrl} is not the active broker ${activeBroker ?? '(none)'}; ` +
              'not confirming a rotate sent over a different transport',
          )
        }
        const coordinator = await this.getOrCreateCoordinator(space)
        if (!coordinator) throw new Error('secure removal requires a log-sync coordinator')
        await coordinator.sendSpaceRotate(frame)
      },
      commitRemoval: async (removedDid, newGeneration) => {
        // Drop the removed member from the encryption-key cache so it receives NO
        // key-rotation (only its member-update). The staged generation is already
        // activated by the workflow — distribute it, do NOT re-rotate.
        space.memberEncryptionKeys.delete(removedDid)
        // Slice SR / B3: write the canonical `removed@newGeneration` membership event
        // and DURABLY persist its log entry BEFORE anything else. A throw here rejects
        // commitRemoval → driveRemovalToCompletion does NOT delete the PendingRemoval,
        // so a removal can never be broker-enforced + distributed without a durable
        // membership-removal record.
        await this.commitMembershipEventDurable(space, { did: removedDid, status: 'removed', sinceGeneration: newGeneration })
        await this.distributeKeyRotation(space, newGeneration)
        await this.distributeMemberRemovedUpdate(space, removedDid, newGeneration, removedEncKey)
        await this._persistSpaceMetadata(space)
        this._pushSnapshotToVault(space).catch(() => {})
        for (const cb of this.memberChangeCallbacks) {
          cb({ spaceId, did: removedDid, action: 'removed' })
        }
      },
    }
  }

  /**
   * VE-C3 crash-recovery: resume every durable pending removal whose space is
   * currently loaded. Idempotent — a re-applied space-rotate is treated as
   * already-enforced; a still-unreachable broker leaves the removal staged.
   */
  private async recoverPendingRemovalsOnce(): Promise<void> {
    if (!this.logSyncEnabled) return
    const docLogStore = await this.ensureDocLogStore()
    if (!docLogStore) return
    await recoverPendingRemovals(docLogStore, async (removal) => {
      const space = this.spaces.get(removal.spaceId)
      if (!space) return null
      const removedEncKey = space.memberEncryptionKeys.get(removal.removedDid)
      return this.buildSecureRemovalDeps(space, removedEncKey)
    }).catch((err) => {
      console.debug('[ReplicationAdapter] pending-removal recovery pass failed (retry later):', err)
    })
  }

  /**
   * VE-3 (Sync 005 Z.221): befoerdert einen aktiven Member zum Admin. Schreibt
   * die Haupt-DID in das grow-only doc._admins-Set (idempotent — Re-Promote =
   * no-op) und projiziert info.admins. KEIN broker admin-add-Send (Nicht-Ziel
   * dieses Slice), KEIN neues Signing/kid (VE-5).
   *
   * Guards (client-enforced, Defense-in-depth):
   * 1. Aufrufer-Guard: identity.getDid() ∈ spaceAdminDids — nur ein Admin darf
   *    befoerdern (Z.221 "ein Admin DARF").
   * 2. Aktiver Member: der Promotete MUSS ein aktiver Member sein (Z.130
   *    "Teilmenge von members").
   */
  async promoteToAdmin(spaceId: string, memberDid: string): Promise<void> {
    const space = this.spaces.get(spaceId)
    if (!space) throw new Error(`Unknown space: ${spaceId}`)

    const myDid = this.identity.getDid()
    // Guard 1 (Z.221): nur ein Admin darf befoerdern.
    if (!this.spaceAdminDids(space).includes(myDid)) {
      throw new Error(`Not authorized to promote in space ${spaceId}: caller is not an admin`)
    }
    // Guard 2 (Z.130): nur aktive Members sind promotebar.
    if (!space.info.members.includes(memberDid)) {
      throw new Error(`Cannot promote ${memberDid} in space ${spaceId}: not an active member`)
    }

    const docHandle = this.repo.handles[space.documentId]
    const doc = docHandle?.doc() as { _admins?: Record<string, unknown> } | undefined
    if (!docHandle || !doc) throw new Error(`Cannot access doc for space: ${spaceId}`)
    // Idempotenz: bereits Admin → no-op (grow-only, kein doppelter Eintrag).
    if (doc._admins && memberDid in doc._admins) return
    const entry: AdminEntry = { did: memberDid, addedBy: myDid }
    docHandle.change((d: any) => {
      if (!d._admins) d._admins = {}
      d._admins[memberDid] = { ...entry }
    })

    // Projektion + Persistenz auf demselben Pfad wie members. Der Doc-Change-
    // Handler feuert ohnehin (lokaler change()), seedMembershipProjection deckt
    // den synchronen Pfad ab; hier explizit projizieren + persistieren, damit
    // info.admins sofort konsistent ist und der Pre-Load-Cache mitzieht.
    const projection = this.computeMembershipProjection(this.repo.handles[space.documentId]?.doc())
    space.lastMembershipDigest = projection.digest
    const changed = this.applyMembershipProjection(space, projection)
    await this._persistSpaceMetadata(space)
    if (changed) this._notifySpacesSubscribers()

    // Snapshot mit aktualisiertem _admins an die Member verteilen (fire-and-forget).
    this._pushSnapshotToVault(space).catch(() => {})
    this._saveToCompactStore(space).catch(() => {})
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
    await this.distributeKeyRotation(space, newGeneration)
    return newGeneration
  }

  /**
   * Distribute a key-rotation for an ALREADY-COMMITTED generation to every remaining
   * member in memberEncryptionKeys (Sync 005 Z.230/Z.276). The own DID is skipped
   * (AM multi-device gets the key via _persistSpaceMetadata); the removed member is
   * not in the map. Shared by the legacy path and the Slice SR commit path.
   */
  private async distributeKeyRotation(space: SpaceState, newGeneration: number): Promise<void> {
    const spaceId = space.info.id
    const myDid = this.identity.getDid()
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
  }

  /**
   * VE-2 (1.B.3-admin-management): die kanonische, aktive Admin-Liste fuer die
   * client-enforced Authority-Checks (knownAdminDids in applyKeyRotationBody /
   * processMemberUpdate, adminDids im Invite-Body). Quelle ist das grow-only
   * doc._admins-Set, geschnitten mit den aktiven Members (resolveActiveAdmins,
   * Sync 005 Z.130 "Teilmenge von members") — ein als Member entfernter Admin
   * faellt automatisch heraus.
   *
   * Alt-Space-Fallback (Risk 3/7): Spaces vor diesem Slice haben leeres
   * doc._admins. Damit die Liste NIE leer ist (eine leere Liste autorisiert
   * niemanden → alle key-rotations schlagen hart fehl), faellt sie auf
   * [createdBy ?? members[0]] ∩ active zurueck — exakt die heutige
   * Single-Admin-Semantik. Fuer einen live Space ist das Ergebnis nie leer.
   */
  private spaceAdminDids(space: SpaceState): string[] {
    const doc = this.repo.handles[space.documentId]?.doc()
    const activeMembers = space.info.members
    const active = resolveActiveAdmins(this.readAdminEntries(doc), activeMembers)
    if (active.length > 0) return active
    // Alt-Space-Fallback: SPEC-APPROX createdBy ?? members[0], aber nur wenn
    // aktiv — ein als Member entfernter Creator DARF nicht als Admin gelten
    // (Risk 3, Sync 005 Z.130 "Teilmenge von members"). Spiegelt Yjs.
    const activeSet = new Set(activeMembers)
    const candidate = space.info.createdBy ?? space.info.members[0]
    if (candidate !== undefined && activeSet.has(candidate)) return [candidate]
    // Letzter Fallback: irgendein aktives Mitglied (deterministisch), damit die
    // Liste fuer einen lebenden Space nie leer ist (Risk 7) und NIE einen
    // inaktiven Admin enthaelt (Risk 3).
    return activeMembers.length > 0 ? [[...activeMembers].sort()[0]] : []
  }

  /**
   * Liest das doc._admins-Set (VE-1) defensiv: Eintraege, die nicht als
   * AdminEntry validieren oder deren Record-Key nicht zur did passt, werden
   * uebersprungen — ein fehlerhafter Peer darf die Admin-Projektion nicht
   * kippen. Reservierter Root-Key `_admins` (F-6, wot-spec#99). Analog
   * readMembershipEvents.
   */
  private readAdminEntries(doc: unknown): AdminEntry[] {
    const entries: AdminEntry[] = []
    const admins = (doc as { _admins?: unknown } | undefined)?._admins
    if (admins === null || admins === undefined || typeof admins !== 'object' || Array.isArray(admins)) {
      return entries
    }
    for (const [key, value] of Object.entries(admins as Record<string, unknown>)) {
      try {
        // Automerge-Proxy → plain object, damit assertAdminEntry die Key-Menge prueft.
        const plain = value !== null && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : value
        assertAdminEntry(plain)
        if (key !== plain.did) throw new Error('admin-entry key/value mismatch')
        entries.push(plain)
      } catch (err) {
        console.warn('[ReplicationAdapter] Skipping invalid admin entry:', key, err)
      }
    }
    return entries
  }

  /**
   * Liest das doc._members-Event-Set (VE-1) defensiv: Eintraege, deren Value
   * nicht als MembershipEvent validiert oder deren Key nicht zum Value passt,
   * werden uebersprungen — ein fehlerhafter Peer darf die Projektion nicht
   * kippen. Reservierter Root-Key `_members` (F-6, wot-spec#99): App-Daten
   * unter `members` beruehren das Event-Set nicht.
   */
  private readMembershipEvents(doc: unknown): MembershipEvent[] {
    const events: MembershipEvent[] = []
    const members = (doc as { _members?: unknown } | undefined)?._members
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
   * Review-MINOR-1 (Security): entfernt alle DIDs mit kanonischem
   * removed-Gewinner (Z.305-Lese-Regel) aus dem memberEncryptionKeys-Cache.
   * rotateSpaceKeyAndDistribute verteilt an genau diesen Cache — ohne Pruning
   * wuerde ein zweites Admin-Geraet, das die Entfernung nur via Doc-Sync
   * erhielt (kein lokales removeMember), dem Entfernten die NAECHSTE
   * key-rotation zustellen. Ein Re-Invite setzt den Key in addMember neu.
   */
  private pruneRemovedMemberEncryptionKeys(space: SpaceState, events: readonly MembershipEvent[]): void {
    for (const did of Array.from(space.memberEncryptionKeys.keys())) {
      if (resolveMembershipWinner(events, did)?.status === 'removed') {
        space.memberEncryptionKeys.delete(did)
      }
    }
  }

  /**
   * Deterministischer Doc-Bootstrap fuer ALLE Doc-Erzeugungspfade
   * (Review-Minor + M2): createSpace UND Invites ohne Snapshot-Binary
   * erzeugen mit festem Actor (aus der spaceId abgeleitet) und time 0 die
   * byte-identische Initial-Change inklusive members-Container — der
   * CRDT-Merge dedupliziert sie, konkurrierende Container-Erstellung
   * (Property-Konflikt, Event-Verlust) ist strukturell ausgeschlossen. Der
   * Container existiert damit, BEVOR irgendein Peer ein Membership-Event
   * schreiben kann.
   */
  private inviteBootstrapBinary(spaceId: string): Uint8Array {
    const actor = Array.from(new TextEncoder().encode(spaceId))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    const seeded = Automerge.change(
      Automerge.init<{ _members: Record<string, unknown>; _admins: Record<string, unknown> }>({ actor }),
      { time: 0 },
      (d) => { d._members = {}; d._admins = {} },
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
   * in der Merge-Sicht unsichtbar). Seit M2 erzeugen ALLE Doc-Pfade
   * (createSpace UND Invite-Apply) den Container aus demselben
   * deterministischen inviteBootstrapBinary — byte-identisch, der Merge
   * dedupliziert statt zu konkurrieren. Erreichbar bleibt der lazy-Init nur
   * fuer Alt-Spaces ohne members-Container — dort gilt der akzeptierte Bruch
   * (Anton-Entscheid 2026-06-11): Alt-Spaces sind neu zu erstellen.
   */
  private writeMembershipEvent(space: SpaceState, event: MembershipEvent): void {
    const docHandle = this.repo.handles[space.documentId]
    const doc = docHandle?.doc() as { _members?: Record<string, unknown> } | undefined
    if (!docHandle || !doc) throw new Error(`Cannot access doc for space: ${space.info.id}`)
    const key = formatMembershipEventKey(event)
    if (doc._members && key in doc._members) return
    docHandle.change((d: any) => {
      if (!d._members) d._members = {}
      d._members[key] = { ...event }
    })
  }

  /**
   * Slice SR / B3 — write a membership event AND durably persist its log entry
   * BEFORE returning, propagating any append failure. Used by the secure-removal
   * COMMIT so the canonical `removed@newGeneration` log entry is durable before the
   * PendingRemoval staging is deleted (a crash/append-failure after broker
   * enforcement must NOT leave the removal enforced with no membership-removal record).
   *
   * Mechanics: the change runs with {@link SpaceState.suppressLogForLocalCommit} set so
   * the steady-state observer skips its fire-and-forget write; the produced change is
   * captured via getChanges(before→after) and written through the awaitable
   * {@link LogSyncCoordinator#writeLocalUpdate} (persist-before-send, error-propagating).
   *
   * Idempotency: grow-only — a re-commit of an already-present event produces NO
   * change, so no second log entry is appended and the method returns cleanly.
   */
  private async commitMembershipEventDurable(space: SpaceState, event: MembershipEvent): Promise<void> {
    const docHandle = this.repo.handles[space.documentId]
    const doc = docHandle?.doc() as { _members?: Record<string, unknown> } | undefined
    if (!docHandle || !doc) throw new Error(`Cannot access doc for space: ${space.info.id}`)
    const key = formatMembershipEventKey(event)
    if (doc._members && key in doc._members) return // grow-only: already durable, no-op

    const before = docHandle.doc() as Automerge.Doc<unknown>
    space.suppressLogForLocalCommit = true
    try {
      docHandle.change((d: any) => {
        if (!d._members) d._members = {}
        d._members[key] = { ...event }
      })
    } finally {
      space.suppressLogForLocalCommit = false
    }
    const after = docHandle.doc() as Automerge.Doc<unknown>
    const changes = Automerge.getChanges(before, after)
    if (changes.length === 0) return // no delta → nothing to persist

    if (this.logSyncEnabled) {
      const coordinator = await this.getOrCreateCoordinator(space)
      if (!coordinator) {
        throw new Error('secure removal commit requires a log-sync coordinator to durably record the membership removal')
      }
      // B3: the space-rotate that just enforced this removal invalidated our OWN
      // old-generation scope at the relay. Re-present the (now new-generation)
      // capability BEFORE the write so the durable membership-removal entry is
      // accepted rather than capability-gated (which would time out and falsely fail
      // the commit). The new generation is already active (commitStagedRotation ran
      // before commitRemoval), so the capability source mints for it.
      await coordinator.rePresentCapability()
      // Awaitable + error-propagating: a throw means the durable record was NOT
      // written → the caller does NOT delete the PendingRemoval (VE-C3 retries).
      await coordinator.writeLocalUpdate(frameChanges(changes))
    }
  }

  /**
   * VE-1: space.info.members ist eine read-only Projektion des doc._members-
   * Event-Sets. Zwei Update-Pfade, beide via resolveActiveMembers: der
   * Doc-Change-Handler hier (lokal + remote; reconciliert Sync-Peers,
   * persistiert Metadata, stoesst die VE-4-Resolution an) und der Seed beim
   * Attach/Restore (seedMembershipProjection — bewusst OHNE Resolution,
   * Restore ist kein Space-Sync i.S.v. Sync 005 Z.194).
   * Analogon zum _members-Observer im Yjs-Adapter.
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

  private computeMembershipProjection(doc: unknown): { digest: string; createdBy?: string; members: string[] | null; admins: string[] | null; events: MembershipEvent[] } {
    // F-6: das kanonische Creator-Feld liegt unter dem reservierten Root-Key
    // `_createdBy` — App-Daten unter `createdBy` kippen die Projektion nicht.
    const createdByRaw = (doc as { _createdBy?: unknown } | undefined)?._createdBy
    const createdBy = typeof createdByRaw === 'string' ? createdByRaw : undefined
    const events = this.readMembershipEvents(doc)
    const adminEntries = this.readAdminEntries(doc)
    // VE-1/Risk 5: der _admins-Digest haengt am SELBEN Membership-Digest, damit
    // info.admins auf demselben Observer-/Save-Pfad wie info.members aktualisiert
    // wird (auch reine _admins-Aenderungen feuern die Chain).
    const digest = JSON.stringify([
      createdBy ?? null,
      events.map((event) => formatMembershipEventKey(event)).sort(),
      adminEntries.map((entry) => entry.did).sort(),
    ])
    // Ohne Events (Alt-Space / Bootstrap vor dem ersten Sync) bleibt die
    // bestehende Projektion stehen, bis der CRDT-Merge Events liefert
    // (Sync 002 Z.158: ein Snapshot rollt bekannte Ops nicht zurueck).
    const members = events.length > 0 ? resolveActiveMembers(events) : null
    // info.admins = resolveActiveAdmins(_admins, aktive Members). Ohne Member-
    // Events ist die aktive Basis unbekannt → Projektion offen lassen (wie
    // members), der Doc-Sync liefert sie nach.
    const admins = members !== null ? resolveActiveAdmins(adminEntries, members) : null
    return { digest, createdBy, members, admins, events }
  }

  /** Uebernimmt createdBy + members + admins-Projektion in info und reconciliert die Sync-Peers. */
  private applyMembershipProjection(space: SpaceState, projection: { createdBy?: string; members: string[] | null; admins: string[] | null }): boolean {
    let changed = false
    if (projection.createdBy !== undefined && projection.createdBy !== space.info.createdBy) {
      space.info = { ...space.info, createdBy: projection.createdBy }
      changed = true
    }
    // VE-1/VE-6: info.admins-Projektion auf demselben Pfad wie members. Die
    // aktive Liste wird auch dann uebernommen, wenn nur ein _admins-Eintrag
    // dazukam (members unveraendert) — der Membership-Digest deckt beides ab.
    if (projection.admins !== null && JSON.stringify(projection.admins) !== JSON.stringify(space.info.admins ?? null)) {
      space.info = { ...space.info, admins: projection.admins }
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
    // Review-MINOR-1: der aus der Metadata restaurierte Enc-Key-Cache kann
    // kanonisch bereits entfernte Members tragen (Crash vor dem Chain-Save)
    // — gegen die removed-Gewinner des Docs prunen, wie im Change-Handler-Pfad.
    this.pruneRemovedMemberEncryptionKeys(space, projection.events)
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
    // Review-MINOR-1 (Security): der Enc-Key-Cache darf keine kanonisch
    // entfernten Members tragen — sonst verteilt ein Multi-Device-Admin,
    // der das removed-Event nur via Doc-Sync erhielt (kein lokales
    // removeMember), dem Entfernten bei der naechsten Rotation den NEUEN
    // Content-Key. Persistiert wird das Pruning durch den Chain-Save unten
    // (die PersonalDoc-Metadata traegt die encKeys).
    this.pruneRemovedMemberEncryptionKeys(space, projection.events)
    // #181b-Analogon: der Digest triggert auch bei reinen Event-Aenderungen
    // ohne Projektion-Aenderung. Danach die VE-4-Resolution (Sync 005
    // Z.194-198) — sequenziell, damit ein Resolution-Cleanup
    // (deleteSpaceMetadata) nicht mit dem Metadata-Write racet.
    // Review-M1 Sequenzierung: die Chain wird am Space-State gemerkt, damit
    // handleMemberUpdate sie VOR savePending abwarten kann (sonst loeste die
    // hier eingeplante Resolution ein NACH ihr gespeichertes Pending gegen den
    // aelteren kanonischen Stand auf — Deadlock-Variante des M1-Befunds).
    // Review-M1 (Fix-Runde): VERKETTEN statt ueberschreiben — eine noch
    // laufende aeltere Chain liefe sonst unbeobachtet weiter und loeste
    // Pendings gegen ihren veralteten Members-Stand auf (im Review-Repro bis
    // zum falschen Cleanup). Das catch vor dem then schluckt Fehler der
    // Vorgaenger-Chain (dort bereits geloggt), sonst risse die Kette ab.
    space.membershipResolutionChain = (space.membershipResolutionChain ?? Promise.resolve())
      .catch(() => {})
      .then(() => this._persistSpaceMetadata(space))
      .then(() => this.resolvePendingMemberUpdates(space))
      .catch((err) => console.warn('[ReplicationAdapter] member-update resolution failed:', err))
  }

  /**
   * VE-4 (Sync 005 Z.194-198 MUSS): loest Pending-member-updates gegen die
   * kanonische Mitgliederliste auf — aufgerufen bei jeder kanonischen
   * doc._members-Aenderung (Doc-Change-Handler). confirmed (Z.196-197) und
   * discarded (Z.198, Widerspruch: verwerfen, kanonischen State behalten)
   * werden via resolvePending aus dem Pending-Store entfernt; die UX-Flags
   * werden aus dem verbleibenden Store-Stand re-deriviert (discarded setzt
   * Flags zurueck, loest aber KEIN Cleanup aus).
   *
   * Review-M1 (Fix-Runde): die aktiven Members werden IM AUSFUEHRUNGSZEITPUNKT
   * aus dem Doc re-gelesen statt als Parameter-Snapshot mitgegeben — eine
   * verzoegerte Chain darf Pendings nicht gegen einen veralteten Members-Stand
   * aufloesen (im Review-Repro bis zum falschen Cleanup).
   */
  private async resolvePendingMemberUpdates(space: SpaceState): Promise<void> {
    // Reentranz-Guard VOR dem Doc-Zugriff: nach einem Cleanup ist das
    // Repo-Handle entsorgt — eine nachlaufende Chain darf es nicht mehr lesen.
    if (this.spaces.get(space.info.id) !== space) return
    const doc = this.repo.handles[space.documentId]?.doc()
    if (!doc) return
    const canonicalActiveMembers = resolveActiveMembers(this.readMembershipEvents(doc))
    const pending = await this.memberUpdateStore.listSeenForSpace(space.info.id)
    await this.applyMemberUpdateResolution(space, canonicalActiveMembers, pending)
  }

  /**
   * Review-M1 (Sync 005 Z.194/Z.253): loest NUR die Pendings auf, deren Antwort
   * das kanonische doc._members-Event-Set BEREITS traegt (canonicalEventSet-
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
          knownAdminDids: this.spaceAdminDids(space),
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
      // Slice A Phase 4: detach the log-path change observer + drop the coordinator.
      space.unsubLogChange?.()
      space.unsubLogChange = undefined
      this.coordinators.delete(spaceId)
      this.networkAdapter.setLogSyncManaged(spaceId, false)
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

  async requestSync(spaceId: string): Promise<void> {
    // VE-4 (Phase 4): under log-sync, sync-request(localHeads) is the PRIMARY
    // catch-up path — present read-capability → sync-request → idempotent apply.
    // (Outside log-sync this stays a No-op, see below.)
    if (this.logSyncEnabled && spaceId !== '__all__') {
      const space = this.spaces.get(spaceId)
      if (space) {
        const coordinator = await this.getOrCreateCoordinator(space)
        if (coordinator) {
          await coordinator.catchUp().catch((err) =>
            console.warn(`[ReplicationAdapter] log catch-up failed for ${spaceId}:`, err),
          )
        }
      }
      return
    }
    // VE-6d: No-op — einen expliziten Request-Send wie den Old-World-
    // `sendSpaceSyncRequest` des Yjs-Adapters (dort SPEC-APPROX) gibt es in
    // dieser Architektur nicht; den verlustfreien Normalbetrieb traegt der
    // laufende automerge-repo-Sync (Tests 8/9: Cross-Peer-Konvergenz).
    // Waehrend einer Key-Luecke eintreffende content-Nachrichten werden seit
    // F-1 als blocked-by-key durabel gepuffert und nach rotation-apply bzw.
    // beim start()-Restore erneut gefeedet (Sync 002 Z.173/Z.231-235) — der
    // fruehere CHECK-4-Drop (sentHashes-Suppression, Heads-Ping-Pong) ist
    // geschlossen, der normative Catch-up nach Rotation-Apply (Z.231) wird
    // vom Pending-Replay getragen; ein expliziter Catch-up-Send bleibt
    // unnoetig.
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
    const next = current.filter((m) => pendingMessageId(m) !== pendingMessageId(message))
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
      await store.save(this.pendingMessageStorageKey(message.spaceId, pendingMessageId(message)), encoded)
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
        if (!message.spaceId || !pendingMessageId(message)) throw new Error('Invalid pending message')
        this.addPendingMessageToMemory(message)
      } catch {
        await store.delete(key).catch(() => {})
      }
    }
  }

  private async deletePendingSpaceMessage(spaceId: string, messageId: string): Promise<void> {
    const current = this.pendingMessages.get(spaceId)
    if (current) {
      const next = current.filter((m) => pendingMessageId(m) !== messageId)
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
      // future-rotation vor blocked-by-key-Content (der Key muss erst da
      // sein), unknown-space zuletzt bei Generationsgleichstand.
      const reasonPriority: Record<PendingSpaceMessageReason, number> = {
        'future-rotation': 0,
        'blocked-by-key': 1,
        'unknown-space': 2,
      }
      const ordered = [...pending].sort((a, b) => {
        const genA = a.keyGeneration ?? Number.MAX_SAFE_INTEGER
        const genB = b.keyGeneration ?? Number.MAX_SAFE_INTEGER
        if (genA !== genB) return genA - genB
        return reasonPriority[a.reason] - reasonPriority[b.reason]
      })

      for (const message of ordered) {
        const messageId = pendingMessageId(message)
        const stillPending = this.pendingMessages.get(spaceId)?.some((m) => pendingMessageId(m) === messageId)
        if (!stillPending) continue
        await this.deletePendingSpaceMessage(spaceId, messageId)
        await this.handlePendingSpaceMessage(message)
      }
    } finally {
      this.processingPendingSpaces.delete(spaceId)
    }
  }

  private async handlePendingSpaceMessage(message: PendingSpaceMessage): Promise<void> {
    if (message.decoded) {
      // Bereits verifizierter + replay-recordeter Inbox-Klartext — der Replay läuft
      // bewusst NICHT erneut durch receiveInboxMessage (Message-ID-History würde die
      // eigene Wiedervorlage abweisen). Das ack/1.0 ist beim Buffern bereits gesendet
      // (durably-buffered-pending) — hier kein zweites ack. Anti-loop: ein weiterhin
      // zukünftiger Stand re-buffert (korrekt), alles andere ist konklusiv.
      if (message.decoded.type === KEY_ROTATION_MESSAGE_TYPE) {
        await this.handleKeyRotation(message.decoded)
      }
      return
    }
    if (!message.envelope) return
    // F-1 (Sync 002 Z.231/Z.235): blocked-by-key-Content erneut durch
    // DENSELBEN Decrypt-→repo-Pfad wie der Live-Empfang feeden (kein
    // Sonderpfad; die sentHashes-Suppression des Senders ist irrelevant,
    // weil der Buffer VOR dem repo sitzt — der Sender hat geliefert, die
    // Nachricht wird lokal nachgereicht). Fehlt der Key weiterhin,
    // re-buffert der blocked-Handler.
    await this.networkAdapter.replayContentEnvelope(message.envelope)
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
    // Slice A Phase 4 / VE-3+VE-4: the Sync 002/003 log-path messages
    // (log-entry/1.0, sync-response/1.0) are DIDComm-plaintext too, so route them
    // to the per-space LogSyncCoordinator BEFORE the inbox dispatch. The read path
    // is strictly LOOP-GUARDed (no write, no re-broadcast).
    if (this.logSyncEnabled && isLogPathMessage(message)) {
      await this.routeLogPathMessage(message)
      return
    }
    // P2-NIT-1 (VE-4/VE-5): a routed write-path reject `{ type:'error', thid }` for
    // a SENT log-entry. Route it to the coordinator that owns the correlated thid
    // (so an error for doc A never restore-clones doc B).
    if (this.logSyncEnabled && isErrorFrame(message)) {
      await this.routeWritePathError(message)
      return
    }
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

  // ──────────────────────────────────────────────────────────────────────────
  // Slice A Phase 4 / VE-2..9: log-path wiring (LogSyncCoordinator per space)
  // ──────────────────────────────────────────────────────────────────────────

  /** Lazily init the durable log store exactly once. */
  private async ensureDocLogStore(): Promise<DocLogStore | null> {
    if (!this.docLogStore) return null
    if (!this.docLogStoreInitialized) {
      await this.docLogStore.init()
      this.docLogStoreInitialized = true
    }
    return this.docLogStore
  }

  /**
   * BLOCKER-1b: resolve the deviceId from the DURABLE log store, not from config /
   * external localStorage. Binding the deviceId to the log-store lifecycle makes a
   * store wipe (which empties the log) ALSO mint a fresh deviceId — a fresh nonce
   * namespace — so a leaked store can never re-enter seq=0 under a stable deviceId.
   * Idempotent + cached in `this.deviceId` (process-wide: one device, one id across
   * all docs). Falls back to the config/random id only when no store is wired.
   */
  private async ensureDeviceId(): Promise<string> {
    if (this.deviceIdResolved) return this.deviceId
    const store = await this.ensureDocLogStore()
    if (!store) {
      this.deviceIdResolved = true
      return this.deviceId
    }
    // The DURABLE store is authoritative for the deviceId: it mints+persists a
    // fresh one on an empty store and returns the established (or restore-cloned)
    // id thereafter. A store wipe drops it ⇒ a fresh nonce namespace (BLOCKER-1b),
    // never a re-entered seq=0 under a stable deviceId. The composition root mints
    // this id FIRST and registers the messaging adapter with it, so the relay's
    // author-binding (log deviceId == registered deviceId) holds.
    this.deviceId = await store.getOrCreateDeviceId()
    this.deviceIdResolved = true
    return this.deviceId
  }

  /**
   * The log-entry author kid (`<did>#sig-0`, the Identity-Key verification method).
   * `verifyLogEntryJws` resolves the key from the DID part; signing is via
   * {@link IdentitySession.signEd25519}, so the kid's key matches the signer.
   */
  private authorKid(): string {
    return `${this.identity.getDid()}#sig-0`
  }

  /**
   * VE-9 capability source for a Space-doc: re-issue a Space-Capability JWS
   * (read+write) for the current generation, signed with the per-generation Space
   * Capability signing key (NEVER the Identity key; kid = wot:space:<spaceId>#cap-<gen>).
   * spaceId is the canonical UUID — the kid match holds on the wire.
   */
  private spaceCapabilitySource(spaceId: string): CapabilitySource {
    return {
      getCapabilityJws: async () => {
        const generation = await this.keyManagement.getCurrentGeneration(spaceId)
        const signingSeed = await this.keyManagement.getCapabilitySigningSeed(spaceId, generation)
        if (!signingSeed) throw new Error(`No capability signing seed for space ${spaceId} @ gen ${generation}`)
        const now = Date.now()
        const validityMs = this.capabilityValidityMs ?? 6 * 30 * 24 * 60 * 60 * 1000
        return createSpaceCapabilityJws({
          payload: {
            type: 'capability',
            spaceId,
            audience: this.identity.getDid(),
            permissions: ['read', 'write'],
            generation,
            issuedAt: new Date(now).toISOString(),
            validUntil: new Date(now + validityMs).toISOString(),
          },
          signingSeed,
        })
      },
    }
  }

  /**
   * Automerge engine hooks (VE-2/VE-3). encode = identity (the change observer
   * already passes Automerge change bytes); applyRemote = applyChanges under the
   * LOOP-GUARD flag so a remote-applied change does not re-emit a log-entry.
   * Engine-foreign payloads (e.g. Yjs bytes) make applyChanges throw — the
   * coordinator catches that and skips (engine-foreign-skip), never crashing.
   */
  private automergeEngineHooks(space: SpaceState): LogSyncEngineHooks {
    return {
      engine: 'automerge',
      // The change observer already frames the captured Automerge changes
      // (frameChanges) into the log payload bytes, so encode is identity.
      encodeUpdate: (update) => update,
      applyRemoteUpdate: (plaintext) => {
        const docHandle = this.repo.handles[space.documentId]
        if (!docHandle) throw new Error(`No doc handle for space ${space.info.id}`)
        // Unframe the change array (one log payload may carry 1 steady-state change
        // or N changes for a full-state restore-clone re-write). A non-Automerge
        // (engine-foreign) payload throws here → coordinator skips (VE-3).
        const changes = unframeChanges(plaintext)
        // LOOP-GUARD: mark remote-apply so the change observer suppresses a
        // log-entry for the change this apply produces (Automerge pendant of
        // Yjs origin='remote'). Apply the WHOLE array in ONE update() so exactly
        // one change event fires (and is suppressed). applyChanges throws on
        // engine-foreign / corrupt change bytes.
        space.applyingRemoteLog = true
        try {
          docHandle.update((doc: unknown) => {
            const [next] = Automerge.applyChanges(doc as Automerge.Doc<unknown>, changes)
            return next as never
          })
        } finally {
          space.applyingRemoteLog = false
        }
        // Persist the merged state locally (debounced), mirroring the content path.
        this.compactSchedulers.get(space.info.id)?.pushDebounced()
      },
    }
  }

  /**
   * VE-8 space-register sender for a space. The local user signs the registration
   * with its own admin DID; on join a member re-sends an identical registration
   * (first-writer-wins idempotency). Returns undefined if the user is not an admin.
   */
  private makeSendSpaceRegister(space: SpaceState): () => Promise<ControlFrameReceipt | undefined> {
    return async () => {
      const messaging = this.messaging as MessagingAdapter
      if (typeof messaging.sendControlFrame !== 'function') return undefined
      const spaceId = space.info.id
      const adminDids = this.spaceAdminDids(space)
      const myDid = this.identity.getDid()
      // Only an admin can sign a valid space-register (kid DID MUST be in adminDids).
      if (!adminDids.includes(myDid)) return undefined
      const generation = await this.keyManagement.getCurrentGeneration(spaceId)
      const verificationKey = await this.keyManagement.getCapabilityVerificationKey(spaceId, generation)
      if (!verificationKey) return undefined
      // VE-11: the inner JWS MUST be signed by the Identity key that the `kid`'s
      // did:key resolves to — the REAL relay (verifySpaceRegisterMessage) verifies
      // the signature against that did:key. Sign through identity.signEd25519 via the
      // WithSigner variant (operation-shaped vault never exposes the seed; a
      // deriveFrameworkKey seed would be rejected AUTH_INVALID by the real relay).
      const register = await createSpaceRegisterMessageWithSigner({
        spaceId,
        spaceCapabilityVerificationKey: encodeBase64Url(verificationKey),
        adminDids,
        kid: this.authorKid(),
        sign: (input) => this.identity.signEd25519(input),
      })
      return (await messaging.sendControlFrame(register)) as ControlFrameReceipt
    }
  }

  /**
   * Get (or lazily create) the LogSyncCoordinator for a space (VE-2..9). Returns
   * null when the log path is disabled or there is no durable store. The
   * coordinator's docId is the canonical UUID spaceId (VE-9) — NOT the base58
   * documentId — so all three wire surfaces carry the UUID.
   */
  private async getOrCreateCoordinator(space: SpaceState): Promise<LogSyncCoordinator | null> {
    if (!this.logSyncEnabled) return null
    const spaceId = space.info.id
    const existing = this.coordinators.get(spaceId)
    if (existing) return existing
    const logStore = await this.ensureDocLogStore()
    if (!logStore) return null
    // BLOCKER-1b: bind the deviceId to the durable store BEFORE constructing the
    // coordinator (the seq-namespace owner), so a wiped store yields a fresh id.
    const deviceId = await this.ensureDeviceId()

    const sendControlFrame = (this.messaging as MessagingAdapter).sendControlFrame!
    const coordinator = new LogSyncCoordinator({
      docId: spaceId, // VE-9: canonical UUID, never the base58 documentId.
      deviceId,
      ownDid: this.identity.getDid(),
      authorKid: this.authorKid(),
      crypto: this.crypto,
      logStore,
      control: { sendControlFrame: (frame) => sendControlFrame.call(this.messaging, frame) },
      envelopes: { send: (envelope) => this.messaging.send(envelope as WireMessage) },
      capabilities: this.spaceCapabilitySource(spaceId),
      hooks: this.automergeEngineHooks(space),
      signLogEntry: (input) => this.identity.signEd25519(input),
      getRecipients: () => space.info.members,
      getContentKey: async () => {
        const generation = await this.keyManagement.getCurrentGeneration(spaceId)
        const key = await this.keyManagement.getKeyByGeneration(spaceId, generation)
        return key ? { key, generation } : null
      },
      getContentKeyByGeneration: (generation) => this.keyManagement.getKeyByGeneration(spaceId, generation),
      getAvailableKeyGenerations: async () => {
        const current = await this.keyManagement.getCurrentGeneration(spaceId)
        const gens: number[] = []
        for (let g = 0; g <= current; g++) {
          if (await this.keyManagement.getKeyByGeneration(spaceId, g)) gens.push(g)
        }
        return gens
      },
      sendSpaceRegister: this.makeSendSpaceRegister(space),
      onWriteRejected: this.makeWriteRejectHandler(),
      onAfterRestoreClone: async () => {
        await this.writeFullStateViaLog(space)
      },
    })
    this.coordinators.set(spaceId, coordinator)
    // VE-7: the log path now owns this space's steady-state sync — disable the
    // native automerge-repo content/full-state channel for it.
    this.networkAdapter.setLogSyncManaged(spaceId, true)
    return coordinator
  }

  /**
   * Build the {@link WriteRejectHandler} for a space coordinator (P2-NIT-1). The
   * deviceId minted here is process-wide (one device = one id across all docs);
   * onDeviceIdChanged updates the adapter's active deviceId so subsequent space
   * coordinators created lazily inherit the new id.
   */
  private makeWriteRejectHandler(): WriteRejectHandler {
    return createRestoreCloneHandler({
      identity: this.identity,
      messaging: this.messaging,
      onDeviceIdChanged: async (_docId, newDeviceId) => {
        this.deviceId = newDeviceId
        // BLOCKER-1b: persist the restore-clone's new deviceId into the durable
        // store so a reload adopts the NEW namespace, never the revoked one.
        await this.docLogStore?.setDeviceId(newDeviceId)
      },
    })
  }

  /**
   * Re-write the full current Automerge state of a space as ONE fresh log-entry
   * (restore-clone re-write hook): after the deviceId was re-bound, the new
   * (deviceId,docId) namespace starts at seq=0, so a single full-state entry
   * re-publishes everything under the new device without re-using the colliding
   * seq. The full state is `Automerge.getChanges(init, doc)` flattened into one
   * change blob via save → the receiver applies it through applyChanges.
   */
  private async writeFullStateViaLog(space: SpaceState): Promise<void> {
    const coordinator = this.coordinators.get(space.info.id)
    if (!coordinator) return
    const docHandle = this.repo.handles[space.documentId]
    const doc = docHandle?.doc()
    if (!doc) return
    // The full change set since the empty doc — one log payload carrying every
    // change so the second device converges purely from this entry.
    const changes = Automerge.getAllChanges(doc)
    if (changes.length === 0) return
    const fullStateBlob = frameChanges(changes)
    await coordinator.writeLocalUpdate(fullStateBlob).catch((err) => {
      if (err instanceof AuthorMismatchError) {
        console.error('[ReplicationAdapter] AUTHOR_MISMATCH during restore-clone re-write:', err.message)
        return
      }
      console.debug('[ReplicationAdapter] restore-clone re-write failed (retry on reconnect):', err)
    })
  }

  /**
   * VE-2 write path: route a captured local Automerge change through the
   * LogSyncCoordinator (ensurePublished → appendLocalEntry → log-entry envelope).
   * A hard AUTHOR_MISMATCH is surfaced to audit; transient errors are swallowed
   * (offline / retry on reconnect).
   */
  private async writeLocalUpdateViaLog(space: SpaceState, change: Uint8Array): Promise<void> {
    const coordinator = await this.getOrCreateCoordinator(space)
    if (!coordinator) return
    try {
      await coordinator.writeLocalUpdate(change)
    } catch (err) {
      if (err instanceof AuthorMismatchError) {
        console.error('[ReplicationAdapter] AUTHOR_MISMATCH on log write — hard stop:', err.message)
        return
      }
      console.debug('[ReplicationAdapter] log write failed (will retry on reconnect):', err)
    }
  }

  /**
   * Attach the log-path change observer (VE-2/VE-3): on every LOCAL Automerge
   * change (origin != remote, gated by {@link SpaceState.applyingRemoteLog}),
   * compute the delta via getChanges(before→after) and write it as ONE log-entry.
   * The single producer of outgoing log-entry envelopes for this space.
   */
  private attachLogChangeObserver(space: SpaceState): void {
    if (!this.logSyncEnabled) return
    if (space.unsubLogChange) return
    const docHandle = this.repo.handles[space.documentId]
    if (!docHandle) return
    const handler = (payload: { patchInfo?: { before: unknown; after: unknown } }) => {
      // LOOP-GUARD: a remote-apply sets applyingRemoteLog — never emit a log-entry
      // for a change we applied from a remote log-entry (the 5000+-outbox regression).
      if (space.applyingRemoteLog) return
      // Slice SR / B3: a secure-removal COMMIT takes over the durable write of its
      // membership change explicitly (awaited, error-propagating), so the observer
      // must NOT also fire a fire-and-forget write for it (would create a second seq).
      if (space.suppressLogForLocalCommit) return
      const info = payload?.patchInfo
      if (!info) return
      const changes = Automerge.getChanges(
        info.before as Automerge.Doc<unknown>,
        info.after as Automerge.Doc<unknown>,
      )
      if (changes.length === 0) return
      // One local change() yields exactly one Automerge change; frame the array
      // so the read path can unframe + applyChanges uniformly (VE-2).
      void this.writeLocalUpdateViaLog(space, frameChanges(changes))
    }
    docHandle.on('change', handler)
    space.unsubLogChange = () => docHandle.off('change', handler)
  }

  /**
   * VE-3/VE-4 read path: dispatch an incoming log-path message (log-entry/1.0 or
   * sync-response/1.0) to the coordinator of the doc it targets. The wire docId is
   * the canonical UUID spaceId, so the pre-route is a direct spaces.get(spaceId).
   * LOOP-GUARD: the coordinator never writes/re-broadcasts on receive.
   */
  private async routeLogPathMessage(message: WireMessage): Promise<void> {
    const docId = logPathDocId(message)
    if (!docId) return
    const space = this.spaces.get(docId)
    if (!space) return
    const coordinator = await this.getOrCreateCoordinator(space)
    if (!coordinator) return
    await coordinator.handleIncoming(message)
  }

  /**
   * P2-NIT-1 (VE-4/VE-5): route a routed write-path `error` frame to the
   * coordinator that has the correlated thid in-flight (so an error for doc A never
   * false-triggers a restore-clone on doc B). Dropped if no coordinator owns it.
   */
  private async routeWritePathError(message: WireMessage): Promise<void> {
    const thid = (message as { thid?: unknown }).thid
    if (typeof thid !== 'string') return
    for (const coordinator of this.coordinators.values()) {
      if (coordinator.hasInFlightWrite(thid)) {
        await coordinator.handleIncoming(message)
        return
      }
    }
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

      // Import the doc into automerge-repo. Outside log-sync: under the SENDER's
      // documentId (from the GCM-protected snapshot) so automerge-repo's native
      // sync converges them via the NetworkAdapter. Under log-sync (VE-9): under
      // the docId DERIVED from the canonical UUID spaceId — every device re-maps
      // the SAME base58 id from the SAME UUID, independent of the snapshot
      // documentUrl (cold-start re-map invariant). The creator imported under the
      // identical derived id, so the snapshot's lineage still applies. Without a
      // snapshot binary the deterministic bootstrap is imported (members-container
      // seed); live content rides the log path.
      const importDocId = this.logSyncEnabled ? spaceIdToDocumentId(spaceId) : senderDocId!
      const docHandle = this.repo.import<any>(docBinary ?? this.inviteBootstrapBinary(spaceId), { docId: importDocId })
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
      const doc = docHandle.doc() as { _createdBy?: unknown; name?: unknown; _meta?: Record<string, unknown> } | undefined
      const docMeta = doc?._meta ?? {}
      // VE-1/VE-3: die Mitgliederliste kommt aus dem doc._members-Event-Set des
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
        createdBy: typeof doc?._createdBy === 'string' ? doc._createdBy : undefined,
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

      // VE-8/VE-4 (Sync 002 §207): the joining member runs the FULL publish at
      // invite-accept — space-register (idempotent first-writer-wins for the
      // creator's set) → present-capability → sync-request head-abgleich — BEFORE
      // any local write, then catches up the existing log. The log observer is
      // attached so subsequent edits append from the right seq.
      if (this.logSyncEnabled) {
        this.attachLogChangeObserver(spaceState)
        const coordinator = await this.getOrCreateCoordinator(spaceState)
        if (coordinator) {
          await coordinator.ensurePublished().catch((err) => {
            if (err instanceof AuthorMismatchError) {
              console.error('[ReplicationAdapter] AUTHOR_MISMATCH during join publish:', err.message)
            } else {
              console.debug('[ReplicationAdapter] join first-publication deferred (will retry):', err)
            }
          })
          await coordinator.catchUp().catch((err) =>
            console.warn('[ReplicationAdapter] join log catch-up failed:', err),
          )
        }
      }

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
    const knownAdminDids = this.spaceAdminDids(space)

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
    // Sync 002 Z.235: gepufferte future-rotations UND blocked-by-key-Content
    // in aufsteigender Generation erneut pruefen, sobald die Luecke
    // geschlossen ist (F-1-Replay-Hook nach rotation-apply).
    await this.processPendingForSpace(body.spaceId)
    // VE-6c: future-gepufferte member-updates, deren Generation jetzt erreicht
    // ist, re-verarbeiten (aufsteigend, Sync 002 Z.235).
    await this.replayFutureMemberUpdates(body.spaceId)
    // Slice SR / VE-C2: the legitimate lagger just imported the missed rotation —
    // drain any KEY_GENERATION_STALE re-emit that parked because the new generation
    // had not arrived yet. Re-emits the SAME update under a NEW seq + the new gen
    // (never the same seq). LOOP-GUARD-safe: only fires once the rejected gen is
    // strictly behind the current one. Because VE-C2 lives in the engine-neutral
    // coordinator, this mirrors the Yjs adapter's drain exactly.
    if (this.logSyncEnabled) {
      const coordinator = this.coordinators.get(body.spaceId)
      if (coordinator) {
        await coordinator.replayPendingReemits().catch((err) =>
          console.debug('[ReplicationAdapter] pending-reemit replay failed:', err),
        )
        // Slice SR-2 / Symptom A (real-WS lagger liveness): a lagger that wrote during
        // the rotation window may have had its stale gen-0 write rejected on the REAL
        // relay by the CAPABILITY gate (the rotation deleted its gen-0 scope atomically
        // via invalidateStaleScopesForDoc) — a reject that carries NO thid today, so it
        // was DROPPED client-side and never parked a re-emit (replayPendingReemits above
        // is a no-op for it). Now that the new generation is imported, re-present the
        // CURRENT (gen-N) capability and re-send the still-pending stale entries: the
        // relay's capability gate passes (gen-N cap), the generations-gate then rejects
        // KEY_GENERATION_STALE (WITH thid, P4) → routed → catchUpGenerationAndReemit →
        // generation already advanced → performReemit under a NEW seq. This makes the
        // lagging write converge in-session WITHOUT relying on TEIL 2 (KEY_GENERATION_STALE
        // already carries thid). catchUp() re-presents the current capability and runs the
        // established sync-request; resendPending() re-sends only STILL-PENDING entries
        // (the EXISTING stored JWS verbatim — same seq, same plaintext, same alt-gen key,
        // NO nonce reuse). LOOP-GUARD: a healthy member has no stale-pending entries, so
        // resendPending is a no-op and catchUp adds at most one present-capability +
        // sync-request per rotation import (never a write loop). catchUp() MUST run BEFORE
        // resendPending() so the gen-N capability is presented before the re-send. Mirrors
        // the Yjs adapter exactly (VE-C2 lives in the engine-neutral coordinator).
        await coordinator.catchUp().catch((err) =>
          console.debug('[ReplicationAdapter] post-rotation catch-up failed:', err),
        )
        await coordinator.resendPending().catch((err) =>
          console.debug('[ReplicationAdapter] post-rotation resend-pending failed:', err),
        )
      }
    }
    // VE-6d (Sync 002 Z.231 "sync-request ausloesen"): kein expliziter
    // Catch-up-Send noetig — waehrend der Key-Luecke eingetroffene content-
    // Nachrichten lagen im blocked-by-key-Buffer und wurden soeben via
    // processPendingForSpace erneut gefeedet (F-1, Sync 002 Z.173).
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
    // VE-2 (1.B.3-admin-management): knownAdminDids = volle aktive Admin-Liste
    // (spaceAdminDids), nicht mehr die createdBy-Single-Approximation.
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
        knownAdminDids: this.spaceAdminDids(space),
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
    // expliziter Catch-up-Send fuer result.triggerSpaceCatchUp — der laufende
    // automerge-repo-Sync plus der blocked-by-key-Content-Buffer (F-1,
    // Sync 002 Z.173) decken den Catch-up ab (siehe requestSync-Kommentar).
    console.debug('[ReplicationAdapter] member-update disposition:', result.disposition)
    // Alle Workflow-Dispositionen sind ackable (Signal via memberUpdateStore
    // recorded bzw. konklusiv ignoriert); die durable Store-Verdrahtung ist
    // 1.D-Scope (heute InMemory-Default, wie #188).
    return result.ackable
      ? { kind: 'applied', durable: true }
      : { kind: 'processing-incomplete', waitingOn: 'durable-apply' }
  }
}

// ── Slice A Phase 4 log-path helpers (module-level) ───────────────────────────

/** True for a log-path envelope (log-entry/1.0 or sync-response/1.0). */
function isLogPathMessage(message: WireMessage): boolean {
  const type = (message as { type?: unknown }).type
  return type === LOG_ENTRY_MESSAGE_TYPE || type === SYNC_RESPONSE_MESSAGE_TYPE
}

/** True for a routed write-path reject frame (`{ type:'error', thid, code }`). */
function isErrorFrame(message: WireMessage): boolean {
  return (message as { type?: unknown }).type === 'error'
}

/**
 * Coarse docId pre-route for a log-path message (the coordinator re-derives +
 * verifies). The wire docId is the canonical UUID spaceId (VE-9), so a direct
 * spaces.get(docId) picks the owning coordinator:
 *  - sync-response: `body.docId` directly.
 *  - log-entry: decode (NOT verify) the inner JWS payload to read `docId`; the
 *    coordinator's receiveLogEntry then does the authoritative verify + docId check.
 */
function logPathDocId(message: WireMessage): string | undefined {
  const type = (message as { type?: unknown }).type
  if (type === SYNC_RESPONSE_MESSAGE_TYPE) {
    const body = (message as { body?: { docId?: unknown } }).body
    return typeof body?.docId === 'string' ? body.docId : undefined
  }
  if (type === LOG_ENTRY_MESSAGE_TYPE) {
    const entry = (message as { body?: { entry?: unknown } }).body?.entry
    if (typeof entry !== 'string') return undefined
    try {
      const payloadSegment = entry.split('.')[1]
      if (!payloadSegment) return undefined
      const json = new TextDecoder().decode(decodeBase64Url(payloadSegment))
      const payload = JSON.parse(json) as { docId?: unknown }
      return typeof payload.docId === 'string' ? payload.docId : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}
