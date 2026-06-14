import type { PublicProfile } from '../../types/identity'
import type { Attestation } from '../../types/attestation'
import type { IdentitySession } from '../../types/identity-session'
import { ProfileResourceRollbackError } from '../../ports/DiscoveryAdapter'
import type {
  DiscoveryAdapter,
  ProfileResolveResult,
  PublicAttestationsData,
  PublicVerificationsData,
  ProfileSummary,
} from '../../ports/DiscoveryAdapter'
import type { PublishStateStore } from '../../ports/PublishStateStore'
import type { GraphCacheStore } from '../../ports/GraphCacheStore'

/**
 * Offline-first wrapper for any DiscoveryAdapter.
 *
 * Decorator pattern: wraps an inner DiscoveryAdapter and adds:
 * - Dirty-flag tracking for publish operations (via PublishStateStore)
 * - Profile/attestation caching for resolve operations (via GraphCacheStore)
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

  async publishProfile(data: PublicProfile, identity: IdentitySession): Promise<void> {
    await this.publishState.markDirty(data.did, 'profile')
    try {
      await this.inner.publishProfile(data, identity)
      await this.publishState.clearDirty(data.did, 'profile')
      this.clearError()
    } catch (e) {
      this.setError(e)
    }
  }

  async publishAttestations(data: PublicAttestationsData, identity: IdentitySession): Promise<void> {
    await this.publishState.markDirty(data.did, 'attestations')
    try {
      await this.inner.publishAttestations(data, identity)
      await this.publishState.clearDirty(data.did, 'attestations')
      this.clearError()
    } catch (e) {
      this.setError(e)
    }
  }

  async publishVerifications(data: PublicVerificationsData, identity: IdentitySession): Promise<void> {
    await this.publishState.markDirty(data.did, 'verifications')
    try {
      await this.inner.publishVerifications(data, identity)
      await this.publishState.clearDirty(data.did, 'verifications')
      this.clearError()
    } catch (e) {
      this.setError(e)
    }
  }

  async resolveProfile(did: string): Promise<ProfileResolveResult> {
    try {
      // VE-3: version monotonicity + rollback caching live exclusively in the
      // inner HTTP adapter (single cache owner). The decorator only re-throws a
      // rollback so it is never masked by the offline cache fallback.
      return await this.inner.resolveProfile(did)
    } catch (error) {
      if (error instanceof ProfileResourceRollbackError) throw error
      // Fallback to cached profile
      const cached = await this.graphCache.getEntry(did)
      if (cached?.name) {
        return {
          profile: {
            did: cached.did,
            name: cached.name,
            ...(cached.bio ? { bio: cached.bio } : {}),
            ...(cached.avatar ? { avatar: cached.avatar } : {}),
            updatedAt: cached.fetchedAt,
          },
          didDocument: null,
          fromCache: true,
        }
      }
      return { profile: null, fromCache: true }
    }
  }

  async resolveAttestations(did: string): Promise<Attestation[]> {
    try {
      return await this.inner.resolveAttestations(did)
    } catch (error) {
      // VE-3: a rollback must surface — the offline cache fallback must never
      // mask a ProfileResourceRollbackError.
      if (error instanceof ProfileResourceRollbackError) throw error
      return await this.graphCache.getCachedAttestations(did)
    }
  }

  async resolveVerifications(did: string): Promise<Attestation[]> {
    try {
      return await this.inner.resolveVerifications(did)
    } catch (error) {
      if (error instanceof ProfileResourceRollbackError) throw error
      return await this.graphCache.getCachedVerifications(did)
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
   * @param identity - The unlocked identity session (needed for JWS signing)
   * @param getPublishData - Callback that reads current local data at retry time
   *                         (not stale data from the original publish attempt)
   */
  async syncPending(
    did: string,
    identity: IdentitySession,
    getPublishData: () => Promise<{
      profile?: PublicProfile
      attestations?: PublicAttestationsData
      verifications?: PublicVerificationsData
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

    if (dirty.has('attestations') && data.attestations) {
      try {
        await this.inner.publishAttestations(data.attestations, identity)
        await this.publishState.clearDirty(did, 'attestations')
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
  }
}
