import type { SpaceInfo, SpaceDocMeta, SpaceMemberChange, ReplicationState } from '../../types/space'
import type { Subscribable } from './Subscribable'

/**
 * Options for SpaceHandle.transact().
 */
export interface TransactOptions {
  /** Use debounced vault push instead of immediate. For streaming input (e.g. text editing). */
  stream?: boolean
}

/**
 * SpaceHandle — typed access to a CRDT space.
 *
 * Wraps the underlying CRDT doc (e.g. Automerge) and provides
 * transactional writes + remote update notifications.
 */
export interface SpaceHandle<T = unknown> {
  readonly id: string
  info(): SpaceInfo

  /** Get the current document state (read-only snapshot). */
  getDoc(): T

  /** Get space metadata from the shared _meta map. */
  getMeta(): SpaceDocMeta

  /** Apply a transactional change to the doc. Encrypts + broadcasts to members. */
  transact(fn: (doc: T) => void, options?: TransactOptions): void

  /** Fires when remote changes arrive and are applied. */
  onRemoteUpdate(callback: () => void): () => void

  /** Close this handle (unsubscribe from updates). */
  close(): void
}

/**
 * ReplicationAdapter — CRDT Sync for Multi-Device and Multi-User Spaces.
 *
 * Manages Automerge docs, encrypts changes with group keys,
 * and distributes via MessagingAdapter.
 */
export interface ReplicationAdapter {
  // Lifecycle
  start(): Promise<void>
  stop(): Promise<void>
  getState(): ReplicationState

  // Space Management
  createSpace<T>(type: 'personal' | 'shared', initialDoc: T, meta?: { name?: string; description?: string; appTag?: string }): Promise<SpaceInfo>
  updateSpace(spaceId: string, meta: SpaceDocMeta): Promise<void>
  getSpaces(): Promise<SpaceInfo[]>
  getSpace(spaceId: string): Promise<SpaceInfo | null>
  watchSpaces(): Subscribable<SpaceInfo[]>

  // Space Access
  openSpace<T>(spaceId: string): Promise<SpaceHandle<T>>

  // Membership
  addMember(spaceId: string, memberDid: string, memberEncryptionPublicKey: Uint8Array): Promise<void>
  removeMember(spaceId: string, memberDid: string): Promise<void>
  leaveSpace(spaceId: string): Promise<void>
  onMemberChange(callback: (change: SpaceMemberChange) => void): () => void

  // Sync
  requestSync(spaceId: string): Promise<void>

  // Key info (for testing/debugging)
  getKeyGeneration(spaceId: string): number
}
