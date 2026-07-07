import type { PublicProfile } from '../../types/identity'
import type { Attestation } from '../../types/attestation'
import type { IdentitySession } from '../../types/identity-session'
import { DiscoveryPartialPublishError, ProfileResourceRollbackError } from '../../ports/DiscoveryAdapter'
import type {
  DiscoveryAdapter,
  ProfileResolveResult,
  PublicAttestationsData,
  PublicVerificationsData,
  ProfileSummary,
} from '../../ports/DiscoveryAdapter'
import type { PublishStateStore } from '../../ports/PublishStateStore'
import type { GraphCacheStore } from '../../ports/GraphCacheStore'
import type { DidDocument } from '../../protocol/identity/did-document'
import { resolveDidKey } from '../../protocol/identity/did-key'

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
  private _lastErrorKind: 'network' | 'other' | null = null
  private _errorListeners: Array<(error: string | null) => void> = []

  constructor(
    private inner: DiscoveryAdapter,
    private publishState: PublishStateStore,
    private graphCache: GraphCacheStore,
  ) {}

  /** Last publish error message (null if last attempt succeeded) */
  get lastError(): string | null { return this._lastError }

  /**
   * Classification of the last publish error, set alongside the message so the UI
   * can map a transport fault to a friendly text at the SOURCE instead of showing
   * the raw AbortError string ("signal is aborted without reason"). `null` when
   * there is no error.
   */
  get lastErrorKind(): 'network' | 'other' | null { return this._lastErrorKind }

  /** Subscribe to error state changes */
  onErrorChange(listener: (error: string | null) => void): () => void {
    this._errorListeners.push(listener)
    return () => { this._errorListeners = this._errorListeners.filter(l => l !== listener) }
  }

  private setError(e: unknown) {
    this._lastError = e instanceof Error ? e.message : String(e)
    this._lastErrorKind = classifyDiscoveryErrorKind(e)
    console.warn('[Discovery] Publish failed:', this._lastError)
    this._errorListeners.forEach(l => l(this._lastError))
  }

  private clearError() {
    if (this._lastError !== null) {
      this._lastError = null
      this._lastErrorKind = null
      this._errorListeners.forEach(l => l(null))
    }
  }

  /**
   * A publish* threw. A {@link DiscoveryPartialPublishError} is a SOFT state — at
   * least one target has the data, the dirty flag is already retained (we skipped
   * clearDirty by throwing), and the missing target is re-published on the next
   * sync trigger — so it must NOT surface as a hard error. Everything else (all
   * targets down, or a single-target failure) is a real error.
   */
  private onPublishError(e: unknown) {
    if (e instanceof DiscoveryPartialPublishError) {
      this.clearError()
      return
    }
    this.setError(e)
  }

  async publishProfile(data: PublicProfile, identity: IdentitySession): Promise<void> {
    await this.publishState.markDirty(data.did, 'profile')
    try {
      await this.inner.publishProfile(data, identity)
      // Only reached on a FULL success — a partial dual publish throws
      // DiscoveryPartialPublishError, so clearDirty is skipped and the dirty flag
      // survives to retry the missing target.
      await this.publishState.clearDirty(data.did, 'profile')
      this.clearError()
    } catch (e) {
      this.onPublishError(e)
    }
  }

  async publishAttestations(data: PublicAttestationsData, identity: IdentitySession): Promise<void> {
    await this.publishState.markDirty(data.did, 'attestations')
    try {
      await this.inner.publishAttestations(data, identity)
      await this.publishState.clearDirty(data.did, 'attestations')
      this.clearError()
    } catch (e) {
      this.onPublishError(e)
    }
  }

  async publishVerifications(data: PublicVerificationsData, identity: IdentitySession): Promise<void> {
    await this.publishState.markDirty(data.did, 'verifications')
    try {
      await this.inner.publishVerifications(data, identity)
      await this.publishState.clearDirty(data.did, 'verifications')
      this.clearError()
    } catch (e) {
      this.onPublishError(e)
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
        // VE-6: reconstruct a local didDocument from the cached keyAgreement key
        // so resolveRecipientEncryptionKey still finds the ECIES key offline
        // (online verified/synced → later offline attest/invite). The key lives
        // ONLY under keyAgreement[0] — never leaked into profile metadata.
        let didDocument: DidDocument | null = null
        if (cached.encryptionKeyMultibase) {
          try {
            didDocument = resolveDidKey(did, {
              keyAgreement: [{
                id: '#enc-0',
                type: 'X25519KeyAgreementKey2020',
                controller: did,
                publicKeyMultibase: cached.encryptionKeyMultibase,
              }],
            })
          } catch {
            // Non-did:key (or otherwise un-buildable) → no local doc; matches
            // today's behavior. Never propagate.
            didDocument = null
          }
        }
        return {
          profile: {
            did: cached.did,
            name: cached.name,
            ...(cached.bio ? { bio: cached.bio } : {}),
            ...(cached.avatar ? { avatar: cached.avatar } : {}),
            updatedAt: cached.fetchedAt,
          },
          didDocument,
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
        this.onPublishError(e)
      }
    }

    if (dirty.has('attestations') && data.attestations) {
      try {
        await this.inner.publishAttestations(data.attestations, identity)
        await this.publishState.clearDirty(did, 'attestations')
        this.clearError()
      } catch (e) {
        this.onPublishError(e)
      }
    }

    if (dirty.has('verifications') && data.verifications) {
      try {
        await this.inner.publishVerifications(data.verifications, identity)
        await this.publishState.clearDirty(did, 'verifications')
        this.clearError()
      } catch (e) {
        this.onPublishError(e)
      }
    }
  }
}

/**
 * Classify a publish error so the UI can distinguish an unreachable server from a
 * genuine server-side error. The raw string of an aborted fetch is
 * "signal is aborted without reason" (AbortController.abort() with no reason) and
 * `fetch` rejects a hard network failure as a TypeError ("fetch failed" /
 * "Failed to fetch"); both are the "profile server unreachable" case.
 */
export function classifyDiscoveryErrorKind(e: unknown): 'network' | 'other' {
  const name = e instanceof Error ? e.name : ''
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    msg.includes('aborted') ||
    msg.includes('fetch failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  ) {
    return 'network'
  }
  return 'other'
}
