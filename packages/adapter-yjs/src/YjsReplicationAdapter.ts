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
  WotIdentity,
} from '@real-life/wot-core'
import type { MessageEnvelope, SpaceInfo, SpaceDocMeta, SpaceMemberChange, ReplicationState } from '@real-life/wot-core'
import {
  GroupKeyService,
  EncryptedSyncService,
  VaultClient,
  VaultPushScheduler,
  signEnvelope,
  verifyEnvelope,
} from '@real-life/wot-core'
import type { SpaceMetadataStorage } from '@real-life/wot-core'

/** Duck-typed interface for CompactStorageManager / InMemoryCompactStore */
export interface YjsCompactStore {
  save(docId: string, data: Uint8Array): Promise<void>
  load(docId: string): Promise<Uint8Array | null>
}

interface YjsSpaceState {
  info: SpaceInfo
  doc: Y.Doc
  handles: Set<YjsSpaceHandle<any>>
  memberEncryptionKeys: Map<string, Uint8Array>
  unsubUpdate: (() => void) | null
}

interface YjsReplicationConfig {
  identity: WotIdentity
  messaging: MessagingAdapter
  groupKeyService: GroupKeyService
  metadataStorage?: SpaceMetadataStorage
  compactStore?: YjsCompactStore
  vaultUrl?: string
  spaceFilter?: (info: SpaceInfo) => boolean
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
  private identity: WotIdentity
  private messaging: MessagingAdapter
  private groupKeyService: GroupKeyService
  private metadataStorage?: SpaceMetadataStorage
  private compactStore?: YjsCompactStore
  private vault?: VaultClient
  private spaceFilter?: (info: SpaceInfo) => boolean

  private spaces = new Map<string, YjsSpaceState>()
  private spaceListeners = new Set<(spaces: SpaceInfo[]) => void>()
  private memberChangeListeners = new Set<(change: SpaceMemberChange) => void>()
  private vaultSchedulers = new Map<string, VaultPushScheduler>()
  private compactSchedulers = new Map<string, VaultPushScheduler>()
  private vaultSeqs = new Map<string, number>()
  private unsubMessage: (() => void) | null = null
  private started = false
  private sentMessageIds = new Set<string>()

  constructor(config: YjsReplicationConfig) {
    this.identity = config.identity
    this.messaging = config.messaging
    this.groupKeyService = config.groupKeyService
    this.metadataStorage = config.metadataStorage
    this.compactStore = config.compactStore
    this.spaceFilter = config.spaceFilter
    if (config.vaultUrl) {
      this.vault = new VaultClient(config.vaultUrl, config.identity)
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // Listen for incoming messages
    this.unsubMessage = this.messaging.onMessage(async (envelope) => {
      // Skip own echoes
      if (this.sentMessageIds.has(envelope.id)) {
        this.sentMessageIds.delete(envelope.id)
        return
      }

      // Verify envelope signature — reject unsigned or forged messages
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
        case 'space-invite':
          await this.handleSpaceInvite(envelope)
          break
        case 'member-update':
          await this.handleMemberUpdate(envelope)
          break
        case 'group-key-rotation':
          await this.handleGroupKeyRotation(envelope)
          break
      }
    })

    // Restore spaces from metadata
    await this.restoreSpacesFromMetadata()
  }

  async stop(): Promise<void> {
    this.unsubMessage?.()
    this.unsubMessage = null

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

  getState(): ReplicationState {
    return this.started ? 'syncing' : 'idle'
  }

  async createSpace<T>(type: SpaceInfo['type'], initialDoc: T, meta?: { name?: string; description?: string; appTag?: string }): Promise<SpaceInfo> {
    const spaceId = crypto.randomUUID()
    const now = new Date().toISOString()
    const myDid = this.identity.getDid()

    const info: SpaceInfo = {
      id: spaceId,
      type,
      name: meta?.name,
      description: meta?.description,
      appTag: meta?.appTag,
      members: [myDid],
      createdAt: now,
    }

    // Create Y.Doc
    const doc = new Y.Doc()
    doc.transact(() => {
      applyInitialDoc(doc, initialDoc as Record<string, any>)
      // Set shared metadata in _meta map
      if (meta?.name || meta?.description) {
        const metaMap = doc.getMap('_meta')
        if (meta.name) metaMap.set('name', meta.name)
        if (meta.description) metaMap.set('description', meta.description)
      }
    }, 'local')

    // Create group key
    await this.groupKeyService.createKey(spaceId)

    // Store state
    const state: YjsSpaceState = {
      info,
      doc,
      handles: new Set(),
      memberEncryptionKeys: new Map(),
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
      const groupKey = this.groupKeyService.getCurrentKey(spaceId)
      const generation = this.groupKeyService.getCurrentGeneration(spaceId)
      if (groupKey) {
        await this.metadataStorage.saveGroupKey({ spaceId, generation, key: groupKey })
      }
    }

    this.notifySpaceListeners()
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

    const myDid = this.identity.getDid()

    // Store member key
    state.memberEncryptionKeys.set(memberDid, memberEncryptionPublicKey)

    // Update members
    if (!state.info.members.includes(memberDid)) {
      state.info.members = [...state.info.members, memberDid]
    }

    // Get group key
    const groupKey = this.groupKeyService.getCurrentKey(spaceId)
    if (!groupKey) throw new Error(`No group key for space ${spaceId}`)
    const generation = this.groupKeyService.getCurrentGeneration(spaceId)

    // Encrypt group key with member's public key
    const encryptedKey = await this.identity.encryptForRecipient(groupKey, memberEncryptionPublicKey)

    // Serialize doc
    const docBinary = Y.encodeStateAsUpdate(state.doc)
    const encrypted = await EncryptedSyncService.encryptChange(docBinary, groupKey, spaceId, generation, myDid)

    // Send invite
    const payload = {
      spaceId,
      spaceInfo: state.info,
      documentUrl: `yjs:${spaceId}`,
      encryptedGroupKey: {
        ciphertext: Array.from(encryptedKey.ciphertext),
        nonce: Array.from(encryptedKey.nonce),
        ephemeralPublicKey: Array.from(encryptedKey.ephemeralPublicKey!),
      },
      generation,
      encryptedDoc: {
        ciphertext: Array.from(encrypted.ciphertext),
        nonce: Array.from(encrypted.nonce),
      },
    }

    const envelope: MessageEnvelope = {
      v: 1,
      id: crypto.randomUUID(),
      type: 'space-invite',
      fromDid: myDid,
      toDid: memberDid,
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: JSON.stringify(payload),
      signature: '',
    }

    const signed = await signEnvelope(envelope, (data) => this.identity.sign(data))
    this.sentMessageIds.add(signed.id)
    setTimeout(() => this.sentMessageIds.delete(signed.id), 30_000)
    await this.messaging.send(signed)

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
    state.memberEncryptionKeys.delete(memberDid)
    state.info.members = state.info.members.filter(d => d !== memberDid)

    // Rotate group key
    await this.groupKeyService.rotateKey(spaceId)
    const newKey = this.groupKeyService.getCurrentKey(spaceId)!
    const newGen = this.groupKeyService.getCurrentGeneration(spaceId)

    // Send new key to remaining members
    for (const [did, encPub] of state.memberEncryptionKeys) {
      if (did === this.identity.getDid()) continue
      const encryptedKey = await this.identity.encryptForRecipient(newKey, encPub)
      const payload = {
        spaceId,
        encryptedGroupKey: {
          ciphertext: Array.from(encryptedKey.ciphertext),
          nonce: Array.from(encryptedKey.nonce),
          ephemeralPublicKey: Array.from(encryptedKey.ephemeralPublicKey!),
        },
        generation: newGen,
      }
      const envelope: MessageEnvelope = {
        v: 1, id: crypto.randomUUID(), type: 'group-key-rotation',
        fromDid: this.identity.getDid(), toDid: did,
        createdAt: new Date().toISOString(), encoding: 'json',
        payload: JSON.stringify(payload), signature: '',
      }
      const signed = await signEnvelope(envelope, (data) => this.identity.sign(data))
      this.sentMessageIds.add(signed.id)
      setTimeout(() => this.sentMessageIds.delete(signed.id), 30_000)
      await this.messaging.send(signed)
    }

    // Notify remaining members AND the removed member
    const notifyDids = [...state.info.members, memberDid]
    const payload = {
      spaceId,
      memberDid,
      action: 'removed' as const,
      members: state.info.members,
    }
    for (const did of notifyDids) {
      if (did === myDid) continue
      const envelope: MessageEnvelope = {
        v: 1, id: crypto.randomUUID(), type: 'member-update',
        fromDid: myDid, toDid: did,
        createdAt: new Date().toISOString(), encoding: 'json',
        payload: JSON.stringify(payload), signature: '',
      }
      try { await this.messaging.send(envelope) } catch { /* offline */ }
    }

    await this.saveSpaceMetadata(state)

    for (const cb of this.memberChangeListeners) {
      cb({ spaceId, did: memberDid, action: 'removed' })
    }
    this.notifySpaceListeners()
  }

  onMemberChange(callback: (change: SpaceMemberChange) => void): () => void {
    this.memberChangeListeners.add(callback)
    return () => { this.memberChangeListeners.delete(callback) }
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

    // Remove from persistent storage
    if (this.metadataStorage) {
      await this.metadataStorage.deleteSpaceMetadata(spaceId)
      await this.metadataStorage.deleteGroupKeys(spaceId)
    }
    if (this.compactStore && 'delete' in this.compactStore) {
      await (this.compactStore as any).delete(spaceId)
    }

    this.notifySpaceListeners()
  }

  async requestSync(_spaceId: string): Promise<void> {
    // No-op for now — sync happens automatically via update events
  }

  getKeyGeneration(spaceId: string): number {
    return this.groupKeyService.getCurrentGeneration(spaceId)
  }

  async updateSpace(spaceId: string, meta: SpaceDocMeta): Promise<void> {
    const state = this.spaces.get(spaceId)
    if (!state) throw new Error(`Space ${spaceId} not found`)

    state.doc.transact(() => {
      const metaMap = state.doc.getMap('_meta')
      if (meta.name !== undefined) metaMap.set('name', meta.name)
      if (meta.description !== undefined) metaMap.set('description', meta.description)
      if (meta.image !== undefined) metaMap.set('image', meta.image)
    }, 'local')

    // Persistence
    this._scheduleCompactImmediate(state)
    this._scheduleVaultImmediate(state)
  }

  // --- Restore from metadata ---

  async restoreSpacesFromMetadata(): Promise<void> {
    if (!this.metadataStorage) return

    const allMeta = await this.metadataStorage.loadAllSpaceMetadata()
    for (const meta of allMeta) {
      if (this.spaces.has(meta.info.id)) continue
      if (this.spaceFilter && !this.spaceFilter(meta.info)) continue

      // Restore group keys
      const keys = await this.metadataStorage.loadGroupKeys(meta.info.id)
      for (const k of keys) {
        this.groupKeyService.importKey(k.spaceId, k.key, k.generation)
      }

      // Create Y.Doc
      const doc = new Y.Doc()

      // Try to restore from CompactStore
      if (this.compactStore) {
        const binary = await this.compactStore.load(meta.info.id)
        if (binary) {
          Y.applyUpdate(doc, binary)
        }
      }

      // Read _meta from Y.Doc (overrides PersonalDoc values)
      const metaMap = doc.getMap('_meta')
      const metaName = metaMap.get('name') as string | undefined
      const metaDesc = metaMap.get('description') as string | undefined
      if (metaName !== undefined) meta.info.name = metaName
      if (metaDesc !== undefined) meta.info.description = metaDesc

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
      let changed = false
      if (name !== undefined && name !== state.info.name) {
        state.info = { ...state.info, name }
        changed = true
      }
      if (desc !== undefined && desc !== state.info.description) {
        state.info = { ...state.info, description: desc }
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
    const groupKey = this.groupKeyService.getCurrentKey(spaceId)
    if (!groupKey) return

    const generation = this.groupKeyService.getCurrentGeneration(spaceId)
    const myDid = this.identity.getDid()

    const encrypted = await EncryptedSyncService.encryptChange(update, groupKey, spaceId, generation, myDid)

    const payload = {
      spaceId,
      generation,
      ciphertext: Array.from(encrypted.ciphertext),
      nonce: Array.from(encrypted.nonce),
    }

    // Send to all members
    const state = this.spaces.get(spaceId)
    if (!state) return

    for (const memberDid of state.info.members) {
      if (memberDid === myDid) continue
      const envelope: MessageEnvelope = {
        v: 1, id: crypto.randomUUID(), type: 'content',
        fromDid: myDid, toDid: memberDid,
        createdAt: new Date().toISOString(), encoding: 'json',
        payload: JSON.stringify(payload), signature: '',
      }
      this.sentMessageIds.add(envelope.id)
      setTimeout(() => this.sentMessageIds.delete(envelope.id), 30_000)
      try { await this.messaging.send(envelope) } catch { /* offline */ }
    }
  }

  private async handleContentMessage(envelope: MessageEnvelope): Promise<void> {
    try {
      const payload = JSON.parse(envelope.payload)
      const spaceId = payload.spaceId
      const state = this.spaces.get(spaceId)
      if (!state) return

      const groupKey = this.groupKeyService.getKeyByGeneration(spaceId, payload.generation)
      if (!groupKey) {
        console.debug(`[YjsReplication] No group key for space ${spaceId} gen ${payload.generation}`)
        return
      }

      const decrypted = await EncryptedSyncService.decryptChange({
        ciphertext: new Uint8Array(payload.ciphertext),
        nonce: new Uint8Array(payload.nonce),
        spaceId,
        generation: payload.generation,
        fromDid: envelope.fromDid,
      }, groupKey)

      Y.applyUpdate(state.doc, decrypted, 'remote')

      // Persist
      this._scheduleCompactDebounced(state)
    } catch (err) {
      console.debug('[YjsReplication] Failed to handle content message:', err)
    }
  }

  private async handleSpaceInvite(envelope: MessageEnvelope): Promise<void> {
    try {
      const payload = JSON.parse(envelope.payload)
      const spaceId = payload.spaceId
      if (this.spaces.has(spaceId)) return

      // Decrypt group key
      const groupKey = await this.identity.decryptForMe({
        ciphertext: new Uint8Array(payload.encryptedGroupKey.ciphertext),
        nonce: new Uint8Array(payload.encryptedGroupKey.nonce),
        ephemeralPublicKey: new Uint8Array(payload.encryptedGroupKey.ephemeralPublicKey),
      })
      this.groupKeyService.importKey(spaceId, groupKey, payload.generation)

      // Decrypt doc
      const decrypted = await EncryptedSyncService.decryptChange({
        ciphertext: new Uint8Array(payload.encryptedDoc.ciphertext),
        nonce: new Uint8Array(payload.encryptedDoc.nonce),
        spaceId,
        generation: payload.generation,
        fromDid: envelope.fromDid,
      }, groupKey)

      // Create Y.Doc from decrypted binary
      const doc = new Y.Doc()
      Y.applyUpdate(doc, decrypted, 'remote')

      const info: SpaceInfo = payload.spaceInfo || {
        id: spaceId,
        type: 'shared',
        members: [envelope.fromDid, this.identity.getDid()],
        createdAt: new Date().toISOString(),
      }

      if (!info.members.includes(this.identity.getDid())) {
        info.members = [...info.members, this.identity.getDid()]
      }

      // Read _meta from received Y.Doc
      const metaMap = doc.getMap('_meta')
      const metaName = metaMap.get('name') as string | undefined
      const metaDesc = metaMap.get('description') as string | undefined
      if (metaName) info.name = metaName
      if (metaDesc) info.description = metaDesc

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

      // Save group key to metadata
      if (this.metadataStorage) {
        await this.metadataStorage.saveGroupKey({
          spaceId,
          generation: payload.generation,
          key: groupKey,
        })
      }

      this.notifySpaceListeners()
    } catch (err) {
      console.debug('[YjsReplication] Failed to handle space invite:', err)
    }
  }

  private async handleMemberUpdate(envelope: MessageEnvelope): Promise<void> {
    try {
      const payload = JSON.parse(envelope.payload)
      const state = this.spaces.get(payload.spaceId)
      if (!state) return

      // Sender must be the space creator (first member) to modify membership
      if (envelope.fromDid !== state.info.members[0]) {
        console.warn('[YjsReplication] Rejected member-update from non-creator:', envelope.fromDid)
        return
      }

      const myDid = this.identity.getDid()

      // Check if I was removed
      const wasRemoved = payload.action === 'removed' &&
        payload.memberDid === myDid &&
        payload.members && !payload.members.includes(myDid)

      if (wasRemoved) {
        // I was removed — clean up locally
        for (const handle of state.handles) handle.close()
        state.unsubUpdate?.()
        state.doc.destroy()
        this.spaces.delete(payload.spaceId)
        this.compactSchedulers.get(payload.spaceId)?.destroy()
        this.compactSchedulers.delete(payload.spaceId)
        this.vaultSchedulers.get(payload.spaceId)?.destroy()
        this.vaultSchedulers.delete(payload.spaceId)

        if (this.metadataStorage) {
          await this.metadataStorage.deleteSpaceMetadata(payload.spaceId)
          await this.metadataStorage.deleteGroupKeys(payload.spaceId)
        }
      } else if (payload.action === 'added' && !state.info.members.includes(payload.memberDid)) {
        state.info.members = [...state.info.members, payload.memberDid]
        await this.saveSpaceMetadata(state)
      } else if (payload.action === 'removed') {
        state.info.members = state.info.members.filter((d: string) => d !== payload.memberDid)
        await this.saveSpaceMetadata(state)
      }

      for (const cb of this.memberChangeListeners) {
        cb({ spaceId: payload.spaceId, did: payload.memberDid, action: payload.action })
      }
      this.notifySpaceListeners()
    } catch (err) {
      console.debug('[YjsReplication] Failed to handle member update:', err)
    }
  }

  private async handleGroupKeyRotation(envelope: MessageEnvelope): Promise<void> {
    try {
      const payload = JSON.parse(envelope.payload)
      const groupKey = await this.identity.decryptForMe({
        ciphertext: new Uint8Array(payload.encryptedGroupKey.ciphertext),
        nonce: new Uint8Array(payload.encryptedGroupKey.nonce),
        ephemeralPublicKey: new Uint8Array(payload.encryptedGroupKey.ephemeralPublicKey),
      })
      this.groupKeyService.importKey(payload.spaceId, groupKey, payload.generation)

      if (this.metadataStorage) {
        await this.metadataStorage.saveGroupKey({
          spaceId: payload.spaceId,
          generation: payload.generation,
          key: groupKey,
        })
      }
    } catch (err) {
      console.debug('[YjsReplication] Failed to handle group key rotation:', err)
    }
  }

  // --- Persistence ---

  async _saveToCompactStore(state: YjsSpaceState): Promise<void> {
    if (!this.compactStore) return
    const binary = Y.encodeStateAsUpdate(state.doc)
    await this.compactStore.save(state.info.id, binary)
  }

  async _pushSnapshotToVault(state: YjsSpaceState): Promise<void> {
    if (!this.vault) return
    const groupKey = this.groupKeyService.getCurrentKey(state.info.id)
    if (!groupKey) return

    const docBinary = Y.encodeStateAsUpdate(state.doc)
    const generation = this.groupKeyService.getCurrentGeneration(state.info.id)
    const encrypted = await EncryptedSyncService.encryptChange(
      docBinary, groupKey, state.info.id, generation, this.identity.getDid(),
    )

    const currentSeq = this.vaultSeqs.get(state.info.id) ?? 0
    const nextSeq = currentSeq + 1
    await this.vault.putSnapshot(state.info.id, encrypted.ciphertext, encrypted.nonce, nextSeq)
    this.vaultSeqs.set(state.info.id, nextSeq)
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

  private async sendMemberUpdate(spaceId: string, memberDid: string, action: 'added' | 'removed'): Promise<void> {
    const state = this.spaces.get(spaceId)
    if (!state) return
    const myDid = this.identity.getDid()

    const payload = { spaceId, memberDid, action }
    for (const did of state.info.members) {
      if (did === myDid || did === memberDid) continue
      const envelope: MessageEnvelope = {
        v: 1, id: crypto.randomUUID(), type: 'member-update',
        fromDid: myDid, toDid: did,
        createdAt: new Date().toISOString(), encoding: 'json',
        payload: JSON.stringify(payload), signature: '',
      }
      try { await this.messaging.send(envelope) } catch { /* offline */ }
    }
  }

  private async saveSpaceMetadata(state: YjsSpaceState): Promise<void> {
    if (!this.metadataStorage) return
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
