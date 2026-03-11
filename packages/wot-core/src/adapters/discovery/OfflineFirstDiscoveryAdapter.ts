import type { PublicProfile } from '../../types/identity'
import type { Verification } from '../../types/verification'
import type { Attestation } from '../../types/attestation'
import type { WotIdentity } from '../../identity/WotIdentity'
import type {
  DiscoveryAdapter,
  ProfileResolveResult,
  PublicVerificationsData,
  PublicAttestationsData,
  ProfileSummary,
} from '../interfaces/DiscoveryAdapter'
import type { PublishStateStore } from '../interfaces/PublishStateStore'
import type { GraphCacheStore } from '../interfaces/GraphCacheStore'

/**
 * Offline-first wrapper for any DiscoveryAdapter.
 *
 * Decorator pattern: wraps an inner DiscoveryAdapter and adds:
 * - Dirty-flag tracking for publish operations (via PublishStateStore)
 * - Profile/verification/attestation caching for resolve operations (via GraphCacheStore)
 * - syncPending() method for retry on reconnect
 *
 * The wrapper is optional — adapters that are natively offline-capable
 * (e.g. Automerge-based) don't need it.
 *
 * Usage:
 *   const http = new HttpDiscoveryAdapter(url)
 *   const publishState = new EvoluPublishStateStore(evolu, did)
 *   const graphCache = new EvoluGraphCacheStore(evolu)
 *   const discovery = new OfflineFirstDiscoveryAdapter(http, publishState, graphCache)
 */
export class OfflineFirstDiscoveryAdapter implements DiscoveryAdapter {
  private _lastError: string | null = null
  private _errorListeners: Array<(error: string | null) => void> = []

  constructor(
    private inner: DiscoveryAdapter,
    private publishState: PublishStateStore,
    private graphCache: GraphCacheStore,
  ) {}

  /** Last publish error message (null if last attempt succeeded) */
  get lastError(): string | null { return this._lastError }

  /** Subscribe to error state changes */
  onErrorChange(listener: (error: string | null) => void): () => void {
    this._errorListeners.push(listener)
    return () => { this._errorListeners = this._errorListeners.filter(l => l !== listener) }
  }

  private setError(e: unknown) {
    this._lastError = e instanceof Error ? e.message : String(e)
    console.warn('[Discovery] Publish failed:', this._lastError)
    this._errorListeners.forEach(l => l(this._lastError))
  }

  private clearError() {
    if (this._lastError !== null) {
      this._lastError = null
      this._errorListeners.forEach(l => l(null))
    }
  }

  async publishProfile(data: PublicProfile, identity: WotIdentity): Promise<void> {
    await this.publishState.markDirty(data.did, 'profile')
    try {
      await this.inner.publishProfile(data, identity)
      await this.publishState.clearDirty(data.did, 'profile')
      this.clearError()
    } catch (e) {
      this.setError(e)
    }
  }

  async publishVerifications(data: PublicVerificationsData, identity: WotIdentity): Promise<void> {
    await this.publishState.markDirty(data.did, 'verifications')
    try {
      await this.inner.publishVerifications(data, identity)
      await this.publishState.clearDirty(data.did, 'verifications')
      this.clearError()
    } catch (e) {
      this.setError(e)
    }
  }

  async publishAttestations(data: PublicAttestationsData, identity: WotIdentity): Promise<void> {
    await this.publishState.markDirty(data.did, 'attestations')
    try {
      await this.inner.publishAttestations(data, identity)
      await this.publishState.clearDirty(data.did, 'attestations')
      this.clearError()
    } catch (e) {
      this.setError(e)
    }
  }

  async resolveProfile(did: string): Promise<ProfileResolveResult> {
    try {
      return await this.inner.resolveProfile(did)
    } catch {
      // Fallback to cached profile
      const cached = await this.graphCache.getEntry(did)
      if (cached?.name) {
        return {
          profile: {
            did: cached.did,
            name: cached.name,
            ...(cached.bio ? { bio: cached.bio } : {}),
            ...(cached.avatar ? { avatar: cached.avatar } : {}),
            ...(cached.encryptionPublicKey ? { encryptionPublicKey: cached.encryptionPublicKey } : {}),
            updatedAt: cached.fetchedAt,
          },
          fromCache: true,
        }
      }
      return { profile: null, fromCache: true }
    }
  }

  async resolveVerifications(did: string): Promise<Verification[]> {
    try {
      return await this.inner.resolveVerifications(did)
    } catch {
      return await this.graphCache.getCachedVerifications(did)
    }
  }

  async resolveAttestations(did: string): Promise<Attestation[]> {
    try {
      return await this.inner.resolveAttestations(did)
    } catch {
      return await this.graphCache.getCachedAttestations(did)
    }
  }

  async resolveSummaries(dids: string[]): Promise<ProfileSummary[]> {
    if (!this.inner.resolveSummaries) {
      throw new Error('Inner adapter does not support resolveSummaries')
    }
    return this.inner.resolveSummaries(dids)
  }

  /**
   * Retry all pending publish operations.
   *
   * Called by the app when connectivity is restored (online event,
   * visibility change, or on mount).
   *
   * @param did - The local user's DID
   * @param identity - The unlocked WotIdentity (needed for JWS signing)
   * @param getPublishData - Callback that reads current local data at retry time
   *                         (not stale data from the original publish attempt)
   */
  async syncPending(
    did: string,
    identity: WotIdentity,
    getPublishData: () => Promise<{
      profile?: PublicProfile
      verifications?: PublicVerificationsData
      attestations?: PublicAttestationsData
    }>,
  ): Promise<void> {
    const dirty = await this.publishState.getDirtyFields(did)
    if (dirty.size === 0) return

    const data = await getPublishData()

    if (dirty.has('profile') && data.profile) {
      try {
        await this.inner.publishProfile(data.profile, identity)
        await this.publishState.clearDirty(did, 'profile')
        this.clearError()
      } catch (e) {
        this.setError(e)
      }
    }

    if (dirty.has('verifications') && data.verifications) {
      try {
        await this.inner.publishVerifications(data.verifications, identity)
        await this.publishState.clearDirty(did, 'verifications')
        this.clearError()
      } catch (e) {
        this.setError(e)
      }
    }

    if (dirty.has('attestations') && data.attestations) {
      try {
        await this.inner.publishAttestations(data.attestations, identity)
        await this.publishState.clearDirty(did, 'attestations')
        this.clearError()
      } catch (e) {
        this.setError(e)
      }
    }
  }
}
