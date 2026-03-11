import { Repo, parseAutomergeUrl, type DocumentId, type AutomergeUrl, type PeerId } from '@automerge/automerge-repo'
import type { StorageAdapterInterface } from '@automerge/automerge-repo'
import type { DocHandle } from '@automerge/automerge-repo'
import type { ReplicationAdapter, SpaceHandle } from '../interfaces/ReplicationAdapter'
import type { Subscribable } from '../interfaces/Subscribable'
import type { MessagingAdapter } from '../interfaces/MessagingAdapter'
import type { MessageEnvelope } from '../../types/messaging'
import type { SpaceInfo, SpaceMemberChange, ReplicationState } from '../../types/space'
import { GroupKeyService } from '../../services/GroupKeyService'
import { EncryptedSyncService } from '../../services/EncryptedSyncService'
import type { SpaceMetadataStorage } from '../interfaces/SpaceMetadataStorage'
import type { WotIdentity } from '../../identity/WotIdentity'
import { EncryptedMessagingNetworkAdapter } from './EncryptedMessagingNetworkAdapter'

// Keep old import for backwards compatibility
import type { SpaceStorageAdapter } from '../interfaces/SpaceStorageAdapter'

interface SpaceState {
  info: SpaceInfo
  documentId: DocumentId
  documentUrl: AutomergeUrl
  handles: Set<AutomergeSpaceHandle<any>>
  memberEncryptionKeys: Map<string, Uint8Array>
}

export interface AutomergeReplicationAdapterConfig {
  identity: WotIdentity
  messaging: MessagingAdapter
  groupKeyService: GroupKeyService
  /** New: automerge-repo metadata storage (no docBinary) */
  metadataStorage?: SpaceMetadataStorage
  /** @deprecated Use metadataStorage instead */
  storage?: SpaceStorageAdapter
  /** Optional: automerge-repo StorageAdapter for doc persistence (e.g. IndexedDB) */
  repoStorage?: StorageAdapterInterface
}

class AutomergeSpaceHandle<T> implements SpaceHandle<T> {
  readonly id: string
  private spaceState: SpaceState
  private docHandle: DocHandle<T>
  private remoteUpdateCallbacks = new Set<() => void>()
  private closed = false
  private localChanging = false
  private unsubChange?: () => void

  constructor(spaceState: SpaceState, docHandle: DocHandle<T>) {
    this.id = spaceState.info.id
    this.spaceState = spaceState
    this.docHandle = docHandle

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

  transact(fn: (doc: T) => void): void {
    if (this.closed) throw new Error('Handle is closed')
    this.localChanging = true
    try {
      this.docHandle.change(fn as any)
    } finally {
      this.localChanging = false
    }
  }

  onRemoteUpdate(callback: () => void): () => void {
    this.remoteUpdateCallbacks.add(callback)
    return () => {
      this.remoteUpdateCallbacks.delete(callback)
    }
  }

  _notifyRemoteUpdate(): void {
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
  private identity: WotIdentity
  private messaging: MessagingAdapter
  private groupKeyService: GroupKeyService
  private metadataStorage: SpaceMetadataStorage | null
  private repoStorage: StorageAdapterInterface | undefined
  private spaces = new Map<string, SpaceState>()
  private state: ReplicationState = 'idle'
  private memberChangeCallbacks = new Set<(change: SpaceMemberChange) => void>()
  private spacesSubscribers = new Set<(value: SpaceInfo[]) => void>()
  private unsubscribeMessaging: (() => void) | null = null

  private repo!: Repo
  private networkAdapter!: EncryptedMessagingNetworkAdapter

  constructor(config: AutomergeReplicationAdapterConfig) {
    this.identity = config.identity
    this.messaging = config.messaging
    this.groupKeyService = config.groupKeyService
    this.metadataStorage = config.metadataStorage ?? null
    this.repoStorage = config.repoStorage
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
    if (this.metadataStorage) {
      const persisted = await this.metadataStorage.loadAllSpaceMetadata()
      for (const meta of persisted) {
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

        // Find the doc handle (triggers loading from storage)
        // Use AbortSignal timeout to avoid hanging on docs that were never persisted
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 5000)
          const handle = await this.repo.find(spaceState.documentUrl, {
            allowableStates: ['ready', 'unavailable'],
            signal: controller.signal,
          })
          clearTimeout(timer)
          if (!handle.isReady()) {
            console.warn('[ReplicationAdapter] Doc unavailable for space:', meta.info.name, '- removing stale entry')
            this.spaces.delete(meta.info.id)
            this.metadataStorage.deleteSpaceMetadata(meta.info.id)
            this.metadataStorage.deleteGroupKeys(meta.info.id)
            continue
          }
        } catch {
          console.warn('[ReplicationAdapter] Failed to load doc for space:', meta.info.name, '- removing stale entry')
          this.spaces.delete(meta.info.id)
          this.metadataStorage.deleteSpaceMetadata(meta.info.id)
          this.metadataStorage.deleteGroupKeys(meta.info.id)
          continue
        }

        // Restore group keys
        const keys = await this.metadataStorage.loadGroupKeys(meta.info.id)
        for (const k of keys) {
          this.groupKeyService.importKey(k.spaceId, k.key, k.generation)
        }
      }
    }

    this.state = 'idle'
    this._notifySpacesSubscribers()

    // Listen for application-level messages (invites, key rotation, member updates)
    this.unsubscribeMessaging = this.messaging.onMessage(
      (envelope) => this.handleMessage(envelope)
    )
  }

  async stop(): Promise<void> {
    if (this.unsubscribeMessaging) {
      this.unsubscribeMessaging()
      this.unsubscribeMessaging = null
    }
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

  async createSpace<T>(type: 'personal' | 'shared', initialDoc: T, meta?: { name?: string; description?: string }): Promise<SpaceInfo> {
    const spaceId = crypto.randomUUID()

    // Create doc in automerge-repo
    const docHandle = this.repo.create<T>(initialDoc)
    await docHandle.whenReady()

    // Create group key for this space
    await this.groupKeyService.createKey(spaceId)

    // Register document -> space mapping
    this.networkAdapter.registerDocument(docHandle.documentId, spaceId)

    const info: SpaceInfo = {
      id: spaceId,
      type,
      name: meta?.name,
      description: meta?.description,
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

    const docHandle = await this.repo.find<T>(space.documentUrl)
    await docHandle.whenReady()

    const handle = new AutomergeSpaceHandle<T>(space, docHandle)
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

    // Export current doc binary for the invite snapshot
    const docBinary = await this.repo.export(space.documentUrl)
    if (!docBinary) throw new Error(`Cannot export doc for space: ${spaceId}`)

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

    await this.messaging.send(envelope)

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

      await this.messaging.send(updateEnvelope)
    }

    await this._persistSpaceMetadata(space)

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

      await this.messaging.send(envelope)
    }

    // Notify remaining members about the removal (member-update)
    for (const existingDid of space.info.members) {
      if (existingDid === this.identity.getDid()) continue

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
        toDid: existingDid,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify(updatePayload),
        signature: '',
      }

      await this.messaging.send(updateEnvelope)
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

    const info: SpaceInfo = {
      id: payload.spaceId,
      type: payload.spaceType,
      name: payload.spaceName,
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

    // Notify listeners so UI updates when invited to a space
    for (const cb of this.memberChangeCallbacks) {
      cb({ spaceId: payload.spaceId, did: this.identity.getDid(), action: 'added' })
    }
  }

  private async handleKeyRotation(envelope: MessageEnvelope): Promise<void> {
    const payload = JSON.parse(envelope.payload)

    const encryptedKey = {
      ciphertext: new Uint8Array(payload.encryptedGroupKey.ciphertext),
      nonce: new Uint8Array(payload.encryptedGroupKey.nonce),
      ephemeralPublicKey: new Uint8Array(payload.encryptedGroupKey.ephemeralPublicKey),
    }
    const newKey = await this.identity.decryptForMe(encryptedKey)

    this.groupKeyService.importKey(payload.spaceId, newKey, payload.generation)

    const space = this.spaces.get(payload.spaceId)
    if (space) {
      await this._persistSpaceMetadata(space)
    }
  }

  private async handleMemberUpdate(envelope: MessageEnvelope): Promise<void> {
    const payload = JSON.parse(envelope.payload)
    const space = this.spaces.get(payload.spaceId)
    if (!space) return

    const oldMembers = new Set(space.info.members)
    space.info.members = payload.members
    this._notifySpacesSubscribers()

    // Register/unregister peers based on member changes
    for (const did of payload.members) {
      if (did !== this.identity.getDid() && !oldMembers.has(did)) {
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
