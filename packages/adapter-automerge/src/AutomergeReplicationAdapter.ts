import { Repo, parseAutomergeUrl, type DocumentId, type AutomergeUrl, type PeerId } from '@automerge/automerge-repo'
import type { StorageAdapterInterface } from '@automerge/automerge-repo'
import type { DocHandle } from '@automerge/automerge-repo'
import * as Automerge from '@automerge/automerge'
import type { ReplicationAdapter, SpaceHandle, TransactOptions, Subscribable, MessagingAdapter, SpaceMetadataStorage, KeyManagementPort, MemberUpdatePendingStore } from '@web_of_trust/core/ports'
import type { IdentitySession, MessageEnvelope, SpaceInfo, SpaceMemberChange, ReplicationState } from '@web_of_trust/core/types'
import {
  createSpaceKey, rotateSpaceKey, importKey, processMemberUpdate,
  buildSpaceInviteBody, applySpaceInviteBody, buildKeyRotationBody, applyKeyRotationBody,
} from '@web_of_trust/core/application'
import type { ProtocolCryptoAdapter, MemberUpdateSignal, MemberUpdateBody, SpaceInviteBody, KeyRotationBody } from '@web_of_trust/core/protocol'
import { decryptOneShot, encryptOneShot, assertMemberUpdateBody, assertSpaceInviteBody, assertKeyRotationBody } from '@web_of_trust/core/protocol'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { VaultClient, base64ToUint8, VaultPushScheduler, InMemoryKeyManagementAdapter, InMemoryMemberUpdatePendingStore } from '@web_of_trust/core/adapters'
import { signEnvelope, verifyEnvelope } from '@web_of_trust/core/crypto'
import { EncryptedMessagingNetworkAdapter } from './EncryptedMessagingNetworkAdapter'
import { CompactionService } from './CompactionService'

// Keep old import for backwards compatibility

interface SpaceState {
  info: SpaceInfo
  documentId: DocumentId
  documentUrl: AutomergeUrl
  handles: Set<AutomergeSpaceHandle<any>>
  memberEncryptionKeys: Map<string, Uint8Array>
  // In-memory pending member-update UX flags (Sync 005 Z.183-184). NOT canonical state.
  pendingRemoval?: { effectiveKeyGeneration: number }
  pendingAddition?: { effectiveKeyGeneration: number }
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

  private repo!: Repo
  private networkAdapter!: EncryptedMessagingNetworkAdapter

  constructor(config: AutomergeReplicationAdapterConfig) {
    this.identity = config.identity
    this.messaging = config.messaging
    this.keyManagement = config.keyManagement ?? new InMemoryKeyManagementAdapter()
    this.memberUpdateStore = config.memberUpdateStore ?? new InMemoryMemberUpdatePendingStore()
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

  /** Sign an envelope with our identity and send it */
  private async _signAndSend(envelope: MessageEnvelope): Promise<void> {
    await signEnvelope(envelope, (data) => this.identity.sign(data))
    await this.messaging.send(envelope)
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

    // Restore persisted space metadata and group keys
    await this.restoreSpacesFromMetadata()

    this.state = 'idle'
    this._notifySpacesSubscribers()

    // Listen for application-level messages (invites, key rotation, member updates)
    this.unsubscribeMessaging = this.messaging.onMessage(
      (envelope) => this.handleMessage(envelope)
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
      if (this.compactStore) {
        const restoredFromCompact = await this._restoreFromCompactStore(spaceState)
        if (restoredFromCompact) {
          changed = true
          console.log('[ReplicationAdapter] Restored space from CompactStore:', meta.info.name || meta.info.id)
          continue
        }
      }

      // Try vault second (avoids repo.find() putting doc in 'unavailable' state)
      if (this.vault) {
        const restoredFromVault = await this._restoreFromVault(spaceState)
        if (restoredFromVault) {
          changed = true
          console.log('[ReplicationAdapter] Restored space from vault:', meta.info.name || meta.info.id)
          continue
        }
      }

      // Find the doc handle (triggers loading from storage or sync from peers)
      // Use short timeout — if not locally available, _waitForDoc handles async sync
      let docReady = false
      try {
        const handle = await this.repo.find(spaceState.documentUrl, {
          allowableStates: ['ready', 'unavailable'],
          signal: AbortSignal.timeout(2000),
        })
        docReady = handle.isReady()
      } catch {
        // Timeout — doc not available yet
      }

      if (docReady) {
        changed = true
        console.log('[ReplicationAdapter] Restored space from metadata:', meta.info.name || meta.info.id)
      } else {
        // No vault, vault empty, and doc not locally available — wait for live sync
        console.log('[ReplicationAdapter] Space registered, waiting for doc sync:', meta.info.name || meta.info.id)
        changed = true
        this._waitForDoc(spaceState)
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
    // Close all handles
    for (const space of this.spaces.values()) {
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

  async createSpace<T>(type: 'personal' | 'shared', initialDoc: T, meta?: { name?: string; description?: string; appTag?: string }): Promise<SpaceInfo> {
    const spaceId = crypto.randomUUID()

    // Create doc in automerge-repo
    const docHandle = this.repo.create<T>(initialDoc)
    await docHandle.whenReady()

    // Create group key + capability key pair + owner self-capability
    await createSpaceKey({ crypto: this.crypto, keyPort: this.keyManagement, spaceId, ownerDid: this.identity.getDid() })

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
      appTag: meta?.appTag,
      members: [this.identity.getDid()],
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

    const previousMembers = [...space.info.members]

    // Add to members list
    if (!space.info.members.includes(memberDid)) {
      space.info.members.push(memberDid)
      this._notifySpacesSubscribers()
    }

    // Store encryption public key
    space.memberEncryptionKeys.set(memberDid, memberEncryptionPublicKey)

    // Register peer with NetworkAdapter for automerge-repo sync
    this.networkAdapter.registerSpacePeer(spaceId, memberDid)

    // C3 (Sync 005 Z.42): brokerUrls MUST be non-empty for a space-invite.
    if (this.brokerUrls.length === 0) {
      throw new Error('addMember/invite requires brokerUrls in AutomergeReplicationAdapterConfig (Sync 005 Z.42)')
    }

    // Spec-conformant invite body (Sync 005 Z.62-103): all content keys + capability +
    // signing key. SPEC-APPROX: adminDids = [members[0]] (full list in 1.B.3-admin-management).
    const inviteBody = await buildSpaceInviteBody({
      crypto: this.crypto,
      keyPort: this.keyManagement,
      spaceId,
      recipientDid: memberDid,
      brokerUrls: this.brokerUrls,
      adminDids: [space.info.members[0]],
      validityDurationMs: this.capabilityValidityMs,
    })

    // C6 (Sync 003 Z.500 / Z.450-456): ECIES-wrap the COMPLETE body for the recipient —
    // key material (content keys, signing key, capability) never travels plaintext in
    // MessageEnvelope.payload.
    const eciesBody = await this.identity.encryptForRecipient(
      new TextEncoder().encode(JSON.stringify(inviteBody)),
      memberEncryptionPublicKey,
    )

    // Demo-Extension (outside the spec body): the initial doc snapshot rides in the
    // container as encryptedDocSnapshot (OneShot under the current content key), NOT in
    // SpaceInviteBody. documentUrl is the automerge-repo doc id (not key material) — the
    // recipient imports under the same docId so automerge-repo can sync via the NetworkAdapter.
    // Display metadata travels inside the encrypted doc; appTag/createdAt are out of scope here.
    const groupKey = (await this.keyManagement.getKeyByGeneration(spaceId, inviteBody.currentKeyGeneration))!
    const docHandle = this.repo.handles[space.documentId]
    const doc = docHandle?.doc()
    if (!doc) throw new Error(`Cannot access doc for space: ${spaceId}`)
    const docBinary = Automerge.save(doc)
    const docSnapshot = await encryptOneShot({
      crypto: this.crypto,
      spaceContentKey: groupKey,
      plaintext: docBinary,
    })

    const container = {
      ecies: {
        ciphertext: Array.from(eciesBody.ciphertext),
        nonce: Array.from(eciesBody.nonce),
        ephemeralPublicKey: Array.from(eciesBody.ephemeralPublicKey!),
      },
      documentUrl: space.documentUrl,
      encryptedDocSnapshot: {
        ciphertext: Array.from(docSnapshot.ciphertextTag),
        nonce: Array.from(docSnapshot.nonce),
      },
    }

    const envelope: MessageEnvelope = {
      v: 1,
      id: crypto.randomUUID(),
      type: 'space-invite',
      fromDid: this.identity.getDid(),
      toDid: memberDid,
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: JSON.stringify(container),
      signature: '',
    }

    await this._signAndSend(envelope)

    // Without a members array in space-invite, tell the invited member about
    // members that were already present. The synced space doc remains canonical.
    for (const existingDid of previousMembers) {
      if (existingDid === this.identity.getDid()) continue
      if (existingDid === memberDid) continue

      const updatePayload = {
        spaceId,
        action: 'added' as const,
        memberDid: existingDid,
        effectiveKeyGeneration: await this.keyManagement.getCurrentGeneration(spaceId),
      }

      const updateEnvelope: MessageEnvelope = {
        v: 1,
        id: crypto.randomUUID(),
        type: 'member-update',
        fromDid: this.identity.getDid(),
        toDid: memberDid,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify(updatePayload),
        signature: '',
      }

      await this._signAndSend(updateEnvelope)
    }

    // Notify existing members about the new member (member-update)
    for (const existingDid of space.info.members) {
      if (existingDid === this.identity.getDid()) continue
      if (existingDid === memberDid) continue

      const updatePayload = {
        spaceId,
        action: 'added' as const,
        memberDid,
        effectiveKeyGeneration: await this.keyManagement.getCurrentGeneration(spaceId),
      }

      const updateEnvelope: MessageEnvelope = {
        v: 1,
        id: crypto.randomUUID(),
        type: 'member-update',
        fromDid: this.identity.getDid(),
        toDid: existingDid,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify(updatePayload),
        signature: '',
      }

      await this._signAndSend(updateEnvelope)
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

    // Remove from members
    space.info.members = space.info.members.filter(d => d !== memberDid)
    space.memberEncryptionKeys.delete(memberDid)
    this._notifySpacesSubscribers()

    // Unregister peer from NetworkAdapter
    this.networkAdapter.unregisterSpacePeer(spaceId, memberDid)

    // Rotate group key + fresh capability key pair + self-capability
    await rotateSpaceKey({ crypto: this.crypto, keyPort: this.keyManagement, spaceId, ownerDid: this.identity.getDid() })
    const newGeneration = await this.keyManagement.getCurrentGeneration(spaceId)

    // Distribute the rotated key + capability to the REMAINING members as spec-conformant
    // key-rotation (Sync 005 Z.230/Z.276). The removed member is NOT in memberEncryptionKeys
    // (deleted above), so it does not receive a key-rotation — it only receives a member-update
    // below (Sync 005 Z.238).
    for (const [did, encPubKey] of space.memberEncryptionKeys.entries()) {
      if (did === this.identity.getDid()) continue

      const rotationBody = await buildKeyRotationBody({
        crypto: this.crypto,
        keyPort: this.keyManagement,
        spaceId,
        newGeneration,
        recipientDid: did,
        validityDurationMs: this.capabilityValidityMs,
      })
      // C6: ECIES-wrap the complete body — content key + signing key + capability never plaintext.
      const ecies = await this.identity.encryptForRecipient(
        new TextEncoder().encode(JSON.stringify(rotationBody)),
        encPubKey,
      )

      const envelope: MessageEnvelope = {
        v: 1,
        id: crypto.randomUUID(),
        type: 'key-rotation',
        fromDid: this.identity.getDid(),
        toDid: did,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify({
          ecies: {
            ciphertext: Array.from(ecies.ciphertext),
            nonce: Array.from(ecies.nonce),
            ephemeralPublicKey: Array.from(ecies.ephemeralPublicKey!),
          },
        }),
        signature: '',
      }

      await this._signAndSend(envelope)
    }

    // Notify remaining members AND the removed member about the removal
    const notifyDids = [...space.info.members, memberDid]
    for (const did of notifyDids) {
      if (did === this.identity.getDid()) continue

      const updatePayload = {
        spaceId,
        action: 'removed' as const,
        memberDid,
        effectiveKeyGeneration: newGeneration,
      }

      const updateEnvelope: MessageEnvelope = {
        v: 1,
        id: crypto.randomUUID(),
        type: 'member-update',
        fromDid: this.identity.getDid(),
        toDid: did,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify(updatePayload),
        signature: '',
      }

      await this._signAndSend(updateEnvelope)
    }

    await this._persistSpaceMetadata(space)

    // Notify member change listeners
    for (const cb of this.memberChangeCallbacks) {
      cb({ spaceId, did: memberDid, action: 'removed' })
    }
  }

  onMemberChange(callback: (change: SpaceMemberChange) => void): () => void {
    this.memberChangeCallbacks.add(callback)
    return () => {
      this.memberChangeCallbacks.delete(callback)
    }
  }

  async leaveSpace(_spaceId: string): Promise<void> {
    throw new Error('leaveSpace not implemented for Automerge adapter')
  }

  async updateSpace(_spaceId: string, _meta: import('@web_of_trust/core').SpaceDocMeta): Promise<void> {
    throw new Error('updateSpace not implemented for Automerge adapter')
  }

  async getKeyGeneration(spaceId: string): Promise<number> {
    return this.keyManagement.getCurrentGeneration(spaceId)
  }

  async requestSync(_spaceId: string): Promise<void> {
    // No-op: automerge-repo handles sync automatically
  }

  async _persistSpaceMetadata(space: SpaceState): Promise<void> {
    if (!this.metadataStorage) return

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

  private async handleMessage(envelope: MessageEnvelope): Promise<void> {
    // Verify envelope signature — reject unsigned or forged messages
    if (envelope.signature) {
      const valid = await verifyEnvelope(envelope)
      if (!valid) {
        console.warn('[ReplicationAdapter] Rejected message with invalid signature from', envelope.fromDid)
        return
      }
    }

    switch (envelope.type) {
      case 'space-invite':
        await this.handleSpaceInvite(envelope)
        break
      case 'key-rotation':
        await this.handleKeyRotation(envelope)
        break
      case 'member-update':
        await this.handleMemberUpdate(envelope)
        break
      // content messages are handled by EncryptedMessagingNetworkAdapter
      // sync-request / sync-response are no longer needed (automerge-repo handles sync)
    }
  }

  private async handleSpaceInvite(envelope: MessageEnvelope): Promise<void> {
    try {
      const container = JSON.parse(envelope.payload)
      if (!container.ecies) return // spec-conformant invites carry the ECIES container (no Old-World read path)

      // C6: ECIES-decrypt the complete spec body, then validate + apply via the workflow.
      const decryptedBytes = await this.identity.decryptForMe({
        ciphertext: new Uint8Array(container.ecies.ciphertext),
        nonce: new Uint8Array(container.ecies.nonce),
        ephemeralPublicKey: new Uint8Array(container.ecies.ephemeralPublicKey),
      })
      const body: SpaceInviteBody = JSON.parse(new TextDecoder().decode(decryptedBytes))
      assertSpaceInviteBody(body)
      const spaceId = body.spaceId

      const result = await applySpaceInviteBody({
        crypto: this.crypto,
        keyPort: this.keyManagement,
        body,
        recipientDid: this.identity.getDid(),
        senderDid: envelope.fromDid,
      })
      if (result.decision === 'reject') {
        console.warn('[ReplicationAdapter] Rejected space-invite:', result.reason, 'from', envelope.fromDid)
        return
      }

      // Demo-Extension: decrypt the initial doc snapshot with the now-persisted content key —
      // OneShot invite snapshot (Sync 001 Z.103).
      const groupKey = (await this.keyManagement.getKeyByGeneration(spaceId, body.currentKeyGeneration))!
      const snap = container.encryptedDocSnapshot
      const inviteNonce = new Uint8Array(snap.nonce)
      const inviteCiphertext = new Uint8Array(snap.ciphertext)
      const inviteBlob = new Uint8Array(inviteNonce.length + inviteCiphertext.length)
      inviteBlob.set(inviteNonce, 0)
      inviteBlob.set(inviteCiphertext, inviteNonce.length)
      const docBinary = await decryptOneShot({ crypto: this.crypto, spaceContentKey: groupKey, blob: inviteBlob })

      // Import the doc into automerge-repo with the SAME documentId as the sender
      // so automerge-repo can sync them via the NetworkAdapter. documentUrl is the
      // automerge-repo doc id (not key material), carried in the container.
      const { documentId: senderDocId } = parseAutomergeUrl(container.documentUrl as AutomergeUrl)
      const docHandle = this.repo.import<any>(docBinary, { docId: senderDocId })
      // Note: repo.import() with docId does NOT call doneLoading() (automerge-repo bug),
      // so whenReady() would timeout. The doc IS loaded though — call doneLoading() ourselves.
      if (!docHandle.isReady()) {
        docHandle.doneLoading()
      }

      // Register document -> space mapping
      this.networkAdapter.registerDocument(docHandle.documentId, spaceId)

      // Display metadata travels inside the encrypted doc — SpaceInviteBody carries no
      // spaceInfo (Sync 005). Members come from the synced doc when available; invited
      // spaces are 'shared'; appTag/createdAt have no in-repo consumer here.
      const doc = docHandle.doc() as { members?: unknown; name?: unknown } | undefined
      const docMembers = Array.isArray(doc?.members) && doc.members.every(member => typeof member === 'string')
        ? doc.members as string[]
        : null
      const members = Array.from(new Set(docMembers ?? [envelope.fromDid, this.identity.getDid()]))

      // Register known peers; the synced space doc remains the authoritative members source.
      for (const memberDid of members) {
        if (memberDid !== this.identity.getDid()) {
          this.networkAdapter.registerSpacePeer(spaceId, memberDid)
        }
      }
      // Register self-as-other-device for multi-device sync
      this.networkAdapter.registerSelfPeer(spaceId)

      const info: SpaceInfo = {
        id: spaceId,
        type: 'shared',
        name: typeof doc?.name === 'string' ? doc.name : undefined,
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
      this._notifySpacesSubscribers()

      await this._persistSpaceMetadata(spaceState)
      // Flush repo so the doc is persisted to IndexedDB
      await this.repo.flush([docHandle.documentId])

      // Save to CompactStore (fire-and-forget)
      this._saveToCompactStore(spaceState).catch(() => {})

      // Push to vault for multi-device persistence (fire-and-forget)
      this._pushSnapshotToVault(spaceState).catch(() => {})

      // Notify listeners so UI updates when invited to a space
      for (const cb of this.memberChangeCallbacks) {
        cb({ spaceId, did: this.identity.getDid(), action: 'added' })
      }
    } catch (err) {
      console.debug('[ReplicationAdapter] Failed to handle space invite:', err)
    }
  }

  private async handleKeyRotation(envelope: MessageEnvelope): Promise<void> {
    try {
      const container = JSON.parse(envelope.payload)
      if (!container.ecies) return // spec-conformant rotations carry the ECIES container

      // C6: ECIES-decrypt the complete spec body.
      const decryptedBytes = await this.identity.decryptForMe({
        ciphertext: new Uint8Array(container.ecies.ciphertext),
        nonce: new Uint8Array(container.ecies.nonce),
        ephemeralPublicKey: new Uint8Array(container.ecies.ephemeralPublicKey),
      })
      const body: KeyRotationBody = JSON.parse(new TextDecoder().decode(decryptedBytes))
      assertKeyRotationBody(body)

      // C1 (Sync 005 Z.230): authority snapshot from local state. An unknown space cannot be
      // authorized (no admin snapshot) → drop. SPEC-APPROX members[0] (full Admin list in
      // 1.B.3-admin-management). SPEC-DEFERRED S1: senderDid = envelope.fromDid (Old-World).
      const space = this.spaces.get(body.spaceId)
      if (!space) return
      const knownAdminDids = [space.info.members[0]]

      const result = await applyKeyRotationBody({
        crypto: this.crypto,
        keyPort: this.keyManagement,
        body,
        recipientDid: this.identity.getDid(),
        senderDid: envelope.fromDid,
        knownAdminDids,
      })

      if (result.decision === 'reject') {
        console.warn('[ReplicationAdapter] Rejected key-rotation:', result.reason, 'from', envelope.fromDid)
        return
      }
      if (result.decision === 'future-buffer') {
        // No pending-message buffer in this adapter — drop and wait for re-delivery / catch-up.
        console.warn('[ReplicationAdapter] Buffered key-rotation dropped (no pending buffer):', body.spaceId, body.generation)
        return
      }
      if (result.decision !== 'apply') {
        console.warn('[ReplicationAdapter] Ignored key-rotation:', result.decision, body.spaceId, body.generation)
        return
      }

      // applied: persist all key generations to metadata (multi-device durability).
      await this._persistSpaceMetadata(space)
    } catch (err) {
      console.debug('[ReplicationAdapter] Failed to handle key rotation:', err)
    }
  }

  private async handleMemberUpdate(envelope: MessageEnvelope): Promise<void> {
    let rawBody: unknown
    try {
      rawBody = JSON.parse(envelope.payload)
    } catch (err) {
      console.warn('[ReplicationAdapter] Rejected member-update: invalid JSON', err)
      return
    }

    // K4: validate the clear protocol body before mapping to a signal.
    let body: MemberUpdateBody
    try {
      assertMemberUpdateBody(rawBody)
      body = rawBody
    } catch (err) {
      console.warn('[ReplicationAdapter] Rejected member-update: malformed body', err)
      return
    }

    const space = this.spaces.get(body.spaceId)
    if (!space) return

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
      signerDid: envelope.fromDid, // Wire-Layer Old-World: signer from envelope, not inner JWS
    }
    const result = await processMemberUpdate({
      signal,
      policy: {
        localKeyGeneration: await this.keyManagement.getCurrentGeneration(body.spaceId),
        knownAdminDids: [space.info.members[0]],
        knownMemberDids: space.info.members,
        seenUpdates: await this.memberUpdateStore.listSeenForSpace(body.spaceId),
      },
      store: this.memberUpdateStore,
      localDid: this.identity.getDid(),
    })

    // K3 (Sync 005 Z.183-184 + Z.191): member-update is a pending UX signal only.
    // NO spaces.delete, NO deleteSpaceMetadata, NO handle.close, NO peer (un)register,
    // NO member-list mutation — durable state survives. Canonical cleanup/registration
    // happens on confirmed Space-Sync (later slice).
    switch (result.localImpact) {
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

    if (result.triggerSpaceCatchUp) {
      this.requestSync(body.spaceId).catch((err) =>
        console.warn('[ReplicationAdapter] member-update sync-request failed', err))
    }
    // ACK-Wire ist W3 Adapter-Audit (inbox/1.0 + ack/1.0). Hier nur Logging.
    console.debug('[ReplicationAdapter] member-update disposition:', result.disposition)
  }
}
