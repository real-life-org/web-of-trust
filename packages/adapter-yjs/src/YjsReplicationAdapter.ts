/**
 * YjsReplicationAdapter — ReplicationAdapter backed by Yjs CRDTs
 *
 * Drop-in alternative to AutomergeReplicationAdapter.
 * Uses Y.Doc (pure JavaScript) instead of Automerge (Rust→WASM).
 *
 * Key differences:
 * - No Repo, DocHandle, NetworkAdapter (automerge-repo concepts)
 * - One Y.Doc per space, stored in a simple Map
 * - Encrypted sync via MessagingAdapter directly (same pattern as YjsPersonalSyncAdapter)
 * - No compaction needed (Yjs has built-in GC)
 */
import * as Y from 'yjs'
import type {
  ReplicationAdapter,
  SpaceHandle,
  TransactOptions,
  Subscribable,
  MessagingAdapter,
  MessageIdHistoryPort,
  SpaceMetadataStorage,
  KeyManagementPort,
  MemberUpdatePendingStore,
  WireMessage,
} from '@web_of_trust/core/ports'
import type { IdentitySession, MessageEnvelope, SpaceInfo, SpaceDocMeta, SpaceMemberChange, IncomingSpaceInvite, ReplicationState } from '@web_of_trust/core/types'
import {
  createSpaceKey, rotateSpaceKey, importKey, processMemberUpdate,
  buildSpaceInviteBody, applySpaceInviteBody, buildKeyRotationBody, applyKeyRotationBody,
  deliverInboxMessage, receiveInboxMessage,
} from '@web_of_trust/core/application'
import type {
  ProtocolCryptoAdapter, MemberUpdateSignal, SpaceInviteBody, KeyRotationBody,
  DidResolver, DidcommPlaintextMessage, InboxAckLocalOutcome, InboxMessageKind,
} from '@web_of_trust/core/protocol'
import {
  decryptOneShot, encryptOneShot, assertMemberUpdateBody, encodeBase64Url, decodeBase64Url,
  assertSpaceInviteBody, assertKeyRotationBody,
  SPACE_INVITE_MESSAGE_TYPE, MEMBER_UPDATE_MESSAGE_TYPE, KEY_ROTATION_MESSAGE_TYPE,
  isDidcommMessage, isEncryptedInboxMessageType, INBOX_MESSAGE_TYPE,
  createAckMessage, evaluateInboxAckDisposition, createDidKeyResolver,
} from '@web_of_trust/core/protocol'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import {
  VaultClient,
  VaultPushScheduler,
  base64ToUint8,
  InMemoryKeyManagementAdapter,
  InMemoryMemberUpdatePendingStore,
  InMemoryMessageIdHistory,
} from '@web_of_trust/core/adapters'
import {
  signEnvelope,
  verifyEnvelope,
} from '@web_of_trust/core/crypto'
import {
  traceAsync,
} from '@web_of_trust/core/storage'

/** Duck-typed interface for CompactStorageManager / InMemoryCompactStore */
export interface YjsCompactStore {
  save(docId: string, data: Uint8Array): Promise<void>
  load(docId: string): Promise<Uint8Array | null>
  delete?(docId: string): Promise<void>
  list?(): Promise<string[]>
}

type DurablePendingStore = YjsCompactStore & {
  delete(docId: string): Promise<void>
  list(): Promise<string[]>
}

type PendingSpaceMessageReason = 'unknown-space' | 'blocked-by-key' | 'future-rotation'

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

interface PendingSpaceMessage {
  spaceId: string
  /** Old-World-Envelope (CRDT-Sync-Kanal: content). */
  envelope?: MessageEnvelope
  /**
   * DIDComm-Inbox-Klartext (key-rotation future-buffer): bereits verifiziert;
   * die durable Pufferung ist ein konklusiver Ausgang, daher recorded der
   * Empfangspfad die Message-ID direkt nach dem Buffern (Sync 003 Z.620-622).
   * Die Wiedervorlage läuft NICHT erneut durch receiveInboxMessage, sonst
   * würde die Message-ID-History sie abweisen.
   */
  decoded?: DecodedInboxMessage
  receivedAt: number
  reason: PendingSpaceMessageReason
  keyGeneration?: number
}

function pendingMessageId(message: PendingSpaceMessage): string {
  return message.envelope?.id ?? message.decoded?.outerId ?? ''
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

class PendingMessageNotDurableError extends Error {}

interface YjsSpaceState {
  info: SpaceInfo
  doc: Y.Doc
  handles: Set<YjsSpaceHandle<any>>
  memberEncryptionKeys: Map<string, Uint8Array>
  unsubUpdate: (() => void) | null
  // In-memory pending member-update UX flags (Sync 005 Z.183-184). NOT canonical state.
  // Durable persistence arrives with the Demo-Hook migration (1.D).
  pendingRemoval?: { effectiveKeyGeneration: number }
  pendingAddition?: { effectiveKeyGeneration: number }
}

interface YjsReplicationConfig {
  identity: IdentitySession
  messaging: MessagingAdapter
  keyManagement?: KeyManagementPort
  memberUpdateStore?: MemberUpdatePendingStore
  /** DID-Resolver für Inner-JWS-Verifikation (Default: did:key, wie verifyEnvelope bisher). */
  didResolver?: DidResolver
  /** Replay-Schutz Sync 003 Z.466 (Default: InMemory; durable Store kommt mit 1.D). */
  messageIdHistory?: MessageIdHistoryPort
  /** Broker URLs advertised in space-invite bodies (Sync 005 Z.42). */
  brokerUrls?: readonly string[]
  /** Capability validity window override (default 6 months, Sync 003 Z.249). */
  capabilityValidityMs?: number
  metadataStorage?: SpaceMetadataStorage
  compactStore?: YjsCompactStore
  vaultUrl?: string
  vault?: VaultClient  // direct injection for testing
  spaceFilter?: (info: SpaceInfo) => boolean
  /** Flush PersonalDoc to Vault immediately (for key rotation safety) */
  flushPersonalDoc?: () => Promise<void>
  /** Pull PersonalDoc from Vault (for lazy key refresh) */
  refreshPersonalDocFromVault?: () => Promise<boolean>
  /** Crypto adapter for one-shot encrypt/decrypt (defaults to WebCryptoProtocolCryptoAdapter) */
  crypto?: ProtocolCryptoAdapter
}

// --- YjsSpaceHandle ---

class YjsSpaceHandle<T> implements SpaceHandle<T> {
  readonly id: string
  private closed = false
  private remoteUpdateCallbacks = new Set<() => void>()
  private unsubChange: (() => void) | null = null

  constructor(
    private spaceState: YjsSpaceState,
    private adapter: YjsReplicationAdapter,
  ) {
    this.id = spaceState.info.id
    // Listen for remote changes
    const handler = (_update: Uint8Array, origin: any) => {
      if (origin === 'remote' && !this.closed) {
        for (const cb of this.remoteUpdateCallbacks) {
          try { cb() } catch (err) { console.error('[YjsSpaceHandle] Remote update callback error:', err) }
        }
      }
    }
    this.spaceState.doc.on('update', handler)
    this.unsubChange = () => this.spaceState.doc.off('update', handler)
    this.spaceState.handles.add(this)
  }

  info(): SpaceInfo {
    return this.spaceState.info
  }

  getDoc(): T {
    return ymapToPlain(this.spaceState.doc.getMap('data')) as T
  }

  getMeta(): SpaceDocMeta {
    const metaMap = this.spaceState.doc.getMap('_meta')
    return {
      name: metaMap.get('name') as string | undefined,
      description: metaMap.get('description') as string | undefined,
      image: metaMap.get('image') as string | undefined,
    }
  }

  transact(fn: (doc: T) => void, options?: TransactOptions): void {
    if (this.closed) return

    this.spaceState.doc.transact(() => {
      const proxy = createDataProxy<T>(this.spaceState.doc.getMap('data'))
      fn(proxy)
    }, 'local')

    // Persistence
    if (options?.stream) {
      this.adapter._scheduleCompactDebounced(this.spaceState)
      this.adapter._scheduleVaultDebounced(this.spaceState)
    } else {
      this.adapter._scheduleCompactImmediate(this.spaceState)
      this.adapter._scheduleVaultImmediate(this.spaceState)
    }
  }

  onRemoteUpdate(callback: () => void): () => void {
    this.remoteUpdateCallbacks.add(callback)
    return () => { this.remoteUpdateCallbacks.delete(callback) }
  }

  close(): void {
    this.closed = true
    this.unsubChange?.()
    this.remoteUpdateCallbacks.clear()
    this.spaceState.handles.delete(this)
  }
}

// --- Proxy helpers (same pattern as YjsPersonalDocManager) ---

function ymapToPlain(ymap: Y.Map<any>): Record<string, any> {
  const obj: Record<string, any> = {}
  ymap.forEach((value, key) => {
    if (value instanceof Y.Map) {
      obj[key] = ymapToPlain(value)
    } else if (value instanceof Y.Array) {
      obj[key] = value.toArray()
    } else {
      obj[key] = value
    }
  })
  return obj
}

function createDataProxy<T>(ymap: Y.Map<any>): T {
  return new Proxy({} as any, {
    get(_target, prop: string) {
      const value = ymap.get(prop)
      if (value instanceof Y.Map) {
        return createDataProxy(value)
      } else if (value instanceof Y.Array) {
        // Return a proxy array that supports push()
        return createArrayProxy(value)
      }
      return value
    },
    set(_target, prop: string, value: any) {
      if (Array.isArray(value)) {
        const yarray = new Y.Array()
        yarray.push(value)
        ymap.set(prop, yarray)
      } else if (value && typeof value === 'object') {
        let childMap = ymap.get(prop) as Y.Map<any> | undefined
        if (!(childMap instanceof Y.Map)) {
          childMap = new Y.Map()
          ymap.set(prop, childMap)
        }
        applyPlainToYmap(childMap, value)
      } else {
        ymap.set(prop, value)
      }
      return true
    },
    deleteProperty(_target, prop: string) {
      ymap.delete(prop)
      return true
    },
    has(_target, prop: string) {
      return ymap.has(prop)
    },
    ownKeys() {
      return Array.from(ymap.keys())
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      if (ymap.has(prop)) {
        return { configurable: true, enumerable: true, writable: true, value: ymap.get(prop) }
      }
      return undefined
    },
  }) as T
}

function createArrayProxy(yarray: Y.Array<any>): any[] {
  return new Proxy([] as any[], {
    get(_target, prop) {
      if (prop === 'push') {
        return (...items: any[]) => { yarray.push(items); return yarray.length }
      }
      if (prop === 'length') return yarray.length
      if (prop === Symbol.iterator) return () => yarray.toArray()[Symbol.iterator]()
      if (typeof prop === 'string' && !isNaN(Number(prop))) {
        return yarray.get(Number(prop))
      }
      // Forward other array methods to a snapshot
      const arr = yarray.toArray()
      const val = (arr as any)[prop]
      if (typeof val === 'function') return val.bind(arr)
      return val
    },
  })
}

function applyPlainToYmap(ymap: Y.Map<any>, plain: Record<string, any>): void {
  for (const [key, value] of Object.entries(plain)) {
    if (Array.isArray(value)) {
      const yarray = new Y.Array()
      yarray.push(value)
      ymap.set(key, yarray)
    } else if (value && typeof value === 'object') {
      let childMap = ymap.get(key) as Y.Map<any> | undefined
      if (!(childMap instanceof Y.Map)) {
        childMap = new Y.Map()
        ymap.set(key, childMap)
      }
      applyPlainToYmap(childMap, value)
    } else {
      ymap.set(key, value)
    }
  }
}

function applyInitialDoc(doc: Y.Doc, initialDoc: Record<string, any>): void {
  const dataMap = doc.getMap('data')
  applyPlainToYmap(dataMap, initialDoc)
}

// --- YjsReplicationAdapter ---

export class YjsReplicationAdapter implements ReplicationAdapter {
  private identity: IdentitySession
  private messaging: MessagingAdapter
  private readonly keyManagement: KeyManagementPort
  private readonly memberUpdateStore: MemberUpdatePendingStore
  private readonly didResolver: DidResolver
  private readonly messageIdHistory: MessageIdHistoryPort
  private metadataStorage?: SpaceMetadataStorage
  private compactStore?: YjsCompactStore
  private vault?: VaultClient
  private readonly crypto: ProtocolCryptoAdapter
  private readonly brokerUrls: readonly string[]
  private readonly capabilityValidityMs?: number
  private spaceFilter?: (info: SpaceInfo) => boolean

  private spaces = new Map<string, YjsSpaceState>()
  private spaceListeners = new Set<(spaces: SpaceInfo[]) => void>()
  private memberChangeListeners = new Set<(change: SpaceMemberChange) => void>()
  private spaceInviteListeners = new Set<(invite: IncomingSpaceInvite) => void>()
  private vaultSchedulers = new Map<string, VaultPushScheduler>()
  private compactSchedulers = new Map<string, VaultPushScheduler>()
  private vaultSeqs = new Map<string, number>()
  /** Cache 404 responses from Vault to avoid repeated requests for non-existent docs */
  private vault404Cache = new Map<string, number>() // spaceId → timestamp
  private static VAULT_404_TTL = 5 * 60_000 // 5 minutes
  private unsubMessage: (() => void) | null = null
  private unsubStateChange: (() => void) | null = null
  private reconnectFollowupTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private sentMessageIds = new Set<string>()

  // Buffer for messages that cannot be applied until space/key dependencies arrive.
  private pendingMessages = new Map<string, PendingSpaceMessage[]>()
  private processingPendingSpaces = new Set<string>()
  private static readonly PENDING_MESSAGE_PREFIX = '__wot_pending_space_message__:'

  private flushPersonalDoc?: () => Promise<void>
  private refreshPersonalDocFromVault?: () => Promise<boolean>

  constructor(config: YjsReplicationConfig) {
    this.identity = config.identity
    this.messaging = config.messaging
    this.keyManagement = config.keyManagement ?? new InMemoryKeyManagementAdapter()
    this.memberUpdateStore = config.memberUpdateStore ?? new InMemoryMemberUpdatePendingStore()
    this.didResolver = config.didResolver ?? createDidKeyResolver()
    this.messageIdHistory = config.messageIdHistory ?? new InMemoryMessageIdHistory()
    this.metadataStorage = config.metadataStorage
    this.compactStore = config.compactStore
    this.brokerUrls = config.brokerUrls ?? []
    this.capabilityValidityMs = config.capabilityValidityMs
    this.spaceFilter = config.spaceFilter
    this.flushPersonalDoc = config.flushPersonalDoc
    this.refreshPersonalDocFromVault = config.refreshPersonalDocFromVault
    this.crypto = config.crypto ?? new WebCryptoProtocolCryptoAdapter()
    if (config.vault) {
      this.vault = config.vault
    } else if (config.vaultUrl) {
      this.vault = new VaultClient(config.vaultUrl, config.identity)
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // Listen for incoming messages
    this.unsubMessage = this.messaging.onMessage(async (message: WireMessage) => {
      // Skip own echoes
      if (this.sentMessageIds.has(message.id)) {
        this.sentMessageIds.delete(message.id)

        return
      }

      // VE-1/VE-8 Familien-Split (Sync 003 Z.328-341): DIDComm-Inbox-Familie
      // (space-invite/member-update/key-rotation als ECIES+Inner-JWS) vs.
      // Old-World-CRDT-Sync-Kanal (content/space-sync-request). Kein Typ
      // existiert in beiden Familien.
      if (isDidcommMessage(message)) {
        await this.handleInboxEnvelope(message)
        return
      }
      const envelope = message as MessageEnvelope

      // Verify envelope signature — reject forged messages (CRDT-Sync-Kanal)
      if (envelope.signature) {
        const valid = await verifyEnvelope(envelope)
        if (!valid) {
          console.warn('[YjsReplication] Rejected message with invalid signature from', envelope.fromDid)
          return
        }
      }

      switch (envelope.type as string) {
        case 'content':
          await this.handleContentMessage(envelope)
          break
        case 'space-sync-request':
          await this.handleSpaceSyncRequest(envelope)
          break
      }
    })

    await this.restorePendingMessages()

    // Restore spaces from metadata (CompactStore → local Y.Doc)
    await this.restoreSpacesFromMetadata()
    console.debug(`[YjsReplication] after restoreSpacesFromMetadata: ${this.spaces.size} spaces`, Array.from(this.spaces.keys()))

    // Initial sync: send full state of all spaces to own DID (multi-device)
    // and pull latest from Vault as safety net
    await this._sendFullStateAllSpaces()

    // Pull latest Vault snapshots (without re-running restoreSpacesFromMetadata
    // and _sendFullStateAllSpaces which already ran above)
    console.debug(`[YjsReplication] before _pullAllFromVault: ${this.spaces.size} spaces`)
    await this._pullAllFromVault()
    console.debug(`[YjsReplication] after _pullAllFromVault: ${this.spaces.size} spaces`)

    // On reconnect: re-send full state + vault pull (without duplicate restoreSpacesFromMetadata).
    // Debounce: rapid reconnect cycles (connected→disconnected→connected) should
    // only trigger one sync, not one per state change.
    if ('onStateChange' in this.messaging && typeof (this.messaging as any).onStateChange === 'function') {
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null
      let reconnectSyncing = false
      this.unsubStateChange = (this.messaging as any).onStateChange((state: string) => {
        if (state === 'connected' && this.started) {
          if (reconnectTimer) clearTimeout(reconnectTimer)
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            if (reconnectSyncing) return
            reconnectSyncing = true
            Promise.all([
              this._sendFullStateAllSpaces().catch(() => {}),
              this._pullAllFromVault().catch(() => {}),
            ]).finally(() => {
              reconnectSyncing = false
              this.scheduleReconnectFollowupPull()
            })
          }, 2000)
        }
      })
    }
  }

  async stop(): Promise<void> {
    this.unsubMessage?.()
    this.unsubMessage = null
    this.unsubStateChange?.()
    this.unsubStateChange = null
    if (this.reconnectFollowupTimer) {
      clearTimeout(this.reconnectFollowupTimer)
      this.reconnectFollowupTimer = null
    }
    // In-memory cache only. Durable pending messages remain in CompactStore
    // until they are applied or the space is explicitly deleted.
    this.pendingMessages.clear()

    for (const [, scheduler] of this.vaultSchedulers) scheduler.destroy()
    for (const [, scheduler] of this.compactSchedulers) scheduler.destroy()
    this.vaultSchedulers.clear()
    this.compactSchedulers.clear()

    for (const [, state] of this.spaces) {
      state.unsubUpdate?.()
      for (const handle of state.handles) handle.close()
      state.doc.destroy()
    }
    this.spaces.clear()
    this.started = false
  }

  private scheduleReconnectFollowupPull(): void {
    if (!this.vault || !this.started) return
    if (this.reconnectFollowupTimer) clearTimeout(this.reconnectFollowupTimer)
    this.reconnectFollowupTimer = setTimeout(() => {
      this.reconnectFollowupTimer = null
      if (!this.started) return
      // Remote devices may still be finishing their Vault push when we first
      // reconnect. Pull once more shortly after the initial reconnect sync.
      this._pullAllFromVault().catch(() => {})
    }, 10_000)
  }

  getState(): ReplicationState {
    return this.started ? 'syncing' : 'idle'
  }

  async createSpace<T>(type: SpaceInfo['type'], initialDoc: T, meta?: { name?: string; description?: string; appTag?: string; modules?: string[] }): Promise<SpaceInfo> {
    const spaceId = crypto.randomUUID()
    const now = new Date().toISOString()
    const myDid = this.identity.getDid()

    const info: SpaceInfo = {
      id: spaceId,
      type,
      name: meta?.name,
      description: meta?.description,
      modules: meta?.modules,
      appTag: meta?.appTag,
      members: [myDid],
      createdAt: now,
    }

    // Create Y.Doc
    const doc = new Y.Doc()
    doc.transact(() => {
      applyInitialDoc(doc, initialDoc as Record<string, any>)
      // Set shared metadata in _meta map. appTag included: invited members must
      // inherit cross-app isolation (the invite carries no plaintext spaceInfo).
      if (meta?.name || meta?.description || meta?.modules || meta?.appTag) {
        const metaMap = doc.getMap('_meta')
        if (meta.name) metaMap.set('name', meta.name)
        if (meta.description) metaMap.set('description', meta.description)
        if (meta.modules) metaMap.set('modules', meta.modules)
        if (meta.appTag) metaMap.set('appTag', meta.appTag)
      }
    }, 'local')

    // Create group key + capability key pair + owner self-capability
    await createSpaceKey({ crypto: this.crypto, keyPort: this.keyManagement, spaceId, ownerDid: this.identity.getDid(), validityDurationMs: this.capabilityValidityMs })

    // Store state (include own encryption key for multi-device key rotation)
    const ownEncKey = await this.identity.getEncryptionPublicKeyBytes()
    const state: YjsSpaceState = {
      info,
      doc,
      handles: new Set(),
      memberEncryptionKeys: new Map([[this.identity.getDid(), ownEncKey]]),
      unsubUpdate: null,
    }
    this.spaces.set(spaceId, state)

    // Setup encrypted sync for this space
    this.setupSpaceSync(state)

    // Save to CompactStore
    await this._saveToCompactStore(state)

    // Save metadata + group key
    if (this.metadataStorage) {
      await this.metadataStorage.saveSpaceMetadata({
        info,
        documentId: spaceId,
        documentUrl: `yjs:${spaceId}`,
        memberEncryptionKeys: {},
      })
      const groupKey = await this.keyManagement.getCurrentKey(spaceId)
      const generation = await this.keyManagement.getCurrentGeneration(spaceId)
      if (groupKey) {
        await this.metadataStorage.saveGroupKey({ spaceId, generation, key: groupKey })
      }
    }

    this.notifySpaceListeners()

    // Multi-device: send full doc state to own DID as content message.
    // Other devices that discover this space via PersonalDoc sync will receive
    // the full state and merge it into their (initially empty) Y.Doc.
    // We use 'content' type (not 'space-invite') to avoid triggering UI notifications.
    const groupKey = await this.keyManagement.getCurrentKey(spaceId)
    if (groupKey) {
      const myDid = this.identity.getDid()
      const docBinary = Y.encodeStateAsUpdate(doc)
      const generation = await this.keyManagement.getCurrentGeneration(spaceId)
      const encrypted = await encryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, plaintext: docBinary })
      const payload = {
        spaceId,
        generation,
        ciphertext: Array.from(encrypted.ciphertextTag),
        nonce: Array.from(encrypted.nonce),
      }
      const envelope: MessageEnvelope = {
        v: 1, id: crypto.randomUUID(), type: 'content',
        fromDid: myDid, toDid: myDid,
        createdAt: new Date().toISOString(), encoding: 'json',
        payload: JSON.stringify(payload), signature: '',
      }
      const signed = await signEnvelope(envelope, (data) => this.identity.sign(data))
      this.sentMessageIds.add(signed.id)
      setTimeout(() => this.sentMessageIds.delete(signed.id), 30_000)
      try { await this.messaging.send(signed) } catch { /* offline */ }
    }

    // Push initial state to Vault so other devices can pull it
    this._scheduleVaultImmediate(state)

    return info
  }

  async openSpace<T>(spaceId: string): Promise<SpaceHandle<T>> {
    const state = this.spaces.get(spaceId)
    if (!state) throw new Error(`Space ${spaceId} not found`)

    // Create schedulers if not exists
    this.ensureSchedulers(state)

    return new YjsSpaceHandle<T>(state, this)
  }

  async getSpace(spaceId: string): Promise<SpaceInfo | null> {
    return this.spaces.get(spaceId)?.info ?? null
  }

  async getSpaces(): Promise<SpaceInfo[]> {
    return Array.from(this.spaces.values()).map(s => s.info)
  }

  watchSpaces(): Subscribable<SpaceInfo[]> {
    let snapshot = Array.from(this.spaces.values()).map(s => s.info)
    return {
      subscribe: (callback) => {
        const listener = (spaces: SpaceInfo[]) => {
          snapshot = spaces
          callback(spaces)
        }
        this.spaceListeners.add(listener)
        return () => { this.spaceListeners.delete(listener) }
      },
      getValue: () => snapshot,
    }
  }

  async addMember(spaceId: string, memberDid: string, memberEncryptionPublicKey: Uint8Array): Promise<void> {
    const state = this.spaces.get(spaceId)
    if (!state) throw new Error(`Space ${spaceId} not found`)

    // C3 (Sync 005 Z.42): brokerUrls MUST be non-empty for a space-invite. Fail fast
    // BEFORE any state mutation so a misconfigured runtime cannot leave a half-added
    // member (stored encryption key / extended members list) behind.
    if (this.brokerUrls.length === 0) {
      throw new Error('addMember/invite requires brokerUrls in YjsReplicationConfig (Sync 005 Z.42)')
    }

    const myDid = this.identity.getDid()
    const previousMembers = [...state.info.members]

    // Store member key
    state.memberEncryptionKeys.set(memberDid, memberEncryptionPublicKey)

    // Update members
    if (!state.info.members.includes(memberDid)) {
      state.info.members = [...state.info.members, memberDid]
    }

    // Spec-conformant invite body (Sync 005 Z.62-103): all content keys + capability +
    // signing key. SPEC-APPROX: adminDids = [members[0]] (full list in 1.B.3-admin-management).
    const inviteBody = await buildSpaceInviteBody({
      keyPort: this.keyManagement,
      spaceId,
      recipientDid: memberDid,
      brokerUrls: this.brokerUrls,
      adminDids: [state.info.members[0]],
      validityDurationMs: this.capabilityValidityMs,
    })

    // Demo-Extension (VE-5, outside the spec body): the initial doc snapshot rides as
    // extension field next to the ECIES container (OneShot blob under the current
    // content key, Base64URL) — NOT in SpaceInviteBody, NOT im Inner-JWS (selbst
    // verschlüsselt, kein Autoritätsträger). Display metadata travels inside the
    // encrypted doc's _meta.
    const groupKey = (await this.keyManagement.getKeyByGeneration(spaceId, inviteBody.currentKeyGeneration))!
    const docBinary = Y.encodeStateAsUpdate(state.doc)
    const docSnapshot = await encryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, plaintext: docBinary })

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
    this.sentMessageIds.add(envelope.id)
    setTimeout(() => this.sentMessageIds.delete(envelope.id), 30_000)
    await this.messaging.send(envelope)

    // Without a members array in space-invite, tell the invited member about
    // members that were already present. The synced space doc remains canonical.
    const generation = inviteBody.currentKeyGeneration
    for (const existingDid of previousMembers) {
      if (existingDid === myDid || existingDid === memberDid) continue

      const updateEnvelope = await deliverInboxMessage({
        type: MEMBER_UPDATE_MESSAGE_TYPE,
        body: {
          spaceId,
          action: 'added',
          memberDid: existingDid,
          effectiveKeyGeneration: generation,
        },
        from: myDid,
        to: memberDid,
        recipientEncryptionPublicKey: memberEncryptionPublicKey,
        sign: (input) => this.identity.signEd25519(input),
        crypto: this.crypto,
      })
      try { await this.messaging.send(updateEnvelope) } catch { /* offline */ }
    }

    // Notify other members
    await this.sendMemberUpdate(spaceId, memberDid, 'added')

    // Save metadata
    await this.saveSpaceMetadata(state)

    // Notify
    for (const cb of this.memberChangeListeners) {
      cb({ spaceId, did: memberDid, action: 'added' })
    }
    this.notifySpaceListeners()
  }

  async removeMember(spaceId: string, memberDid: string): Promise<void> {
    const state = this.spaces.get(spaceId)
    if (!state) return

    const myDid = this.identity.getDid()
    // Den Encryption-Key des Entfernten VOR dem Löschen sichern — er bekommt unten
    // noch sein member-update (Sync 005 Z.238) als ECIES-Inbox-Nachricht.
    const removedMemberEncryptionKey = state.memberEncryptionKeys.get(memberDid)
    state.memberEncryptionKeys.delete(memberDid)
    state.info.members = state.info.members.filter(d => d !== memberDid)

    // Rotate group key + fresh capability key pair + self-capability
    await rotateSpaceKey({ crypto: this.crypto, keyPort: this.keyManagement, spaceId, ownerDid: this.identity.getDid(), validityDurationMs: this.capabilityValidityMs })
    const newKey = (await this.keyManagement.getCurrentKey(spaceId))!
    const newGen = await this.keyManagement.getCurrentGeneration(spaceId)

    // Save rotated key to own PersonalDoc (for multi-device: other devices
    // will find it via loadGroupKeys on startup)
    if (this.metadataStorage) {
      await this.metadataStorage.saveGroupKey({
        spaceId, generation: newGen, key: newKey,
      })
    }
    // Ensure the new key reaches the Vault before we continue —
    // other devices need it to decrypt the re-encrypted space snapshot
    if (this.flushPersonalDoc) {
      await this.flushPersonalDoc()
    }

    // Distribute the rotated key + capability to the REMAINING members (incl. own DID for
    // multi-device) as spec-conformant key-rotation (Sync 005 Z.230/Z.276). The removed member
    // is NOT in memberEncryptionKeys (deleted above), so it does not receive a key-rotation —
    // it only receives a member-update below (Sync 005 Z.238).
    for (const [did, encPub] of state.memberEncryptionKeys) {
      const rotationBody = await buildKeyRotationBody({
        keyPort: this.keyManagement,
        spaceId,
        newGeneration: newGen,
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
        recipientEncryptionPublicKey: encPub,
        sign: (input) => this.identity.signEd25519(input),
        crypto: this.crypto,
      })
      this.sentMessageIds.add(envelope.id)
      setTimeout(() => this.sentMessageIds.delete(envelope.id), 30_000)
      await this.messaging.send(envelope)
    }

    // Notify remaining members AND the removed member (Sync 005 Z.238). member-update
    // ist eine Inbox-Nachricht: ECIES für den jeweiligen Empfänger (Sync 003 Z.500 MUSS) —
    // der Group-Key-OneShot-Pfad (Pre-Rotation-Key) ist tot.
    const notifyDids = [...state.info.members, memberDid]
    const clearBody = {
      spaceId,
      memberDid,
      action: 'removed' as const,
      effectiveKeyGeneration: newGen,
    }

    for (const did of notifyDids) {
      if (did === myDid) continue

      const encPub = did === memberDid ? removedMemberEncryptionKey : state.memberEncryptionKeys.get(did)
      if (!encPub) {
        // Ohne Empfänger-Encryption-Key keine spec-konforme Zustellung möglich —
        // kein Klartext-Fallback (Sync 003 Z.500). Key-Discovery via Sync 004
        // (keyAgreement im DID-Dokument) ist der vorgesehene Vervollständigungspfad.
        console.warn('[YjsReplication] No encryption key for', did, '— skipping member-update delivery')
        continue
      }

      const envelope = await deliverInboxMessage({
        type: MEMBER_UPDATE_MESSAGE_TYPE,
        body: clearBody,
        from: myDid,
        to: did,
        recipientEncryptionPublicKey: encPub,
        sign: (input) => this.identity.signEd25519(input),
        crypto: this.crypto,
      })
      try { await this.messaging.send(envelope) } catch { /* offline */ }
    }

    await this.saveSpaceMetadata(state)

    // Re-encrypt and push snapshot with new generation key
    // so Vault always has a snapshot decryptable with the current key
    this._scheduleVaultImmediate(state)

    for (const cb of this.memberChangeListeners) {
      cb({ spaceId, did: memberDid, action: 'removed' })
    }
    this.notifySpaceListeners()
  }

  onMemberChange(callback: (change: SpaceMemberChange) => void): () => void {
    this.memberChangeListeners.add(callback)
    return () => { this.memberChangeListeners.delete(callback) }
  }

  /** Decoded space-invite event — the wire payload is an ECIES container, so UI must subscribe here. */
  onSpaceInvite(callback: (invite: IncomingSpaceInvite) => void): () => void {
    this.spaceInviteListeners.add(callback)
    return () => { this.spaceInviteListeners.delete(callback) }
  }

  private emitSpaceInvite(invite: IncomingSpaceInvite): void {
    for (const cb of this.spaceInviteListeners) cb(invite)
  }

  /** Leave a space: clean up local state, metadata, group keys, compact store */
  async leaveSpace(spaceId: string): Promise<void> {
    const state = this.spaces.get(spaceId)
    if (state) {
      state.unsubUpdate?.()
      state.doc.destroy()
      this.spaces.delete(spaceId)
    }

    // Clean up schedulers
    this.vaultSchedulers.get(spaceId)?.destroy()
    this.vaultSchedulers.delete(spaceId)
    this.compactSchedulers.get(spaceId)?.destroy()
    this.compactSchedulers.delete(spaceId)

    // Remove from persistent storage (PersonalDoc + CompactStore)
    if (this.metadataStorage) {
      await this.metadataStorage.deleteSpaceMetadata(spaceId)
      await this.metadataStorage.deleteGroupKeys(spaceId)
    }
    await this.deletePendingMessagesForSpace(spaceId)
    if (this.compactStore && 'delete' in this.compactStore) {
      await (this.compactStore as any).delete(spaceId)
    }

    // Delete space doc from Vault
    if (this.vault) {
      await this.vault.deleteDoc(spaceId).catch(() => {})
    }

    // Flush PersonalDoc to Vault immediately so the deletion persists
    // (otherwise debounced push may not fire before page unload)
    if (this.flushPersonalDoc) {
      await this.flushPersonalDoc()
    }

    this.notifySpaceListeners()
  }

  async requestSync(spaceId: string): Promise<void> {
    if (spaceId === '__all__') {
      // Discover new spaces from PersonalDoc that we don't know yet
      await this.restoreSpacesFromMetadata()

      // PersonalDoc catch-up may have delivered missing group keys for spaces
      // that were already loaded. Reload keys before replaying blocked messages.
      for (const spaceId of this.spaces.keys()) {
        await this._reloadGroupKeys(spaceId)
        await this.processPendingForSpace(spaceId)
      }

      // Pull latest Vault snapshots for all existing spaces (with concurrency limit)
      await this._pullAllFromVault()

      // Send full state of all spaces to own DID (multi-device state exchange)
      await this._sendFullStateAllSpaces()
    } else {
      const state = this.spaces.get(spaceId)
      if (state) {
        await this._pullFromVault(state).catch(e =>
          console.warn(`[YjsReplication] Vault pull failed for ${spaceId}:`, e)
        )
      }
    }
  }

  private static readonly VAULT_PULL_CONCURRENCY = 3

  /** Pull from Vault for all spaces with concurrency limit */
  private async _pullAllFromVault(): Promise<void> {
    const entries = Array.from(this.spaces.entries())
    await this._runWithConcurrency(entries, async ([id, state]) => {
      await this._pullFromVault(state).catch(e =>
        console.warn(`[YjsReplication] Vault pull failed for ${id}:`, e)
      )
    }, YjsReplicationAdapter.VAULT_PULL_CONCURRENCY)
  }

  /**
   * Pull the latest snapshot from the Vault and merge into the local Y.Doc.
   * This ensures multi-device sync even when devices were not online simultaneously.
   * If decryption fails (missing key after rotation), tries to refresh the PersonalDoc
   * from the Vault to get the new key, then retries.
   */
  private async _pullFromVault(state: YjsSpaceState, isRetry = false): Promise<void> {
    if (!this.vault) return

    // Skip docs that recently returned 404 from Vault
    const cached404 = this.vault404Cache.get(state.info.id)
    if (cached404 && Date.now() - cached404 < YjsReplicationAdapter.VAULT_404_TTL) {
      return
    }

    const groupKey = await this.keyManagement.getCurrentKey(state.info.id)
    if (!groupKey) {
      // No key at all — try refreshing PersonalDoc from Vault
      if (!isRetry && this.refreshPersonalDocFromVault) {
        const refreshed = await this.refreshPersonalDocFromVault()
        if (refreshed) {
          await this._reloadGroupKeys(state.info.id)
          return this._pullFromVault(state, true)
        }
      }
      return
    }

    // Seq-Vergleich: skip download if vault snapshot hasn't changed
    const info = await this.vault.getDocInfo(state.info.id)
    if (!info) {
      // Doc doesn't exist in Vault — cache 404 to avoid repeated requests
      this.vault404Cache.set(state.info.id, Date.now())
      return
    }
    if (info.snapshotSeq !== null) {
      const localSeq = this.vaultSeqs.get(state.info.id) ?? -1
      if (info.snapshotSeq === localSeq) return // no change
      this.vaultSeqs.set(state.info.id, info.snapshotSeq)
    }

    const response = await this.vault.getChanges(state.info.id)
    if (!response.snapshot) return

    const packed = base64ToUint8(response.snapshot.data)
    const nonceLen = packed[0]
    const nonce = packed.slice(1, 1 + nonceLen)
    const ciphertext = packed.slice(1 + nonceLen)

    // OneShot vault snapshot: rebuild blob = nonce ‖ ciphertext+tag (Sync 001 Z.103).
    const blob = new Uint8Array(nonce.length + ciphertext.length)
    blob.set(nonce, 0)
    blob.set(ciphertext, nonce.length)
    try {
      const decrypted = await traceAsync('crypto', 'read', `decrypt vault ${state.info.id.slice(0, 8)}`, () =>
        decryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, blob }),
        { spaceId: state.info.id },
      )

      await traceAsync('crdt', 'sync', `apply vault snapshot ${state.info.id.slice(0, 8)}`, async () => {
        Y.applyUpdate(state.doc, decrypted, 'remote')
        return decrypted
      }, { spaceId: state.info.id, sizeBytes: decrypted.byteLength })
      this.vaultSeqs.set(state.info.id, response.snapshot.upToSeq)
    } catch (err) {
      // Decryption failed — key may be outdated (rotation happened while offline)
      // Try refreshing PersonalDoc from Vault to get the new key
      // Reset cached seq so the next pull re-downloads the snapshot
      this.vaultSeqs.delete(state.info.id)

      // Try refreshing PersonalDoc from Vault to get the new key, then retry
      if (!isRetry && this.refreshPersonalDocFromVault) {
        const refreshed = await this.refreshPersonalDocFromVault()
        if (refreshed) {
          await this._reloadGroupKeys(state.info.id)
          return this._pullFromVault(state, true)
        }
      }
    }
  }

  /** Reload group keys from metadata storage into the KeyManagementPort */
  private async _reloadGroupKeys(spaceId: string): Promise<void> {
    if (!this.metadataStorage) return
    const keys = await this.metadataStorage.loadGroupKeys(spaceId)
    for (const k of keys) {
      await importKey(this.keyManagement, k.spaceId, k.generation, k.key)
    }
  }

  /**
   * Send full Y.Doc state of all spaces to own DID (multi-device sync).
   * Other devices of the same identity merge the state via Y.applyUpdate.
   * Analogous to YjsPersonalSyncAdapter.sendFullState().
   */
  private async _sendFullStateAllSpaces(): Promise<void> {
    const myDid = this.identity.getDid()

    for (const [spaceId, state] of this.spaces) {
      const groupKey = await this.keyManagement.getCurrentKey(spaceId)
      if (!groupKey) continue

      const fullState = Y.encodeStateAsUpdate(state.doc)
      // Don't broadcast empty docs
      if (fullState.length <= 2) continue
      const generation = await this.keyManagement.getCurrentGeneration(spaceId)
      const encrypted = await traceAsync('crypto', 'write', `encrypt fullstate ${spaceId.slice(0, 8)}`, () =>
        encryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, plaintext: fullState }),
        { spaceId, sizeBytes: fullState.byteLength },
      )

      const payload = {
        spaceId,
        generation,
        ciphertext: Array.from(encrypted.ciphertextTag),
        nonce: Array.from(encrypted.nonce),
      }

      // Send to ALL members (not just self) so offline changes propagate on reconnect
      await Promise.all(state.info.members.map(async (memberDid) => {
        const envelope: MessageEnvelope = {
          v: 1, id: crypto.randomUUID(), type: 'content',
          fromDid: myDid, toDid: memberDid,
          createdAt: new Date().toISOString(), encoding: 'json',
          payload: JSON.stringify(payload), signature: '',
        }
        const signed = await signEnvelope(envelope, (data) => this.identity.sign(data))
        this.sentMessageIds.add(signed.id)
        setTimeout(() => this.sentMessageIds.delete(signed.id), 30_000)
        try { await this.messaging.send(signed) } catch { /* offline */ }
      }))
    }
  }

  async getKeyGeneration(spaceId: string): Promise<number> {
    return this.keyManagement.getCurrentGeneration(spaceId)
  }

  async updateSpace(spaceId: string, meta: SpaceDocMeta): Promise<void> {
    const state = this.spaces.get(spaceId)
    if (!state) throw new Error(`Space ${spaceId} not found`)

    state.doc.transact(() => {
      const metaMap = state.doc.getMap('_meta')
      if (meta.name !== undefined) metaMap.set('name', meta.name)
      if (meta.description !== undefined) metaMap.set('description', meta.description)
      if (meta.image !== undefined) metaMap.set('image', meta.image)
      if (meta.modules !== undefined) metaMap.set('modules', meta.modules)
    }, 'local')

    // Persistence
    this._scheduleCompactImmediate(state)
    this._scheduleVaultImmediate(state)
  }

  // --- Restore from metadata ---

  async restoreSpacesFromMetadata(): Promise<void> {
    if (!this.metadataStorage) return

    const allMeta = await this.metadataStorage.loadAllSpaceMetadata()
    console.debug(`[YjsReplication] restoreSpacesFromMetadata: ${allMeta.length} spaces from metadata, ${this.spaces.size} already loaded`)
    for (const meta of allMeta) {
      console.debug(`[YjsReplication]   space: ${meta.info.id} name=${meta.info.name} type=${meta.info.type}`)

      if (this.spaces.has(meta.info.id)) continue
      if (this.spaceFilter && !this.spaceFilter(meta.info)) continue

      // Restore group keys
      const keys = await this.metadataStorage.loadGroupKeys(meta.info.id)
      for (const k of keys) {
        await importKey(this.keyManagement, k.spaceId, k.generation, k.key)
      }

      // Try to restore from CompactStore
      let binary: Uint8Array | null = null
      if (this.compactStore) {
        binary = await this.compactStore.load(meta.info.id)
      }
      const isEmpty = !binary || binary.length <= 2
      const hasGroupKey = (await this.keyManagement.getCurrentKey(meta.info.id)) !== null
      const ageMs = meta.info.createdAt ? Date.now() - new Date(meta.info.createdAt).getTime() : 0

      // Ghost-space detection: no group key + empty doc + older than 10 minutes
      // A freshly joined space may temporarily have no key, so we give it time
      if (!hasGroupKey && isEmpty && ageMs > 10 * 60_000) {
        console.debug(`[YjsReplication] Removing ghost space ${meta.info.id} (no key, empty doc, age ${(ageMs / 60_000).toFixed(0)}min)`)
        await this.metadataStorage.deleteSpaceMetadata(meta.info.id)
        await this.metadataStorage.deleteGroupKeys(meta.info.id)
        await this.deletePendingMessagesForSpace(meta.info.id)
        if (this.compactStore && 'delete' in this.compactStore) {
          await (this.compactStore as any).delete(meta.info.id)
        }
        continue
      }

      // Create Y.Doc
      const doc = new Y.Doc()
      if (binary) {
        await traceAsync('crdt', 'read', `load space ${meta.info.id.slice(0, 8)}`, async () => {
          Y.applyUpdate(doc, binary!)
          return binary!
        }, { spaceId: meta.info.id, sizeBytes: binary.byteLength })
      }

      // Read _meta from Y.Doc (overrides PersonalDoc values)
      const metaMap = doc.getMap('_meta')
      const metaName = metaMap.get('name') as string | undefined
      const metaDesc = metaMap.get('description') as string | undefined
      const metaImg = metaMap.get('image') as string | undefined
      const metaModules = metaMap.get('modules') as string[] | undefined
      if (metaName !== undefined) meta.info.name = metaName
      if (metaDesc !== undefined) meta.info.description = metaDesc
      if (metaImg !== undefined) meta.info.image = metaImg
      if (metaModules !== undefined) meta.info.modules = metaModules

      const state: YjsSpaceState = {
        info: meta.info,
        doc,
        handles: new Set(),
        memberEncryptionKeys: new Map(
          Object.entries(meta.memberEncryptionKeys).map(([did, arr]) => [did, new Uint8Array(arr)])
        ),
        unsubUpdate: null,
      }
      this.spaces.set(meta.info.id, state)
      this.setupSpaceSync(state)

      await this.processPendingForSpace(meta.info.id)

      // Request full state from other devices (fire-and-forget, don't block restore)
      void this.sendSpaceSyncRequest(meta.info.id).catch(() => {})

      // Vault pull happens later in _pullAllFromVault() with concurrency limit
    }

    this.notifySpaceListeners()
  }

  // --- Internal: Encrypted Space Sync ---

  private setupSpaceSync(state: YjsSpaceState): void {
    const handler = (update: Uint8Array, origin: any) => {
      if (origin === 'remote') return
      void this.sendEncryptedUpdate(state.info.id, update)
    }
    state.doc.on('update', handler)

    // Observe _meta map for name/description changes (local + remote)
    const metaMap = state.doc.getMap('_meta')
    const metaHandler = () => {
      const name = metaMap.get('name') as string | undefined
      const desc = metaMap.get('description') as string | undefined
      const img = metaMap.get('image') as string | undefined
      let changed = false
      if (name !== undefined && name !== state.info.name) {
        state.info = { ...state.info, name }
        changed = true
      }
      if (desc !== undefined && desc !== state.info.description) {
        state.info = { ...state.info, description: desc }
        changed = true
      }
      if (img !== undefined && img !== state.info.image) {
        state.info = { ...state.info, image: img }
        changed = true
      }
      const modules = metaMap.get('modules') as string[] | undefined
      if (modules !== undefined && JSON.stringify(modules) !== JSON.stringify(state.info.modules)) {
        state.info = { ...state.info, modules }
        changed = true
      }
      if (changed) {
        this.saveSpaceMetadata(state)
        this.notifySpaceListeners()
      }
    }
    metaMap.observe(metaHandler)

    state.unsubUpdate = () => {
      state.doc.off('update', handler)
      metaMap.unobserve(metaHandler)
    }
  }

  private async sendEncryptedUpdate(spaceId: string, update: Uint8Array): Promise<void> {
    const groupKey = await this.keyManagement.getCurrentKey(spaceId)
    if (!groupKey) return

    const generation = await this.keyManagement.getCurrentGeneration(spaceId)
    const myDid = this.identity.getDid()

    const encrypted = await traceAsync('crypto', 'write', `encrypt update ${spaceId.slice(0, 8)}`, () =>
      encryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, plaintext: update }),
      { spaceId, sizeBytes: update.byteLength },
    )

    const payload = {
      spaceId,
      generation,
      ciphertext: Array.from(encrypted.ciphertextTag),
      nonce: Array.from(encrypted.nonce),
    }

    // Send to all members (including own DID for multi-device sync)
    // sentMessageIds prevents the sending device from processing its own echo
    const state = this.spaces.get(spaceId)
    if (!state) return


    await Promise.all(state.info.members.map(async (memberDid) => {
      const envelope: MessageEnvelope = {
        v: 1, id: crypto.randomUUID(), type: 'content',
        fromDid: myDid, toDid: memberDid,
        createdAt: new Date().toISOString(), encoding: 'json',
        payload: JSON.stringify(payload), signature: '',
      }
      const signed = await signEnvelope(envelope, (data) => this.identity.sign(data))
      this.sentMessageIds.add(signed.id)
      setTimeout(() => this.sentMessageIds.delete(signed.id), 30_000)
      try { await this.messaging.send(signed) } catch { /* offline */ }
    }))
  }

  private async handleContentMessage(envelope: MessageEnvelope): Promise<void> {
    try {
      const payload = JSON.parse(envelope.payload)
      const spaceId = payload.spaceId
      const state = this.spaces.get(spaceId)

      if (!state) {
        await this.bufferPendingSpaceMessage({
          spaceId,
          envelope,
          receivedAt: Date.now(),
          reason: 'unknown-space',
          keyGeneration: typeof payload.generation === 'number' ? payload.generation : undefined,
        })
        return
      }

      const groupKey = await this.keyManagement.getKeyByGeneration(spaceId, payload.generation)
      if (!groupKey) {
        await this.bufferPendingSpaceMessage({
          spaceId,
          envelope,
          receivedAt: Date.now(),
          reason: 'blocked-by-key',
          keyGeneration: typeof payload.generation === 'number' ? payload.generation : undefined,
        })
        return
      }

      const contentNonce = new Uint8Array(payload.nonce)
      const contentCiphertext = new Uint8Array(payload.ciphertext)
      const contentBlob = new Uint8Array(contentNonce.length + contentCiphertext.length)
      contentBlob.set(contentNonce, 0)
      contentBlob.set(contentCiphertext, contentNonce.length)
      const decrypted = await traceAsync('crypto', 'read', `decrypt content ${spaceId.slice(0, 8)}`, () =>
        decryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, blob: contentBlob }),
        { spaceId, fromDid: envelope.fromDid },
      )

      await traceAsync('crdt', 'write', `applyUpdate ${spaceId.slice(0, 8)}`, async () => {
        Y.applyUpdate(state.doc, decrypted, 'remote')
        return decrypted
      }, { spaceId, sizeBytes: decrypted.byteLength })


      // Persist
      this._scheduleCompactDebounced(state)
      await this.deletePendingSpaceMessage(spaceId, envelope.id)
    } catch (err) {
      console.debug('[YjsReplication] Failed to handle content message:', err)
      if (err instanceof PendingMessageNotDurableError) throw err
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
      console.warn('[YjsReplication] Rejected inbox message:', result.reason, type)
      return
    }

    // Reines Datenobjekt (ohne Workflow-Closures) — der key-rotation
    // future-buffer persistiert decoded ggf. durabel.
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
      console.debug('[YjsReplication] Inbox message processing failed:', err)
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
      console.warn('[YjsReplication] Failed to send ack/1.0 for', originalMessageId, err)
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
      console.warn('[YjsReplication] Rejected space-invite: malformed body', err)
      return { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false }
    }

    try {
      const spaceId = body.spaceId

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
        console.warn('[YjsReplication] Rejected space-invite:', result.reason, 'from', decoded.senderDid)
        return { kind: 'invalid-rejected', rejection: 'inner-verification-failed', authoritativeStateChanged: false }
      }

      // Demo-Extension (VE-5): der initiale Doc-Snapshot reist als Extension-Feld
      // neben dem ECIES-Container (OneShot-Blob, Base64URL). Ein spec-konformer
      // Invite ohne Snapshot ist vollständig anwendbar — Inhalt kommt via Sync.
      const groupKey = (await this.keyManagement.getKeyByGeneration(spaceId, body.currentKeyGeneration))!
      let decrypted: Uint8Array | null = null
      const snapshotBlob = decoded.extensionFields.encryptedDocSnapshot
      if (typeof snapshotBlob === 'string' && snapshotBlob.length > 0) {
        decrypted = await decryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, blob: decodeBase64Url(snapshotBlob) })
      }

      // If space already exists (discovered via PersonalDoc sync), merge the snapshot
      // instead of ignoring it — the existing doc may be empty
      const existing = this.spaces.get(spaceId)
      if (existing) {
        if (decrypted) {
          Y.applyUpdate(existing.doc, decrypted, 'remote')
          this._scheduleCompactDebounced(existing)
        }
        this.emitSpaceInvite({ spaceId, spaceName: existing.info.name, fromDid: decoded.senderDid })
        return { kind: 'applied', durable: true }
      }

      // Create Y.Doc from the decrypted snapshot (or empty — content arrives via sync)
      const doc = new Y.Doc()
      if (decrypted) Y.applyUpdate(doc, decrypted, 'remote')

      // Display metadata travels inside the encrypted doc's _meta — SpaceInviteBody carries
      // no spaceInfo (Sync 005). Invited spaces are 'shared'; appTag rides in _meta so
      // cross-app isolation survives the invite; createdAt has no in-repo consumer.
      const metaMap = doc.getMap('_meta')
      const info: SpaceInfo = {
        id: spaceId,
        type: 'shared',
        name: metaMap.get('name') as string | undefined,
        description: metaMap.get('description') as string | undefined,
        image: metaMap.get('image') as string | undefined,
        modules: metaMap.get('modules') as string[] | undefined,
        appTag: metaMap.get('appTag') as string | undefined,
        members: Array.from(new Set([decoded.senderDid, this.identity.getDid()])),
        createdAt: new Date().toISOString(),
      }

      const state: YjsSpaceState = {
        info,
        doc,
        handles: new Set(),
        memberEncryptionKeys: new Map(),
        unsubUpdate: null,
      }
      this.spaces.set(spaceId, state)
      this.setupSpaceSync(state)

      // Save
      await this._saveToCompactStore(state)
      await this.saveSpaceMetadata(state)

      // Save group key to metadata (multi-device durability)
      if (this.metadataStorage) {
        await this.metadataStorage.saveGroupKey({
          spaceId,
          generation: body.currentKeyGeneration,
          key: groupKey,
        })
      }

      await this.processPendingForSpace(spaceId)

      this.notifySpaceListeners()
      this.emitSpaceInvite({ spaceId, spaceName: info.name, fromDid: decoded.senderDid })
      return { kind: 'applied', durable: true }
    } catch (err) {
      console.debug('[YjsReplication] Failed to handle space invite:', err)
      return { kind: 'processing-incomplete', waitingOn: 'durable-apply' }
    }
  }

  private async handleMemberUpdate(decoded: DecodedInboxMessage): Promise<InboxAckLocalOutcome> {
    // K4: validate the clear protocol body before mapping to a signal. Der
    // Group-Key-Decrypt-Pfad (encryptOneShot) ist tot — member-update ist eine
    // ECIES-Inbox-Nachricht (Sync 003 Z.500), immer mit eigenem Key lesbar;
    // 'blocked-by-key'-Buffering hat damit keine Spec-Grundlage mehr.
    try {
      assertMemberUpdateBody(decoded.body)
    } catch (err) {
      console.warn('[YjsReplication] Rejected member-update: malformed body', err)
      return { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false }
    }
    const body = decoded.body

    const state = this.spaces.get(body.spaceId)
    if (!state) {
      // Unbekannter Space: kein ack → Relay-Redelivery, bis der zugehörige
      // space-invite angekommen ist (Sync 003 Z.620-622).
      return {
        kind: 'pending',
        durability: 'not-buffered',
        dependencies: [{ kind: 'missing-space-invite', docId: body.spaceId }],
      }
    }

    // Authority-Split (Sync 005 Z.169-177): membership authority lives in the
    // application workflow, NOT the adapter. The adapter maps wire→signal, delegates
    // classification, and applies only the local pending UX flag.
    // SPEC-APPROX: members[0] als alleiniger Admin; full Admin-Liste folgt im
    // 1.B.3-admin-management-Slice.
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
        knownAdminDids: [state.info.members[0]],
        knownMemberDids: state.info.members,
        seenUpdates: await this.memberUpdateStore.listSeenForSpace(body.spaceId),
      },
      store: this.memberUpdateStore,
      localDid: this.identity.getDid(),
    })

    // K3 (Sync 005 Z.183-184 + Z.191): member-update is a pending UX signal only.
    // NO doc.destroy, NO spaces.delete, NO metadataStorage.deleteSpaceMetadata, NO
    // durable cleanup — canonical cleanup happens on confirmed Space-Sync (later slice).
    // UI-Behavior: the pendingRemoval flag must be evaluated by the UI; Demo-Hook
    // migration follows in 1.D.
    switch (result.localImpact) {
      case 'mark-removal-pending':
        state.pendingRemoval = { effectiveKeyGeneration: signal.effectiveKeyGeneration }
        delete state.pendingAddition // mutually exclusive
        break
      case 'mark-addition-pending':
        state.pendingAddition = { effectiveKeyGeneration: signal.effectiveKeyGeneration }
        delete state.pendingRemoval // mutually exclusive
        break
      case 'none':
        break
    }

    if (result.triggerSpaceCatchUp) {
      this.requestSync(body.spaceId).catch((err) =>
        console.warn('[YjsReplication] member-update sync-request failed', err))
    }
    console.debug('[YjsReplication] member-update disposition:', result.disposition)
    // Alle Workflow-Dispositionen sind ackable (Signal via memberUpdateStore
    // recorded bzw. konklusiv ignoriert); die durable Store-Verdrahtung ist
    // 1.D-Scope (heute InMemory-Default, wie #188).
    return result.ackable
      ? { kind: 'applied', durable: true }
      : { kind: 'processing-incomplete', waitingOn: 'durable-apply' }
  }

  private async handleKeyRotation(decoded: DecodedInboxMessage): Promise<InboxAckLocalOutcome> {
    try {
      assertKeyRotationBody(decoded.body)
    } catch (err) {
      console.warn('[YjsReplication] Rejected key-rotation: malformed body', err)
      return { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false }
    }
    const body: KeyRotationBody = decoded.body

    // C1 (Sync 005 Z.230): authority snapshot from local state. An unknown space cannot
    // be authorized (no admin snapshot) → kein ack, Relay-Redelivery bis der
    // space-invite da ist. SPEC-APPROX members[0] (full Admin list in
    // 1.B.3-admin-management).
    const state = this.spaces.get(body.spaceId)
    if (!state) {
      return {
        kind: 'pending',
        durability: 'not-buffered',
        dependencies: [{ kind: 'missing-space-invite', docId: body.spaceId }],
      }
    }
    const knownAdminDids = [state.info.members[0]]

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
      console.warn('[YjsReplication] Rejected key-rotation:', result.reason, 'from', decoded.senderDid)
      return { kind: 'invalid-rejected', rejection: 'inner-verification-failed', authoritativeStateChanged: false }
    }
    if (result.decision === 'future-buffer') {
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
      console.warn('[YjsReplication] Ignored key-rotation:', result.decision, body.spaceId, body.generation)
      return { kind: 'applied', durable: true }
    }

    // applied: persist the content key to metadata (multi-device), then replay pending.
    if (this.metadataStorage) {
      const groupKey = (await this.keyManagement.getKeyByGeneration(body.spaceId, body.generation))!
      await this.metadataStorage.saveGroupKey({ spaceId: body.spaceId, generation: body.generation, key: groupKey })
    }
    await this.deletePendingSpaceMessage(body.spaceId, decoded.outerId)
    await this.processPendingForSpace(body.spaceId)
    return { kind: 'applied', durable: true }
  }

  /**
   * Handle sync request from another device: respond with full state for the requested space.
   */
  private async handleSpaceSyncRequest(envelope: MessageEnvelope): Promise<void> {
    try {
      const payload = JSON.parse(envelope.payload)
      const spaceId = payload.spaceId
      const state = this.spaces.get(spaceId)
      if (!state) return

      const groupKey = await this.keyManagement.getCurrentKey(spaceId)
      if (!groupKey) return

      const fullState = Y.encodeStateAsUpdate(state.doc)
      const generation = await this.keyManagement.getCurrentGeneration(spaceId)
      const myDid = this.identity.getDid()
      const encrypted = await encryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, plaintext: fullState })

      const responsePayload = {
        spaceId,
        generation,
        ciphertext: Array.from(encrypted.ciphertextTag),
        nonce: Array.from(encrypted.nonce),
      }
      const responseEnvelope: MessageEnvelope = {
        v: 1, id: crypto.randomUUID(), type: 'content',
        fromDid: myDid, toDid: myDid,
        createdAt: new Date().toISOString(), encoding: 'json',
        payload: JSON.stringify(responsePayload), signature: '',
      }
      const signed = await signEnvelope(responseEnvelope, (data) => this.identity.sign(data))
      this.sentMessageIds.add(signed.id)
      setTimeout(() => this.sentMessageIds.delete(signed.id), 30_000)
      try { await this.messaging.send(signed) } catch { /* offline */ }
    } catch (err) {
      console.debug('[YjsReplication] Failed to handle space-sync-request:', err)
    }
  }

  /**
   * Send a sync request for a specific space to own DID (multi-device).
   * Other devices that have this space will respond with their full state.
   */
  private async sendSpaceSyncRequest(spaceId: string): Promise<void> {
    const myDid = this.identity.getDid()
    const envelope: MessageEnvelope = {
      v: 1, id: crypto.randomUUID(), type: 'space-sync-request',
      fromDid: myDid, toDid: myDid,
      createdAt: new Date().toISOString(), encoding: 'json',
      payload: JSON.stringify({ spaceId }), signature: '',
    }
    const signed = await signEnvelope(envelope, (data) => this.identity.sign(data))
    this.sentMessageIds.add(signed.id)
    setTimeout(() => this.sentMessageIds.delete(signed.id), 30_000)
    try { await this.messaging.send(signed) } catch { /* offline */ }
  }

  private getDurablePendingStore(): DurablePendingStore | null {
    if (!this.compactStore) return null
    if (typeof this.compactStore.list !== 'function') return null
    if (typeof this.compactStore.delete !== 'function') return null
    return this.compactStore as DurablePendingStore
  }

  private pendingMessageStorageKey(spaceId: string, messageId: string): string {
    return `${YjsReplicationAdapter.PENDING_MESSAGE_PREFIX}${spaceId}:${messageId}`
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
      if (!key.startsWith(YjsReplicationAdapter.PENDING_MESSAGE_PREFIX)) continue
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
    const prefix = `${YjsReplicationAdapter.PENDING_MESSAGE_PREFIX}${spaceId}:`
    const keys = await store.list()
    await Promise.all(keys.filter((key) => key.startsWith(prefix)).map((key) => store.delete(key).catch(() => {})))
  }

  private async processPendingForSpace(spaceId: string): Promise<void> {
    if (this.processingPendingSpaces.has(spaceId)) return
    const pending = this.pendingMessages.get(spaceId)
    if (!pending || pending.length === 0) return

    this.processingPendingSpaces.add(spaceId)
    try {
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
    switch (message.envelope.type as string) {
      case 'content':
        await this.handleContentMessage(message.envelope)
        break
    }
  }

  // --- Persistence ---

  async _saveToCompactStore(state: YjsSpaceState): Promise<void> {
    if (!this.compactStore) return
    await traceAsync('crdt', 'write', `save compact ${state.info.id.slice(0, 8)}`, async () => {
      const binary = Y.encodeStateAsUpdate(state.doc)
      // Don't persist empty Y.Docs — they create ghost spaces that pollute
      // CompactStore and trigger repeated vault 404s on every restart
      if (binary.length <= 2) return binary
      await this.compactStore!.save(state.info.id, binary)
      return binary
    }, { spaceId: state.info.id })
  }

  async _pushSnapshotToVault(state: YjsSpaceState): Promise<void> {
    if (!this.vault) return
    const groupKey = await this.keyManagement.getCurrentKey(state.info.id)
    if (!groupKey) return

    await traceAsync('vault', 'write', `push snapshot ${state.info.id.slice(0, 8)}`, async () => {
      const docBinary = Y.encodeStateAsUpdate(state.doc)
      // Don't push empty docs to Vault
      if (docBinary.length <= 2) return docBinary
      const encrypted = await encryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, plaintext: docBinary })

      const currentSeq = this.vaultSeqs.get(state.info.id) ?? 0
      const nextSeq = currentSeq + 1
      await this.vault!.putSnapshot(state.info.id, encrypted.ciphertextTag, encrypted.nonce, nextSeq)
      this.vaultSeqs.set(state.info.id, nextSeq)
      // Doc now exists in Vault — clear any cached 404
      this.vault404Cache.delete(state.info.id)
      return docBinary
    }, { spaceId: state.info.id })
  }

  private ensureSchedulers(state: YjsSpaceState): void {
    const spaceId = state.info.id

    if (!this.compactSchedulers.has(spaceId)) {
      this.compactSchedulers.set(spaceId, new VaultPushScheduler({
        pushFn: () => this._saveToCompactStore(state),
        getHeadsFn: () => {
          const sv = Y.encodeStateVector(state.doc)
          return Array.from(sv).join(',')
        },
        debounceMs: 2000,
      }))
    }

    if (this.vault && !this.vaultSchedulers.has(spaceId)) {
      this.vaultSchedulers.set(spaceId, new VaultPushScheduler({
        pushFn: () => this._pushSnapshotToVault(state),
        getHeadsFn: () => {
          const sv = Y.encodeStateVector(state.doc)
          return Array.from(sv).join(',')
        },
        debounceMs: 5000,
      }))
    }
  }

  // Public for YjsSpaceHandle
  _scheduleCompactImmediate(state: YjsSpaceState): void {
    this.ensureSchedulers(state)
    this.compactSchedulers.get(state.info.id)?.pushImmediate()
  }
  _scheduleCompactDebounced(state: YjsSpaceState): void {
    this.ensureSchedulers(state)
    this.compactSchedulers.get(state.info.id)?.pushDebounced()
  }
  _scheduleVaultImmediate(state: YjsSpaceState): void {
    this.ensureSchedulers(state)
    this.vaultSchedulers.get(state.info.id)?.pushImmediate()
  }
  _scheduleVaultDebounced(state: YjsSpaceState): void {
    this.ensureSchedulers(state)
    this.vaultSchedulers.get(state.info.id)?.pushDebounced()
  }

  // --- Helpers ---

  /** Run async tasks with a concurrency limit */
  private async _runWithConcurrency<T>(
    items: T[],
    fn: (item: T) => Promise<void>,
    limit: number,
  ): Promise<void> {
    let i = 0
    const next = async (): Promise<void> => {
      while (i < items.length) {
        const item = items[i++]
        await fn(item)
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()))
  }

  private async sendMemberUpdate(spaceId: string, memberDid: string, action: 'added' | 'removed'): Promise<void> {
    const state = this.spaces.get(spaceId)
    if (!state) return
    const myDid = this.identity.getDid()
    const generation = await this.keyManagement.getCurrentGeneration(spaceId)

    // member-update ist eine Inbox-Nachricht: ECIES für den jeweiligen Empfänger
    // (Sync 003 Z.500 MUSS) — der Group-Key-OneShot-Pfad ist tot.
    const clearBody = { spaceId, memberDid, action, effectiveKeyGeneration: generation }

    for (const did of state.info.members) {
      if (did === myDid || did === memberDid) continue

      const encPub = state.memberEncryptionKeys.get(did)
      if (!encPub) {
        // Kein Klartext-Fallback (Sync 003 Z.500); Key-Discovery via Sync 004 folgt.
        console.warn('[YjsReplication] No encryption key for', did, '— skipping member-update delivery')
        continue
      }

      const envelope = await deliverInboxMessage({
        type: MEMBER_UPDATE_MESSAGE_TYPE,
        body: clearBody,
        from: myDid,
        to: did,
        recipientEncryptionPublicKey: encPub,
        sign: (input) => this.identity.signEd25519(input),
        crypto: this.crypto,
      })
      try { await this.messaging.send(envelope) } catch { /* offline */ }
    }
  }

  /** Cache of last-written metadata JSON per space — skip writes if unchanged */
  private lastSavedMetadata = new Map<string, string>()

  private async saveSpaceMetadata(state: YjsSpaceState): Promise<void> {
    if (!this.metadataStorage) return

    // Dirty-check: only write if metadata actually changed.
    // Without this, every requestSync → restoreSpaces → saveSpaceMetadata cycle
    // mutates PersonalDoc, which triggers Y.Doc update → personal-sync message → loop.
    const fingerprint = JSON.stringify({
      members: state.info.members,
      name: state.info.name,
      description: state.info.description,
      type: state.info.type,
      image: state.info.image,
      modules: state.info.modules,
      appTag: state.info.appTag,
      // #181 (b): include the actual key bytes, not just the DIDs — a rotated ECIES
      // pubkey for a known DID must change the fingerprint, else stale recipient keys persist.
      encKeys: Array.from(state.memberEncryptionKeys.entries())
        .sort(([didA], [didB]) => didA.localeCompare(didB))
        .map(([did, key]) => [did, encodeBase64Url(key)]),
    })
    if (this.lastSavedMetadata.get(state.info.id) === fingerprint) return
    this.lastSavedMetadata.set(state.info.id, fingerprint)

    await this.metadataStorage.saveSpaceMetadata({
      info: state.info,
      documentId: state.info.id,
      documentUrl: `yjs:${state.info.id}`,
      memberEncryptionKeys: Object.fromEntries(
        Array.from(state.memberEncryptionKeys.entries()).map(([did, key]) => [did, key])
      ),
    })
  }

  private notifySpaceListeners(): void {
    const spaces = Array.from(this.spaces.values()).map(s => s.info)
    for (const cb of this.spaceListeners) {
      try { cb(spaces) } catch (err) { console.error('[YjsReplication] Space listener error:', err) }
    }
  }
}
