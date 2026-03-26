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
} from '@web.of.trust/core'
import type { MessageEnvelope, SpaceInfo, SpaceDocMeta, SpaceMemberChange, ReplicationState } from '@web.of.trust/core'
import {
  GroupKeyService,
  EncryptedSyncService,
  VaultClient,
  VaultPushScheduler,
  base64ToUint8,
  signEnvelope,
  verifyEnvelope,
} from '@web.of.trust/core'
import type { SpaceMetadataStorage } from '@web.of.trust/core'

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
  vault?: VaultClient  // direct injection for testing
  spaceFilter?: (info: SpaceInfo) => boolean
  /** Flush PersonalDoc to Vault immediately (for key rotation safety) */
  flushPersonalDoc?: () => Promise<void>
  /** Pull PersonalDoc from Vault (for lazy key refresh) */
  refreshPersonalDocFromVault?: () => Promise<boolean>
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
  /** Cache 404 responses from Vault to avoid repeated requests for non-existent docs */
  private vault404Cache = new Map<string, number>() // spaceId → timestamp
  private static VAULT_404_TTL = 5 * 60_000 // 5 minutes
  private unsubMessage: (() => void) | null = null
  private unsubStateChange: (() => void) | null = null
  private started = false
  private sentMessageIds = new Set<string>()

  // Buffer for content messages that arrive before the space is known (multi-device timing)
  private pendingMessages = new Map<string, { envelope: MessageEnvelope; receivedAt: number }[]>()
  private static PENDING_TTL = 60_000 // 60s

  private flushPersonalDoc?: () => Promise<void>
  private refreshPersonalDocFromVault?: () => Promise<boolean>

  constructor(config: YjsReplicationConfig) {
    this.identity = config.identity
    this.messaging = config.messaging
    this.groupKeyService = config.groupKeyService
    this.metadataStorage = config.metadataStorage
    this.compactStore = config.compactStore
    this.spaceFilter = config.spaceFilter
    this.flushPersonalDoc = config.flushPersonalDoc
    this.refreshPersonalDocFromVault = config.refreshPersonalDocFromVault
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
        case 'space-sync-request':
          await this.handleSpaceSyncRequest(envelope)
          break
      }
    })

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

    // On reconnect: re-send full state + vault pull (without duplicate restoreSpacesFromMetadata)
    if ('onStateChange' in this.messaging && typeof (this.messaging as any).onStateChange === 'function') {
      this.unsubStateChange = (this.messaging as any).onStateChange((state: string) => {
        if (state === 'connected' && this.started) {
          void this._sendFullStateAllSpaces().catch(() => {})
          void this._pullAllFromVault().catch(() => {})
        }
      })
    }
  }

  async stop(): Promise<void> {
    this.unsubMessage?.()
    this.unsubMessage = null
    this.unsubStateChange?.()
    this.unsubStateChange = null
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
      // Set shared metadata in _meta map
      if (meta?.name || meta?.description || meta?.modules) {
        const metaMap = doc.getMap('_meta')
        if (meta.name) metaMap.set('name', meta.name)
        if (meta.description) metaMap.set('description', meta.description)
        if (meta.modules) metaMap.set('modules', meta.modules)
      }
    }, 'local')

    // Create group key
    await this.groupKeyService.createKey(spaceId)

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
      const groupKey = this.groupKeyService.getCurrentKey(spaceId)
      const generation = this.groupKeyService.getCurrentGeneration(spaceId)
      if (groupKey) {
        await this.metadataStorage.saveGroupKey({ spaceId, generation, key: groupKey })
      }
    }

    this.notifySpaceListeners()

    // Multi-device: send full doc state to own DID as content message.
    // Other devices that discover this space via PersonalDoc sync will receive
    // the full state and merge it into their (initially empty) Y.Doc.
    // We use 'content' type (not 'space-invite') to avoid triggering UI notifications.
    const groupKey = this.groupKeyService.getCurrentKey(spaceId)
    if (groupKey) {
      const myDid = this.identity.getDid()
      const docBinary = Y.encodeStateAsUpdate(doc)
      const generation = this.groupKeyService.getCurrentGeneration(spaceId)
      const encrypted = await EncryptedSyncService.encryptChange(
        docBinary, groupKey, spaceId, generation, myDid,
      )
      const payload = {
        spaceId,
        generation,
        ciphertext: Array.from(encrypted.ciphertext),
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

    // Send new key to all members (including own DID for multi-device)
    for (const [did, encPub] of state.memberEncryptionKeys) {
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
    // Encrypt with pre-rotation key (all parties still have it, including removed member)
    const preRotationGen = newGen - 1
    const preRotationKey = this.groupKeyService.getKeyByGeneration(spaceId, preRotationGen)
    const notifyDids = [...state.info.members, memberDid]
    const clearPayload = {
      spaceId,
      memberDid,
      action: 'removed' as const,
      members: state.info.members,
    }

    for (const did of notifyDids) {
      if (did === myDid) continue

      let payloadStr: string
      if (preRotationKey) {
        // Encrypt member-update payload with pre-rotation group key
        const plaintext = new TextEncoder().encode(JSON.stringify(clearPayload))
        const encrypted = await EncryptedSyncService.encryptChange(
          plaintext, preRotationKey, spaceId, preRotationGen, myDid,
        )
        payloadStr = JSON.stringify({
          encrypted: true,
          spaceId,
          generation: preRotationGen,
          ciphertext: Array.from(encrypted.ciphertext),
          nonce: Array.from(encrypted.nonce),
        })
      } else {
        // Fallback: first generation (gen 0), no pre-rotation key available
        payloadStr = JSON.stringify(clearPayload)
      }

      const envelope: MessageEnvelope = {
        v: 1, id: crypto.randomUUID(), type: 'member-update',
        fromDid: myDid, toDid: did,
        createdAt: new Date().toISOString(), encoding: 'json',
        payload: payloadStr, signature: '',
      }
      const signed = await signEnvelope(envelope, (data) => this.identity.sign(data))
      try { await this.messaging.send(signed) } catch { /* offline */ }
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

      // Process any pending content messages for known spaces
      // (messages may have been buffered between previous and current requestSync calls)
      for (const [spaceId, pending] of this.pendingMessages) {
        if (this.spaces.has(spaceId) && pending.length > 0) {
          this.pendingMessages.delete(spaceId)
          const now = Date.now()
          for (const { envelope, receivedAt } of pending) {
            if (now - receivedAt < YjsReplicationAdapter.PENDING_TTL) {
              await this.handleContentMessage(envelope).catch(() => {})
            }
          }
        }
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

    const groupKey = this.groupKeyService.getCurrentKey(state.info.id)
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

    const generation = this.groupKeyService.getCurrentGeneration(state.info.id)
    try {
      const decrypted = await EncryptedSyncService.decryptChange({
        ciphertext, nonce, spaceId: state.info.id, generation,
        fromDid: this.identity.getDid(),
      }, groupKey)

      Y.applyUpdate(state.doc, decrypted, 'remote')
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

  /** Reload group keys from metadata storage into the GroupKeyService */
  private async _reloadGroupKeys(spaceId: string): Promise<void> {
    if (!this.metadataStorage) return
    const keys = await this.metadataStorage.loadGroupKeys(spaceId)
    for (const k of keys) {
      this.groupKeyService.importKey(k.spaceId, k.key, k.generation)
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
      const groupKey = this.groupKeyService.getCurrentKey(spaceId)
      if (!groupKey) continue

      const fullState = Y.encodeStateAsUpdate(state.doc)
      // Don't broadcast empty docs
      if (fullState.length <= 2) continue
      const generation = this.groupKeyService.getCurrentGeneration(spaceId)
      const encrypted = await EncryptedSyncService.encryptChange(
        fullState, groupKey, spaceId, generation, myDid,
      )

      const payload = {
        spaceId,
        generation,
        ciphertext: Array.from(encrypted.ciphertext),
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
        this.groupKeyService.importKey(k.spaceId, k.key, k.generation)
      }

      // Try to restore from CompactStore
      let binary: Uint8Array | null = null
      if (this.compactStore) {
        binary = await this.compactStore.load(meta.info.id)
      }
      const isEmpty = !binary || binary.length <= 2
      const hasGroupKey = this.groupKeyService.getCurrentKey(meta.info.id) !== null
      const ageMs = meta.info.createdAt ? Date.now() - new Date(meta.info.createdAt).getTime() : 0

      // Ghost-space detection: no group key + empty doc + older than 10 minutes
      // A freshly joined space may temporarily have no key, so we give it time
      if (!hasGroupKey && isEmpty && ageMs > 10 * 60_000) {
        console.debug(`[YjsReplication] Removing ghost space ${meta.info.id} (no key, empty doc, age ${(ageMs / 60_000).toFixed(0)}min)`)
        await this.metadataStorage.deleteSpaceMetadata(meta.info.id)
        await this.metadataStorage.deleteGroupKeys(meta.info.id)
        if (this.compactStore && 'delete' in this.compactStore) {
          await (this.compactStore as any).delete(meta.info.id)
        }
        continue
      }

      // Create Y.Doc
      const doc = new Y.Doc()
      if (binary) {
        Y.applyUpdate(doc, binary)
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

      // Process any buffered content messages that arrived before this space was known
      const pending = this.pendingMessages.get(meta.info.id)
      if (pending) {
        this.pendingMessages.delete(meta.info.id)
        const now = Date.now()
        for (const { envelope, receivedAt } of pending) {
          if (now - receivedAt < YjsReplicationAdapter.PENDING_TTL) {
            await this.handleContentMessage(envelope).catch(() => {})
          }
        }
      }

      // Request full state from other devices (fire-and-forget, don't block restore)
      void this.sendSpaceSyncRequest(meta.info.id).catch(() => {})

      // Vault pull happens later in _pullAllFromVault() with concurrency limit
    }

    // Cleanup expired pending messages
    const now = Date.now()
    for (const [spaceId, msgs] of this.pendingMessages) {
      const valid = msgs.filter(m => now - m.receivedAt < YjsReplicationAdapter.PENDING_TTL)
      if (valid.length === 0) {
        this.pendingMessages.delete(spaceId)
      } else {
        this.pendingMessages.set(spaceId, valid)
      }
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

    // Send to all members (including own DID for multi-device sync)
    // sentMessageIds prevents the sending device from processing its own echo
    const state = this.spaces.get(spaceId)
    if (!state) return


    for (const memberDid of state.info.members) {
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
    }
  }

  private async handleContentMessage(envelope: MessageEnvelope): Promise<void> {
    try {
      const payload = JSON.parse(envelope.payload)
      const spaceId = payload.spaceId
      const state = this.spaces.get(spaceId)

      if (!state) {
        // Space not known yet — buffer message for when it's discovered
        // (multi-device: PersonalDoc sync may arrive after content messages)
        const pending = this.pendingMessages.get(spaceId) ?? []
        pending.push({ envelope, receivedAt: Date.now() })
        this.pendingMessages.set(spaceId, pending)
        return
      }

      const groupKey = this.groupKeyService.getKeyByGeneration(spaceId, payload.generation)
      if (!groupKey) {
        // Key not available yet — buffer message (key-rotation may arrive later)
        const pending = this.pendingMessages.get(spaceId) ?? []
        pending.push({ envelope, receivedAt: Date.now() })
        this.pendingMessages.set(spaceId, pending)
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

      // Decrypt group key
      const groupKey = await this.identity.decryptForMe({
        ciphertext: new Uint8Array(payload.encryptedGroupKey.ciphertext),
        nonce: new Uint8Array(payload.encryptedGroupKey.nonce),
        ephemeralPublicKey: new Uint8Array(payload.encryptedGroupKey.ephemeralPublicKey),
      })
      this.groupKeyService.importKey(spaceId, groupKey, payload.generation)

      // Decrypt doc snapshot
      const decrypted = await EncryptedSyncService.decryptChange({
        ciphertext: new Uint8Array(payload.encryptedDoc.ciphertext),
        nonce: new Uint8Array(payload.encryptedDoc.nonce),
        spaceId,
        generation: payload.generation,
        fromDid: envelope.fromDid,
      }, groupKey)

      // If space already exists (discovered via PersonalDoc sync), merge the snapshot
      // instead of ignoring it — the existing doc may be empty
      const existing = this.spaces.get(spaceId)
      if (existing) {
        Y.applyUpdate(existing.doc, decrypted, 'remote')
        this._scheduleCompactDebounced(existing)
        return
      }

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
      const metaImg = metaMap.get('image') as string | undefined
      if (metaName) info.name = metaName
      if (metaDesc) info.description = metaDesc
      if (metaImg) info.image = metaImg

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

      // Process any buffered content messages for this space
      const pending = this.pendingMessages.get(spaceId)
      if (pending) {
        this.pendingMessages.delete(spaceId)
        for (const { envelope: buffered, receivedAt } of pending) {
          if (Date.now() - receivedAt < YjsReplicationAdapter.PENDING_TTL) {
            await this.handleContentMessage(buffered).catch(() => {})
          }
        }
      }

      this.notifySpaceListeners()
    } catch (err) {
      console.debug('[YjsReplication] Failed to handle space invite:', err)
    }
  }

  private async handleMemberUpdate(envelope: MessageEnvelope): Promise<void> {
    try {
      let payload = JSON.parse(envelope.payload)

      // Decrypt if encrypted (post-Phase-4 messages)
      if (payload.encrypted && payload.ciphertext) {
        const groupKey = this.groupKeyService.getKeyByGeneration(payload.spaceId ?? '', payload.generation)
        if (groupKey) {
          const decrypted = await EncryptedSyncService.decryptChange({
            ciphertext: new Uint8Array(payload.ciphertext),
            nonce: new Uint8Array(payload.nonce),
            spaceId: payload.spaceId ?? '',
            generation: payload.generation,
            fromDid: envelope.fromDid,
          }, groupKey)
          payload = JSON.parse(new TextDecoder().decode(decrypted))
        } else {
          console.debug('[YjsReplication] Cannot decrypt member-update: no key for gen', payload.generation)
          return
        }
      }

      const state = this.spaces.get(payload.spaceId)
      if (!state) return

      // Authorization: any member can invite (added), only creator can remove
      if (payload.action === 'removed') {
        if (envelope.fromDid !== state.info.members[0]) {
          console.warn('[YjsReplication] Rejected member removal from non-creator:', envelope.fromDid)
          return
        }
      } else {
        if (!state.info.members.includes(envelope.fromDid)) {
          console.warn('[YjsReplication] Rejected member-update from non-member:', envelope.fromDid)
          return
        }
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

      // Process buffered content messages that were waiting for this key
      const pending = this.pendingMessages.get(payload.spaceId)
      if (pending && pending.length > 0) {
        this.pendingMessages.delete(payload.spaceId)
        for (const { envelope: buffered, receivedAt } of pending) {
          if (Date.now() - receivedAt < YjsReplicationAdapter.PENDING_TTL) {
            await this.handleContentMessage(buffered).catch(() => {})
          }
        }
      }
    } catch (err) {
      console.debug('[YjsReplication] Failed to handle group key rotation:', err)
    }
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

      const groupKey = this.groupKeyService.getCurrentKey(spaceId)
      if (!groupKey) return

      const fullState = Y.encodeStateAsUpdate(state.doc)
      const generation = this.groupKeyService.getCurrentGeneration(spaceId)
      const myDid = this.identity.getDid()
      const encrypted = await EncryptedSyncService.encryptChange(
        fullState, groupKey, spaceId, generation, myDid,
      )

      const responsePayload = {
        spaceId,
        generation,
        ciphertext: Array.from(encrypted.ciphertext),
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

  // --- Persistence ---

  async _saveToCompactStore(state: YjsSpaceState): Promise<void> {
    if (!this.compactStore) return
    const binary = Y.encodeStateAsUpdate(state.doc)
    // Don't persist empty Y.Docs — they create ghost spaces that pollute
    // CompactStore and trigger repeated vault 404s on every restart
    if (binary.length <= 2) return
    await this.compactStore.save(state.info.id, binary)
  }

  async _pushSnapshotToVault(state: YjsSpaceState): Promise<void> {
    if (!this.vault) return
    const groupKey = this.groupKeyService.getCurrentKey(state.info.id)
    if (!groupKey) return

    const docBinary = Y.encodeStateAsUpdate(state.doc)
    // Don't push empty docs to Vault
    if (docBinary.length <= 2) return
    const generation = this.groupKeyService.getCurrentGeneration(state.info.id)
    const encrypted = await EncryptedSyncService.encryptChange(
      docBinary, groupKey, state.info.id, generation, this.identity.getDid(),
    )

    const currentSeq = this.vaultSeqs.get(state.info.id) ?? 0
    const nextSeq = currentSeq + 1
    await this.vault.putSnapshot(state.info.id, encrypted.ciphertext, encrypted.nonce, nextSeq)
    this.vaultSeqs.set(state.info.id, nextSeq)
    // Doc now exists in Vault — clear any cached 404
    this.vault404Cache.delete(state.info.id)
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
    const groupKey = this.groupKeyService.getCurrentKey(spaceId)
    const generation = this.groupKeyService.getCurrentGeneration(spaceId)

    const clearPayload = { spaceId, memberDid, action }

    for (const did of state.info.members) {
      if (did === myDid || did === memberDid) continue

      let payloadStr: string
      if (groupKey) {
        const plaintext = new TextEncoder().encode(JSON.stringify(clearPayload))
        const encrypted = await EncryptedSyncService.encryptChange(
          plaintext, groupKey, spaceId, generation, myDid,
        )
        payloadStr = JSON.stringify({
          encrypted: true,
          spaceId,
          generation,
          ciphertext: Array.from(encrypted.ciphertext),
          nonce: Array.from(encrypted.nonce),
        })
      } else {
        payloadStr = JSON.stringify(clearPayload)
      }

      const envelope: MessageEnvelope = {
        v: 1, id: crypto.randomUUID(), type: 'member-update',
        fromDid: myDid, toDid: did,
        createdAt: new Date().toISOString(), encoding: 'json',
        payload: payloadStr, signature: '',
      }
      const signed = await signEnvelope(envelope, (data) => this.identity.sign(data))
      try { await this.messaging.send(signed) } catch { /* offline */ }
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
