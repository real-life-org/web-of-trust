import * as Automerge from '@automerge/automerge'
import type { ReplicationAdapter, SpaceHandle } from '../interfaces/ReplicationAdapter'
import type { MessagingAdapter } from '../interfaces/MessagingAdapter'
import type { MessageEnvelope } from '../../types/messaging'
import type { SpaceInfo, SpaceMemberChange, ReplicationState } from '../../types/space'
import { GroupKeyService } from '../../services/GroupKeyService'
import { EncryptedSyncService } from '../../services/EncryptedSyncService'
import type { SpaceStorageAdapter } from '../interfaces/SpaceStorageAdapter'
import type { WotIdentity } from '../../identity/WotIdentity'

interface SpaceState {
  info: SpaceInfo
  doc: Automerge.Doc<any>
  handles: Set<AutomergeSpaceHandle<any>>
  /** Encryption public keys per member DID (for re-keying on invite) */
  memberEncryptionKeys: Map<string, Uint8Array>
}

export interface AutomergeReplicationAdapterConfig {
  identity: WotIdentity
  messaging: MessagingAdapter
  groupKeyService: GroupKeyService
  storage?: SpaceStorageAdapter
}

class AutomergeSpaceHandle<T> implements SpaceHandle<T> {
  readonly id: string
  private spaceState: SpaceState
  private adapter: AutomergeReplicationAdapter
  private remoteUpdateCallbacks = new Set<() => void>()
  private closed = false

  constructor(spaceState: SpaceState, adapter: AutomergeReplicationAdapter) {
    this.id = spaceState.info.id
    this.spaceState = spaceState
    this.adapter = adapter
  }

  info(): SpaceInfo {
    return { ...this.spaceState.info }
  }

  getDoc(): T {
    return this.spaceState.doc as T
  }

  transact(fn: (doc: T) => void): void {
    if (this.closed) throw new Error('Handle is closed')

    const before = this.spaceState.doc
    const after = Automerge.change(before, (d: any) => fn(d as T))
    this.spaceState.doc = after

    // Get binary changes and broadcast (fire-and-forget, errors handled internally)
    const changes = Automerge.getChanges(before, after)
    if (changes.length > 0) {
      this.adapter._broadcastChanges(this.spaceState, changes)
        .then(() => this.adapter._persistSpace(this.spaceState))
        .catch(() => {})
    }
  }

  onRemoteUpdate(callback: () => void): () => void {
    this.remoteUpdateCallbacks.add(callback)
    return () => {
      this.remoteUpdateCallbacks.delete(callback)
    }
  }

  /** Called by adapter when remote changes are applied */
  _notifyRemoteUpdate(): void {
    for (const cb of this.remoteUpdateCallbacks) {
      cb()
    }
  }

  close(): void {
    this.closed = true
    this.remoteUpdateCallbacks.clear()
    this.spaceState.handles.delete(this)
  }
}

export class AutomergeReplicationAdapter implements ReplicationAdapter {
  private identity: WotIdentity
  private messaging: MessagingAdapter
  private groupKeyService: GroupKeyService
  private storage: SpaceStorageAdapter | null
  private spaces = new Map<string, SpaceState>()
  private state: ReplicationState = 'idle'
  private memberChangeCallbacks = new Set<(change: SpaceMemberChange) => void>()
  private unsubscribeMessaging: (() => void) | null = null

  constructor(config: AutomergeReplicationAdapterConfig) {
    this.identity = config.identity
    this.messaging = config.messaging
    this.groupKeyService = config.groupKeyService
    this.storage = config.storage ?? null
  }

  async start(): Promise<void> {
    // Restore persisted spaces and keys
    if (this.storage) {
      const persisted = await this.storage.loadAllSpaces()
      for (const ps of persisted) {
        const doc = Automerge.load(ps.docBinary)
        const memberKeys = new Map<string, Uint8Array>()
        for (const [did, key] of Object.entries(ps.memberEncryptionKeys)) {
          memberKeys.set(did, key)
        }
        this.spaces.set(ps.info.id, {
          info: ps.info,
          doc,
          handles: new Set(),
          memberEncryptionKeys: memberKeys,
        })

        // Restore group keys
        const keys = await this.storage.loadGroupKeys(ps.info.id)
        for (const k of keys) {
          this.groupKeyService.importKey(k.spaceId, k.key, k.generation)
        }
      }
    }

    this.state = 'idle'
    // Listen for incoming messages
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
    this.state = 'idle'
  }

  getState(): ReplicationState {
    return this.state
  }

  async createSpace<T>(type: 'personal' | 'shared', initialDoc: T, meta?: { name?: string; description?: string }): Promise<SpaceInfo> {
    const spaceId = crypto.randomUUID()

    // Create Automerge doc with initial state
    const doc = Automerge.from(initialDoc as any)

    // Create group key for this space
    await this.groupKeyService.createKey(spaceId)

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
      doc,
      handles: new Set(),
      memberEncryptionKeys: new Map(),
    }
    this.spaces.set(spaceId, spaceState)

    await this._persistSpace(spaceState)

    return { ...info }
  }

  async getSpaces(): Promise<SpaceInfo[]> {
    return Array.from(this.spaces.values()).map(s => ({ ...s.info }))
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

    const handle = new AutomergeSpaceHandle<T>(space, this)
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
    }

    // Store encryption public key
    space.memberEncryptionKeys.set(memberDid, memberEncryptionPublicKey)

    // Encrypt the current group key for the new member
    const groupKey = this.groupKeyService.getCurrentKey(spaceId)
    if (!groupKey) throw new Error(`No group key for space: ${spaceId}`)
    const generation = this.groupKeyService.getCurrentGeneration(spaceId)

    // Encrypt group key + current doc state for the new member
    const encryptedKey = await this.identity.encryptForRecipient(
      groupKey,
      memberEncryptionPublicKey,
    )

    // Serialize the current doc for the new member
    const docBinary = Automerge.save(space.doc)
    const encryptedDoc = await EncryptedSyncService.encryptChange(
      docBinary,
      groupKey,
      spaceId,
      generation,
      this.identity.getDid(),
    )

    // Send space invite with encrypted group key + encrypted doc snapshot
    const invitePayload = {
      spaceId,
      spaceType: space.info.type,
      members: space.info.members,
      createdAt: space.info.createdAt,
      generation,
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
      signature: '', // Simplified for POC
    }

    await this.messaging.send(envelope)

    // Notify existing members about the new member (member-update)
    for (const existingDid of space.info.members) {
      if (existingDid === this.identity.getDid()) continue // skip self
      if (existingDid === memberDid) continue // skip the new member (they got the invite)

      const updatePayload = {
        spaceId,
        action: 'added' as const,
        memberDid,
        members: space.info.members,
      }

      const envelope: MessageEnvelope = {
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

      await this.messaging.send(envelope)
    }

    await this._persistSpace(space)

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

    // Rotate the group key (removed member can't decrypt new messages)
    const newKey = await this.groupKeyService.rotateKey(spaceId)
    const newGeneration = this.groupKeyService.getCurrentGeneration(spaceId)

    // Distribute new key to remaining members
    for (const [did, encPubKey] of space.memberEncryptionKeys.entries()) {
      if (did === this.identity.getDid()) continue // skip self

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

    await this._persistSpace(space)

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

  /**
   * Request a full doc sync from another member of a space.
   * Sends sync-request to the first other member found.
   */
  async requestSync(spaceId: string): Promise<void> {
    const space = this.spaces.get(spaceId)
    if (!space) throw new Error(`Unknown space: ${spaceId}`)

    // Find another member to request from
    const targetDid = space.info.members.find(d => d !== this.identity.getDid())
    if (!targetDid) return // No other members

    const envelope: MessageEnvelope = {
      v: 1,
      id: crypto.randomUUID(),
      type: 'sync-request',
      fromDid: this.identity.getDid(),
      toDid: targetDid,
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: JSON.stringify({ spaceId }),
      signature: '',
    }

    await this.messaging.send(envelope)
  }

  /**
   * Internal: persist a space and its group keys to storage.
   */
  async _persistSpace(space: SpaceState): Promise<void> {
    if (!this.storage) return

    const memberEncryptionKeys: Record<string, Uint8Array> = {}
    for (const [did, key] of space.memberEncryptionKeys.entries()) {
      memberEncryptionKeys[did] = key
    }

    await this.storage.saveSpace({
      info: space.info,
      docBinary: Automerge.save(space.doc),
      memberEncryptionKeys,
    })

    // Persist all group key generations
    const generation = this.groupKeyService.getCurrentGeneration(space.info.id)
    for (let g = 0; g <= generation; g++) {
      const key = this.groupKeyService.getKeyByGeneration(space.info.id, g)
      if (key && key.length > 0) {
        await this.storage.saveGroupKey({ spaceId: space.info.id, generation: g, key })
      }
    }
  }

  /**
   * Internal: broadcast encrypted changes to all members.
   * Called by SpaceHandle after transact().
   */
  async _broadcastChanges(space: SpaceState, changes: Uint8Array[]): Promise<void> {
    const groupKey = this.groupKeyService.getCurrentKey(space.info.id)
    if (!groupKey) return

    const generation = this.groupKeyService.getCurrentGeneration(space.info.id)

    // Concatenate all changes into a single binary
    const totalLen = changes.reduce((sum, c) => sum + c.length, 0)
    const combined = new Uint8Array(totalLen)
    let offset = 0
    for (const change of changes) {
      combined.set(change, offset)
      offset += change.length
    }

    // Encrypt
    const encrypted = await EncryptedSyncService.encryptChange(
      combined,
      groupKey,
      space.info.id,
      generation,
      this.identity.getDid(),
    )

    // Serialize for transport
    const contentPayload = {
      spaceId: space.info.id,
      generation: encrypted.generation,
      fromDid: encrypted.fromDid,
      ciphertext: Array.from(encrypted.ciphertext),
      nonce: Array.from(encrypted.nonce),
      // Include individual change lengths for deserialization
      changeLengths: changes.map(c => c.length),
    }

    // Send to each member (except self)
    for (const memberDid of space.info.members) {
      if (memberDid === this.identity.getDid()) continue

      const envelope: MessageEnvelope = {
        v: 1,
        id: crypto.randomUUID(),
        type: 'content',
        fromDid: this.identity.getDid(),
        toDid: memberDid,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify(contentPayload),
        signature: '',
      }

      await this.messaging.send(envelope)
    }
  }

  private async handleMessage(envelope: MessageEnvelope): Promise<void> {
    switch (envelope.type) {
      case 'space-invite':
        await this.handleSpaceInvite(envelope)
        break
      case 'content':
        await this.handleContentMessage(envelope)
        break
      case 'group-key-rotation':
        await this.handleKeyRotation(envelope)
        break
      case 'member-update':
        await this.handleMemberUpdate(envelope)
        break
      case 'sync-request':
        await this.handleSyncRequest(envelope)
        break
      case 'sync-response':
        await this.handleSyncResponse(envelope)
        break
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

    // Load the Automerge doc
    const doc = Automerge.load(docBinary)

    const info: SpaceInfo = {
      id: payload.spaceId,
      type: payload.spaceType,
      members: payload.members,
      createdAt: payload.createdAt,
    }

    const spaceState: SpaceState = {
      info,
      doc,
      handles: new Set(),
      memberEncryptionKeys: new Map(),
    }
    this.spaces.set(payload.spaceId, spaceState)

    await this._persistSpace(spaceState)
  }

  private async handleContentMessage(envelope: MessageEnvelope): Promise<void> {
    const payload = JSON.parse(envelope.payload)
    const space = this.spaces.get(payload.spaceId)
    if (!space) return // Unknown space, ignore

    const groupKey = this.groupKeyService.getKeyByGeneration(
      payload.spaceId,
      payload.generation,
    )
    if (!groupKey) return // Can't decrypt (e.g. was removed before key rotation)

    // Decrypt
    const encrypted = {
      ciphertext: new Uint8Array(payload.ciphertext),
      nonce: new Uint8Array(payload.nonce),
      spaceId: payload.spaceId,
      generation: payload.generation,
      fromDid: payload.fromDid,
    }
    const decrypted = await EncryptedSyncService.decryptChange(encrypted, groupKey)

    // Split back into individual changes
    const changeLengths: number[] = payload.changeLengths
    const changes: Uint8Array[] = []
    let offset = 0
    for (const len of changeLengths) {
      changes.push(decrypted.slice(offset, offset + len))
      offset += len
    }

    // Apply to Automerge doc
    const [newDoc] = Automerge.applyChanges(space.doc, changes)
    space.doc = newDoc

    // Notify all handles
    for (const handle of space.handles) {
      handle._notifyRemoteUpdate()
    }

    await this._persistSpace(space)
  }

  private async handleKeyRotation(envelope: MessageEnvelope): Promise<void> {
    const payload = JSON.parse(envelope.payload)

    // Decrypt the new group key
    const encryptedKey = {
      ciphertext: new Uint8Array(payload.encryptedGroupKey.ciphertext),
      nonce: new Uint8Array(payload.encryptedGroupKey.nonce),
      ephemeralPublicKey: new Uint8Array(payload.encryptedGroupKey.ephemeralPublicKey),
    }
    const newKey = await this.identity.decryptForMe(encryptedKey)

    // Import the rotated key
    this.groupKeyService.importKey(payload.spaceId, newKey, payload.generation)

    // Persist the new key
    const space = this.spaces.get(payload.spaceId)
    if (space) {
      await this._persistSpace(space)
    }
  }

  private async handleMemberUpdate(envelope: MessageEnvelope): Promise<void> {
    const payload = JSON.parse(envelope.payload)
    const space = this.spaces.get(payload.spaceId)
    if (!space) return

    // Update the local member list to the authoritative list from the space owner
    space.info.members = payload.members

    await this._persistSpace(space)
  }

  private async handleSyncRequest(envelope: MessageEnvelope): Promise<void> {
    const payload = JSON.parse(envelope.payload)
    const space = this.spaces.get(payload.spaceId)
    if (!space) return

    const groupKey = this.groupKeyService.getCurrentKey(space.info.id)
    if (!groupKey) return

    const generation = this.groupKeyService.getCurrentGeneration(space.info.id)

    // Encrypt current doc snapshot
    const docBinary = Automerge.save(space.doc)
    const encryptedDoc = await EncryptedSyncService.encryptChange(
      docBinary,
      groupKey,
      space.info.id,
      generation,
      this.identity.getDid(),
    )

    const responsePayload = {
      spaceId: space.info.id,
      generation,
      members: space.info.members,
      encryptedDoc: {
        ciphertext: Array.from(encryptedDoc.ciphertext),
        nonce: Array.from(encryptedDoc.nonce),
      },
    }

    const responseEnvelope: MessageEnvelope = {
      v: 1,
      id: crypto.randomUUID(),
      type: 'sync-response',
      fromDid: this.identity.getDid(),
      toDid: envelope.fromDid,
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: JSON.stringify(responsePayload),
      signature: '',
    }

    await this.messaging.send(responseEnvelope)
  }

  private async handleSyncResponse(envelope: MessageEnvelope): Promise<void> {
    const payload = JSON.parse(envelope.payload)
    const space = this.spaces.get(payload.spaceId)
    if (!space) return

    const groupKey = this.groupKeyService.getKeyByGeneration(
      payload.spaceId,
      payload.generation,
    )
    if (!groupKey) return

    // Decrypt the doc snapshot
    const encryptedDoc = {
      ciphertext: new Uint8Array(payload.encryptedDoc.ciphertext),
      nonce: new Uint8Array(payload.encryptedDoc.nonce),
      spaceId: payload.spaceId,
      generation: payload.generation,
      fromDid: envelope.fromDid,
    }
    const docBinary = await EncryptedSyncService.decryptChange(encryptedDoc, groupKey)

    // Merge remote doc with local doc
    const remoteDoc = Automerge.load<any>(docBinary)
    try {
      space.doc = Automerge.merge(space.doc, remoteDoc)
    } catch {
      // If merge fails (incompatible histories), replace with remote doc
      space.doc = remoteDoc
    }

    // Update member list
    space.info.members = payload.members

    // Notify all handles
    for (const handle of space.handles) {
      handle._notifyRemoteUpdate()
    }

    await this._persistSpace(space)
  }
}
