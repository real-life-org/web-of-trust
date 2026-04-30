import { Repo, parseAutomergeUrl, type DocumentId, type AutomergeUrl, type PeerId } from '@automerge/automerge-repo'
import type { StorageAdapterInterface } from '@automerge/automerge-repo'
import type { DocHandle } from '@automerge/automerge-repo'
import * as Automerge from '@automerge/automerge'
import type { ReplicationAdapter, SpaceHandle, TransactOptions } from '@web_of_trust/core'
import type { Subscribable } from '@web_of_trust/core'
import type { MessagingAdapter } from '@web_of_trust/core'
import type { MessageEnvelope } from '@web_of_trust/core'
import type { SpaceInfo, SpaceMemberChange, ReplicationState } from '@web_of_trust/core'
import { GroupKeyService } from '@web_of_trust/core'
import { EncryptedSyncService } from '@web_of_trust/core'
import type { SpaceMetadataStorage } from '@web_of_trust/core'
import type { IdentitySession } from '@web_of_trust/core'
import { VaultClient, base64ToUint8 } from '@web_of_trust/core'
import { VaultPushScheduler } from '@web_of_trust/core'
import { signEnvelope, verifyEnvelope } from '@web_of_trust/core'
import { EncryptedMessagingNetworkAdapter } from './EncryptedMessagingNetworkAdapter'
import { CompactionService } from './CompactionService'

// Keep old import for backwards compatibility

interface SpaceState {
  info: SpaceInfo
  documentId: DocumentId
  documentUrl: AutomergeUrl
  handles: Set<AutomergeSpaceHandle<any>>
  memberEncryptionKeys: Map<string, Uint8Array>
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
  groupKeyService: GroupKeyService
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
  private groupKeyService: GroupKeyService
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
    this.groupKeyService = config.groupKeyService
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
      this.groupKeyService,
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
        this.groupKeyService.importKey(k.spaceId, k.key, k.generation)
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

    const groupKey = this.groupKeyService.getCurrentKey(spaceState.info.id)
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

        const generation = this.groupKeyService.getCurrentGeneration(spaceState.info.id)
        const docBinary = await EncryptedSyncService.decryptChange(
          { ciphertext, nonce, spaceId: spaceState.info.id, generation, fromDid: '' },
          groupKey,
        )

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

          const changeBinary = await EncryptedSyncService.decryptChange(
            { ciphertext: changeCiphertext, nonce: changeNonce, spaceId: spaceState.info.id, generation, fromDid: change.authorDid },
            groupKey,
          )

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
        const generation = this.groupKeyService.getCurrentGeneration(spaceState.info.id)

        // First change becomes the doc
        const firstPacked = base64ToUint8(vaultData.changes[0].data)
        const firstNonceLen = firstPacked[0]
        const firstNonce = firstPacked.slice(1, 1 + firstNonceLen)
        const firstCiphertext = firstPacked.slice(1 + firstNonceLen)

        const firstBinary = await EncryptedSyncService.decryptChange(
          { ciphertext: firstCiphertext, nonce: firstNonce, spaceId: spaceState.info.id, generation, fromDid: vaultData.changes[0].authorDid },
          groupKey,
        )

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

          const changeBinary = await EncryptedSyncService.decryptChange(
            { ciphertext: changeCiphertext, nonce: changeNonce, spaceId: spaceState.info.id, generation, fromDid: vaultData.changes[i].authorDid },
            groupKey,
          )

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

    const groupKey = this.groupKeyService.getCurrentKey(spaceState.info.id)
    if (!groupKey) return

    const docHandle = this.repo.handles[spaceState.documentId]
    const doc = docHandle?.doc()
    if (!doc) return

    // Save with history (fast), then compact in Worker before pushing to vault
    const withHistory = Automerge.save(doc)
    const compactionService = CompactionService.getInstance()
    const docBinary = await compactionService.compact(withHistory)

    const generation = this.groupKeyService.getCurrentGeneration(spaceState.info.id)
    const encrypted = await EncryptedSyncService.encryptChange(
      docBinary,
      groupKey,
      spaceState.info.id,
      generation,
      this.identity.getDid(),
    )

    // Use local seq counter (avoids getDocInfo HTTP call + browser 404 log on first push)
    const currentSeq = this.vaultSeqs.get(spaceState.info.id) ?? 0
    const nextSeq = currentSeq + 1

    await this.vault.putSnapshot(
      spaceState.info.id,
      encrypted.ciphertext,
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

    // Create group key for this space
    await this.groupKeyService.createKey(spaceId)

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

    // Add to members list
    if (!space.info.members.includes(memberDid)) {
      space.info.members.push(memberDid)
      this._notifySpacesSubscribers()
    }

    // Store encryption public key
    space.memberEncryptionKeys.set(memberDid, memberEncryptionPublicKey)

    // Register peer with NetworkAdapter for automerge-repo sync
    this.networkAdapter.registerSpacePeer(spaceId, memberDid)

    // Encrypt the current group key for the new member
    const groupKey = this.groupKeyService.getCurrentKey(spaceId)
    if (!groupKey) throw new Error(`No group key for space: ${spaceId}`)
    const generation = this.groupKeyService.getCurrentGeneration(spaceId)

    const encryptedKey = await this.identity.encryptForRecipient(
      groupKey,
      memberEncryptionPublicKey,
    )

    // Export current doc state as compact snapshot (no history) for the invite
    const docHandle = this.repo.handles[space.documentId]
    const doc = docHandle?.doc()
    if (!doc) throw new Error(`Cannot access doc for space: ${spaceId}`)
    const docBinary = Automerge.save(doc)

    const encryptedDoc = await EncryptedSyncService.encryptChange(
      docBinary,
      groupKey,
      spaceId,
      generation,
      this.identity.getDid(),
    )

    // Send space invite with encrypted group key + encrypted doc snapshot + documentUrl
    const invitePayload = {
      spaceId,
      spaceType: space.info.type,
      spaceName: space.info.name,
      appTag: space.info.appTag,
      members: space.info.members,
      createdAt: space.info.createdAt,
      generation,
      documentUrl: space.documentUrl,
      encryptedGroupKey: {
        ciphertext: Array.from(encryptedKey.ciphertext),
        nonce: Array.from(encryptedKey.nonce),
        ephemeralPublicKey: Array.from(encryptedKey.ephemeralPublicKey!),
      },
      encryptedDoc: {
        ciphertext: Array.from(encryptedDoc.ciphertext),
        nonce: Array.from(encryptedDoc.nonce),
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
      payload: JSON.stringify(invitePayload),
      signature: '',
    }

    await this._signAndSend(envelope)

    // Notify existing members about the new member (member-update)
    for (const existingDid of space.info.members) {
      if (existingDid === this.identity.getDid()) continue
      if (existingDid === memberDid) continue

      const updatePayload = {
        spaceId,
        action: 'added' as const,
        memberDid,
        members: space.info.members,
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

    // Rotate the group key (removed member can't decrypt new messages)
    const newKey = await this.groupKeyService.rotateKey(spaceId)
    const newGeneration = this.groupKeyService.getCurrentGeneration(spaceId)

    // Distribute new key to remaining members
    for (const [did, encPubKey] of space.memberEncryptionKeys.entries()) {
      if (did === this.identity.getDid()) continue

      const encryptedKey = await this.identity.encryptForRecipient(newKey, encPubKey)

      const rotationPayload = {
        spaceId,
        generation: newGeneration,
        encryptedGroupKey: {
          ciphertext: Array.from(encryptedKey.ciphertext),
          nonce: Array.from(encryptedKey.nonce),
          ephemeralPublicKey: Array.from(encryptedKey.ephemeralPublicKey!),
        },
      }

      const envelope: MessageEnvelope = {
        v: 1,
        id: crypto.randomUUID(),
        type: 'group-key-rotation',
        fromDid: this.identity.getDid(),
        toDid: did,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify(rotationPayload),
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
        members: space.info.members,
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

  getKeyGeneration(spaceId: string): number {
    return this.groupKeyService.getCurrentGeneration(spaceId)
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
    const generation = this.groupKeyService.getCurrentGeneration(space.info.id)
    for (let g = 0; g <= generation; g++) {
      const key = this.groupKeyService.getKeyByGeneration(space.info.id, g)
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
      case 'group-key-rotation':
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
    const payload = JSON.parse(envelope.payload)

    // Decrypt the group key
    const encryptedKey = {
      ciphertext: new Uint8Array(payload.encryptedGroupKey.ciphertext),
      nonce: new Uint8Array(payload.encryptedGroupKey.nonce),
      ephemeralPublicKey: new Uint8Array(payload.encryptedGroupKey.ephemeralPublicKey),
    }
    const groupKey = await this.identity.decryptForMe(encryptedKey)

    // Import the group key
    this.groupKeyService.importKey(payload.spaceId, groupKey, payload.generation)

    // Decrypt the doc snapshot
    const encryptedDoc = {
      ciphertext: new Uint8Array(payload.encryptedDoc.ciphertext),
      nonce: new Uint8Array(payload.encryptedDoc.nonce),
      spaceId: payload.spaceId,
      generation: payload.generation,
      fromDid: envelope.fromDid,
    }
    const docBinary = await EncryptedSyncService.decryptChange(encryptedDoc, groupKey)

    // Import the doc into automerge-repo with the SAME documentId as the sender
    // so automerge-repo can sync them via the NetworkAdapter
    const { documentId: senderDocId } = parseAutomergeUrl(payload.documentUrl as AutomergeUrl)
    const docHandle = this.repo.import<any>(docBinary, { docId: senderDocId })
    // Note: repo.import() with docId does NOT call doneLoading() (automerge-repo bug),
    // so whenReady() would timeout. The doc IS loaded though — call doneLoading() ourselves.
    if (!docHandle.isReady()) {
      docHandle.doneLoading()
    }

    // Register document -> space mapping
    this.networkAdapter.registerDocument(docHandle.documentId, payload.spaceId)

    // Register all members as peers
    const members: string[] = payload.members || []
    for (const memberDid of members) {
      if (memberDid !== this.identity.getDid()) {
        this.networkAdapter.registerSpacePeer(payload.spaceId, memberDid)
      }
    }
    // Register self-as-other-device for multi-device sync
    this.networkAdapter.registerSelfPeer(payload.spaceId)

    const info: SpaceInfo = {
      id: payload.spaceId,
      type: payload.spaceType,
      name: payload.spaceName,
      appTag: payload.appTag,
      members,
      createdAt: payload.createdAt,
    }

    const spaceState: SpaceState = {
      info,
      documentId: docHandle.documentId,
      documentUrl: docHandle.url,
      handles: new Set(),
      memberEncryptionKeys: new Map(),
    }
    this.spaces.set(payload.spaceId, spaceState)
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
      cb({ spaceId: payload.spaceId, did: this.identity.getDid(), action: 'added' })
    }
  }

  private async handleKeyRotation(envelope: MessageEnvelope): Promise<void> {
    const payload = JSON.parse(envelope.payload)

    // Sender must be a member of the space to distribute keys
    const space = this.spaces.get(payload.spaceId)
    if (space && !space.info.members.includes(envelope.fromDid)) {
      console.warn('[ReplicationAdapter] Rejected key-rotation from non-member:', envelope.fromDid)
      return
    }

    const encryptedKey = {
      ciphertext: new Uint8Array(payload.encryptedGroupKey.ciphertext),
      nonce: new Uint8Array(payload.encryptedGroupKey.nonce),
      ephemeralPublicKey: new Uint8Array(payload.encryptedGroupKey.ephemeralPublicKey),
    }
    const newKey = await this.identity.decryptForMe(encryptedKey)

    this.groupKeyService.importKey(payload.spaceId, newKey, payload.generation)

    if (space) {
      await this._persistSpaceMetadata(space)
    }
  }

  private async handleMemberUpdate(envelope: MessageEnvelope): Promise<void> {
    const payload = JSON.parse(envelope.payload)
    const space = this.spaces.get(payload.spaceId)
    if (!space) return

    // Authorization: any member can invite (added), only creator can remove
    if (payload.action === 'removed') {
      if (envelope.fromDid !== space.info.members[0]) {
        console.warn('[ReplicationAdapter] Rejected member removal from non-creator:', envelope.fromDid)
        return
      }
    } else {
      if (!space.info.members.includes(envelope.fromDid)) {
        console.warn('[ReplicationAdapter] Rejected member-update from non-member:', envelope.fromDid)
        return
      }
    }

    const myDid = this.identity.getDid()
    const wasRemoved = payload.action === 'removed' &&
      payload.memberDid === myDid &&
      !payload.members.includes(myDid)

    if (wasRemoved) {
      // I was removed from this space — clean up locally
      console.log('[ReplicationAdapter] Removed from space:', space.info.name || space.info.id)

      // Close all open handles
      for (const handle of space.handles) {
        handle.close()
      }

      // Unregister all peers for this space
      for (const did of space.info.members) {
        if (did !== myDid) {
          this.networkAdapter.unregisterSpacePeer(payload.spaceId, did)
        }
      }
      this.networkAdapter.unregisterDocument(space.documentId)

      // Remove from local state
      this.spaces.delete(payload.spaceId)

      // Remove persisted metadata
      if (this.metadataStorage) {
        await this.metadataStorage.deleteSpaceMetadata(payload.spaceId)
        await this.metadataStorage.deleteGroupKeys(payload.spaceId)
      }

      // Destroy vault scheduler if any
      const scheduler = this.vaultSchedulers.get(payload.spaceId)
      if (scheduler) {
        scheduler.destroy()
        this.vaultSchedulers.delete(payload.spaceId)
      }
      // Destroy compact store scheduler if any
      const compactSched = this.compactSchedulers.get(payload.spaceId)
      if (compactSched) {
        compactSched.destroy()
        this.compactSchedulers.delete(payload.spaceId)
      }
      // Delete compact store snapshot
      if (this.compactStore) {
        this.compactStore.delete(payload.spaceId).catch(() => {})
      }
      this.vaultSeqs.delete(payload.spaceId)

      // Notify UI
      this._notifySpacesSubscribers()
      for (const cb of this.memberChangeCallbacks) {
        cb({ spaceId: payload.spaceId, did: myDid, action: 'removed' })
      }
      return
    }

    const oldMembers = new Set(space.info.members)
    space.info.members = payload.members
    this._notifySpacesSubscribers()

    // Register/unregister peers based on member changes
    for (const did of payload.members) {
      if (did !== myDid && !oldMembers.has(did)) {
        this.networkAdapter.registerSpacePeer(payload.spaceId, did)
      }
    }
    for (const did of oldMembers) {
      if (!payload.members.includes(did)) {
        this.networkAdapter.unregisterSpacePeer(payload.spaceId, did)
      }
    }

    await this._persistSpaceMetadata(space)

    // Notify listeners about member changes
    for (const did of payload.members) {
      if (!oldMembers.has(did)) {
        for (const cb of this.memberChangeCallbacks) {
          cb({ spaceId: payload.spaceId, did, action: 'added' })
        }
      }
    }
    for (const did of oldMembers) {
      if (!payload.members.includes(did)) {
        for (const cb of this.memberChangeCallbacks) {
          cb({ spaceId: payload.spaceId, did, action: 'removed' })
        }
      }
    }
  }
}
