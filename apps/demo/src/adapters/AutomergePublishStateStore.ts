/**
 * PublishStateStore backed by LocalCacheStore (plain JSON in IndexedDB).
 *
 * Local-only state — NOT synced to other devices, NOT stored in PersonalDoc.
 * Tracks which data needs to be re-published to wot-profiles.
 */
import type { PublishStateStore, PublishStateField, Subscribable } from '@real-life/wot-core'
import type { LocalCacheStore } from './LocalCacheStore'

const STATE_KEY = 'publish-state'

export interface DirtyState {
  profile: boolean
  verifications: boolean
  attestations: boolean
}

interface StoredPublishState {
  [did: string]: {
    profileDirty: boolean
    verificationsDirty: boolean
    attestationsDirty: boolean
  }
}

export class AutomergePublishStateStore implements PublishStateStore {
  private did: string | null = null
  private store: LocalCacheStore
  // In-memory cache
  private state: StoredPublishState = {}
  private dirtyStateListeners = new Set<() => void>()

  constructor(store: LocalCacheStore) {
    this.store = store
  }

  /** Load state from IDB. Call once after LocalCacheStore.open(). */
  async load(): Promise<void> {
    this.state = await this.store.get<StoredPublishState>(STATE_KEY) ?? {}
  }

  /** Set the DID for watchDirtyState(). Called once during init. */
  setDid(did: string): void {
    this.did = did
  }

  async markDirty(did: string, field: PublishStateField): Promise<void> {
    if (!this.state[did]) {
      this.state[did] = { profileDirty: false, verificationsDirty: false, attestationsDirty: false }
    }
    const s = this.state[did]
    if (field === 'profile') s.profileDirty = true
    else if (field === 'verifications') s.verificationsDirty = true
    else if (field === 'attestations') s.attestationsDirty = true

    this.store.set(STATE_KEY, this.state).catch(() => {})
    this.notifyDirtyState()
  }

  async clearDirty(did: string, field: PublishStateField): Promise<void> {
    const s = this.state[did]
    if (!s) return
    if (field === 'profile') s.profileDirty = false
    else if (field === 'verifications') s.verificationsDirty = false
    else if (field === 'attestations') s.attestationsDirty = false

    this.store.set(STATE_KEY, this.state).catch(() => {})
    this.notifyDirtyState()
  }

  async getDirtyFields(did: string): Promise<Set<PublishStateField>> {
    const s = this.state[did]
    const result = new Set<PublishStateField>()
    if (!s) return result
    if (s.profileDirty) result.add('profile')
    if (s.verificationsDirty) result.add('verifications')
    if (s.attestationsDirty) result.add('attestations')
    return result
  }

  watchDirtyState(): Subscribable<DirtyState> {
    const self = this

    const getSnapshot = (): DirtyState => {
      if (!self.did) return { profile: false, verifications: false, attestations: false }
      const s = self.state[self.did]
      if (!s) return { profile: false, verifications: false, attestations: false }
      return {
        profile: s.profileDirty,
        verifications: s.verificationsDirty,
        attestations: s.attestationsDirty,
      }
    }

    return {
      subscribe: (callback) => {
        const wrappedCallback = () => callback(getSnapshot())
        self.dirtyStateListeners.add(wrappedCallback)
        return () => { self.dirtyStateListeners.delete(wrappedCallback) }
      },
      getValue: getSnapshot,
    }
  }

  private notifyDirtyState(): void {
    for (const listener of this.dirtyStateListeners) {
      try { listener() } catch { /* ignore */ }
    }
  }
}
