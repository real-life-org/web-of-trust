import type { PublicProfile } from '../../types/identity'
import type { Attestation } from '../../types/attestation'
import type { IdentitySession } from '../../types/identity-session'
import { DiscoveryPartialPublishError, ProfileResourceRollbackError } from '../../ports/DiscoveryAdapter'
import type {
  ProfileResolveResult,
  ProfileVersionCache,
  PublicAttestationsData,
  PublicVerificationsData,
  ProfileSummary,
  VersionedDiscoveryAdapter,
} from '../../ports/DiscoveryAdapter'

/**
 * Dual-/multi-target discovery decorator (Stage A.2, discovery-dual — companion of
 * DualVaultClient / MultiBrokerMessagingAdapter; the A.1/A.2 cut is documented in
 * PR #251). `targets[0]` is the PRIMARY (e.g. the festival box), the rest are
 * secondaries (e.g. the public server). Same surface as HttpDiscoveryAdapter so
 * OfflineFirstDiscoveryAdapter (and the raw PublicProfile page) can wrap it
 * unchanged.
 *
 * READS (resolve*): try the primary; fall through to the NEXT target ONLY when the
 * primary THROWS a transport-shaped error. Any RESOLVED answer of the primary —
 * including profile:null / [] / an empty list — is authoritative and returned
 * as-is: a legitimate "does not exist (any more)" must never be overwritten by a
 * secondary still holding a stale copy. HttpDiscoveryAdapter signals not-found as
 * a VALUE (null/[]), not an error, so a throw is a transport fault (fetch reject,
 * timeout/abort), a 5xx/4xx `Error` — all worth retrying elsewhere — or a TYPED
 * security-final {@link ProfileResourceRollbackError}, which PROPAGATES immediately
 * without consulting further targets (see readWithFallback). If EVERY target
 * throws, the PRIMARY's error is surfaced (mirrors DualVaultClient's first-error
 * rule).
 *
 * WRITES (publish*): fan out to EVERY target best-effort (Promise.allSettled) —
 * mirror of DualVaultClient.pushChange. ALL fail ⇒ throw the first error. SOME
 * fail ⇒ throw {@link DiscoveryPartialPublishError} so OfflineFirstDiscoveryAdapter
 * keeps its dirty flag (re-publish the missing target next sync; the 409 path makes
 * the retry idempotent) without surfacing it as a hard error.
 */
export class FallbackDiscoveryAdapter implements VersionedDiscoveryAdapter {
  private readonly targets: VersionedDiscoveryAdapter[]
  private readonly targetKeys: string[]

  constructor(
    targets: VersionedDiscoveryAdapter[],
    options?: { targetKeys?: string[] },
  ) {
    if (targets.length === 0) throw new Error('FallbackDiscoveryAdapter: need at least one target')
    this.targets = targets
    this.targetKeys = options?.targetKeys ?? targets.map((_, i) => `target#${i}`)
  }

  /**
   * The PRIMARY's version cache leads (analog of DualVaultClient.getDocInfo
   * returning the first-reachable vault): the recovery workflow must read back the
   * exact baseline the resolve path wrote, and primary reads write the primary's
   * cache. KNOWN EDGE: when a read fell through to a SECONDARY (primary
   * unreachable), the version landed in the secondary's namespaced cache, so a
   * recovery reading THIS (primary) cache sees `undefined` for that resource —
   * benign (RecoveredResource.version is documented as possibly unknown; the next
   * successful primary fetch sets the baseline). Do NOT merge the caches: the
   * rollback baseline is deliberately per-target — a secondary may legitimately
   * lag, and a merged baseline would false-flag it as a rollback.
   * TODO(A.3): carry `version` in the resolve RESULT end-to-end so recovery stops
   * reading it back through this cache detour.
   */
  getVersionCache(): ProfileVersionCache {
    return this.targets[0].getVersionCache()
  }

  // --- Reads: primary first, next target only on a throw ---

  resolveProfile(did: string): Promise<ProfileResolveResult> {
    return this.readWithFallback((t) => t.resolveProfile(did))
  }

  resolveAttestations(did: string): Promise<Attestation[]> {
    return this.readWithFallback((t) => t.resolveAttestations(did))
  }

  resolveVerifications(did: string): Promise<Attestation[]> {
    return this.readWithFallback((t) => t.resolveVerifications(did))
  }

  async resolveSummaries(dids: string[]): Promise<ProfileSummary[]> {
    // Optional on the port (OfflineFirstDiscoveryAdapter / GraphCacheService guard
    // on its presence): only offered when the PRIMARY supports it, read-classified
    // like the resolve* methods.
    if (!this.targets[0].resolveSummaries) {
      throw new Error('FallbackDiscoveryAdapter: primary target does not support resolveSummaries')
    }
    return this.readWithFallback((t) => {
      if (!t.resolveSummaries) throw new Error('Discovery target does not support resolveSummaries')
      return t.resolveSummaries(dids)
    })
  }

  private async readWithFallback<T>(call: (t: VersionedDiscoveryAdapter) => Promise<T>): Promise<T> {
    let firstError: unknown
    let sawError = false
    for (const target of this.targets) {
      try {
        return await call(target)
      } catch (err) {
        // SECURITY-FINAL (Codex #253 blocker): a ProfileResourceRollbackError is a
        // tamper indicator — the target served an older version than its OWN
        // namespaced baseline ever saw. It must PROPAGATE immediately; a healthy
        // answer from another target must never mask it (the same rule
        // OfflineFirstDiscoveryAdapter enforces against its offline cache). This
        // is the only TYPED error class the resolve* paths let escape: JWS/DID
        // verification failures are absorbed to null/[] inside HttpDiscoveryAdapter
        // and never thrown. Deliberately instanceof-only, no string matching.
        if (err instanceof ProfileResourceRollbackError) throw err
        // Everything else that reaches here is transport-shaped (fetch reject,
        // timeout/abort, untyped 4xx/5xx `Error`) and worth retrying on the next
        // target — a legitimate not-found is a VALUE (null/[]), never a throw.
        if (!sawError) { firstError = err; sawError = true }
      }
    }
    // Every target threw — surface the PRIMARY's (first) error so
    // OfflineFirstDiscoveryAdapter can fall back to its offline cache.
    throw firstError instanceof Error ? firstError : new Error(String(firstError))
  }

  // --- Writes: best-effort to every target ---

  async publishProfile(data: PublicProfile, identity: IdentitySession): Promise<void> {
    await this.publishToAll((t) => t.publishProfile(data, identity))
  }

  async publishAttestations(data: PublicAttestationsData, identity: IdentitySession): Promise<void> {
    await this.publishToAll((t) => t.publishAttestations(data, identity))
  }

  async publishVerifications(data: PublicVerificationsData, identity: IdentitySession): Promise<void> {
    await this.publishToAll((t) => t.publishVerifications(data, identity))
  }

  private async publishToAll(call: (t: VersionedDiscoveryAdapter) => Promise<void>): Promise<void> {
    const results = await Promise.allSettled(this.targets.map(call))
    const failed = results
      .map((r, i) => ({ r, key: this.targetKeys[i] }))
      .filter((x): x is { r: PromiseRejectedResult; key: string } => x.r.status === 'rejected')
    if (failed.length === 0) return
    if (failed.length === this.targets.length) {
      // ALL failed — behave like DualVaultClient.pushChange: throw the first error.
      const firstErr = failed[0].r.reason
      throw firstErr instanceof Error ? firstErr : new Error(String(firstErr))
    }
    // Partial success: at least one target has the data. Signal it as a soft,
    // recoverable state (dirty stays, no hard error) rather than a failure.
    const succeeded = results
      .map((r, i) => ({ r, key: this.targetKeys[i] }))
      .filter((x) => x.r.status === 'fulfilled')
      .map((x) => x.key)
    failed.forEach((f) => console.debug(`[FallbackDiscovery] publish: target ${f.key} failed (best-effort):`, f.r.reason))
    throw new DiscoveryPartialPublishError(succeeded, failed.map((f) => f.key), failed[0].r.reason)
  }
}
