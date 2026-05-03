import { PublicProfile } from '../../types/identity';
import { Verification } from '../../types/verification';
import { Attestation } from '../../types/attestation';
import { IdentitySession } from '../../types/identity-session';
import { DiscoveryAdapter, ProfileResolveResult, PublicVerificationsData, PublicAttestationsData, ProfileSummary } from '../../ports/DiscoveryAdapter';
import { PublishStateStore } from '../../ports/PublishStateStore';
import { GraphCacheStore } from '../../ports/GraphCacheStore';
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
export declare class OfflineFirstDiscoveryAdapter implements DiscoveryAdapter {
    private inner;
    private publishState;
    private graphCache;
    private _lastError;
    private _errorListeners;
    constructor(inner: DiscoveryAdapter, publishState: PublishStateStore, graphCache: GraphCacheStore);
    /** Last publish error message (null if last attempt succeeded) */
    get lastError(): string | null;
    /** Subscribe to error state changes */
    onErrorChange(listener: (error: string | null) => void): () => void;
    private setError;
    private clearError;
    publishProfile(data: PublicProfile, identity: IdentitySession): Promise<void>;
    publishVerifications(data: PublicVerificationsData, identity: IdentitySession): Promise<void>;
    publishAttestations(data: PublicAttestationsData, identity: IdentitySession): Promise<void>;
    resolveProfile(did: string): Promise<ProfileResolveResult>;
    resolveVerifications(did: string): Promise<Verification[]>;
    resolveAttestations(did: string): Promise<Attestation[]>;
    resolveSummaries(dids: string[]): Promise<ProfileSummary[]>;
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
    syncPending(did: string, identity: IdentitySession, getPublishData: () => Promise<{
        profile?: PublicProfile;
        verifications?: PublicVerificationsData;
        attestations?: PublicAttestationsData;
    }>): Promise<void>;
}
//# sourceMappingURL=OfflineFirstDiscoveryAdapter.d.ts.map