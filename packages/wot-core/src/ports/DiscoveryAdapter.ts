import type { PublicProfile } from '../types/identity'
import type { Attestation } from '../types/attestation'
import type { IdentitySession } from '../types/identity-session'
import type { DidDocument, ProfileServiceResourceKind } from '../protocol'

/**
 * Published attestations data — wraps an array of accepted attestations
 * about a DID, signed by the DID owner as JWS.
 */
export interface PublicAttestationsData {
  did: string
  attestations: Attestation[]
  updatedAt: string
}

/**
 * Published verifications data (`/p/{did}/v`) — the list of received live
 * verification-attestations the holder chose to publish (Sync 004 Z.24-32).
 * Same shape as attestations data; carried as derived `Attestation[]` form.
 */
export interface PublicVerificationsData {
  did: string
  verifications: Attestation[]
  updatedAt: string
}

/**
 * Lightweight summary for batch queries.
 * Unsigned (derived from already-verified JWS data server-side).
 */
export interface ProfileSummary {
  did: string
  name: string | null
  verificationCount: number
  attestationCount: number
}

/**
 * Result of resolving a profile — includes cache metadata.
 * Allows callers to distinguish fresh network data from cached fallback.
 */
export interface ProfileResolveResult {
  profile: PublicProfile | null
  didDocument?: DidDocument | null
  version?: number
  fromCache: boolean
}

/**
 * Resource-dimensional last-seen-version cache (VE-3).
 *
 * Sync 004 Z.181: rollback protection is independent per resource —
 * `/p` (profile), `/p/{did}/v` (verifications), `/p/{did}/a` (attestations)
 * each carry their own monotonic `version`.
 */
export interface ProfileVersionCache {
  getLastSeenVersion(did: string, resource: ProfileServiceResourceKind): Promise<number | undefined>
  setLastSeenVersion(did: string, resource: ProfileServiceResourceKind, version: number): Promise<void>
}

/**
 * Resource-dimensional, persistent monotonic publish-version source (VE-6).
 *
 * Sync 004 Z.106-126 require each published resource (`/p`, `/v`, `/a`) to carry
 * its OWN strictly-increasing `version`. The publisher owns that counter locally
 * (NOT `Date.now()` — a wall clock can go backwards and is not monotonic across
 * resources). `next(did, resource)` returns the version to publish and advances
 * the stored value; `reconcile(did, resource, serverVersion)` bumps the local
 * floor when the server reports a higher current version (Sync 004 Z.162 409
 * retry path) so the single follow-up publish uses `serverVersion + 1`.
 */
export interface ProfilePublishVersionStore {
  next(did: string, resource: ProfileServiceResourceKind): Promise<number>
  reconcile(did: string, resource: ProfileServiceResourceKind, serverVersion: number): Promise<number>
  peek(did: string, resource: ProfileServiceResourceKind): Promise<number | undefined>
}

export class LocalProfilePublishVersionStore implements ProfilePublishVersionStore {
  private readonly fallback = new Map<string, number>()

  /**
   * @param keyPrefix        Namespaced prefix, e.g. `wot:profile-publish-version:{serverKey}:`
   *                         so a second profile target (FallbackDiscoveryAdapter)
   *                         cannot share a counter with the primary.
   * @param legacyKeyPrefix  Un-namespaced prefix of the pre-namespace format,
   *                         e.g. `wot:profile-publish-version:`. When set (PRIMARY
   *                         only), a miss on the namespaced key adopts the legacy
   *                         counter ONCE. A missing counter self-heals via the 409
   *                         reconcile path, but adopting it avoids an unnecessary
   *                         409 on the first publish after the upgrade. Secondary
   *                         targets pass no legacyKeyPrefix and start at 0.
   */
  constructor(
    private readonly keyPrefix = 'wot:profile-publish-version:',
    private readonly legacyKeyPrefix?: string,
  ) {}

  async peek(did: string, resource: ProfileServiceResourceKind): Promise<number | undefined> {
    const key = this.keyFor(did, resource)
    let raw = this.storage?.getItem(key) ?? undefined
    if (raw === undefined && this.legacyKeyPrefix) {
      raw = this.adoptLegacy(key, `${this.legacyKeyPrefix}${did}:${resource}`)
    }
    const value = raw === undefined ? this.fallback.get(key) : Number(raw)
    if (value === undefined) return undefined
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }

  /**
   * Lazy legacy-namespace adoption: read the un-namespaced key, and on a hit
   * rewrite it under the namespaced key + drop the legacy key so the migration
   * runs exactly once and the shared legacy key stops bleeding across targets.
   */
  private adoptLegacy(namespacedKey: string, legacyKey: string): string | undefined {
    const legacyRaw = this.storage?.getItem(legacyKey) ?? undefined
    if (legacyRaw === undefined) return undefined
    try {
      this.storage?.setItem(namespacedKey, legacyRaw)
      this.storage?.removeItem(legacyKey)
    } catch {
      // storage full/denied — still return the value; migration retries later.
    }
    return legacyRaw
  }

  async next(did: string, resource: ProfileServiceResourceKind): Promise<number> {
    const current = (await this.peek(did, resource)) ?? 0
    // Guard the upper bound: at MAX_SAFE_INTEGER, +1 is no longer a safe integer
    // and peek() would later reject it, silently resetting the counter to 1 and
    // breaking monotonicity. (CodeRabbit #198)
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Profile publish version overflow')
    }
    const nextVersion = current + 1
    await this.write(did, resource, nextVersion)
    return nextVersion
  }

  async reconcile(did: string, resource: ProfileServiceResourceKind, serverVersion: number): Promise<number> {
    if (!Number.isSafeInteger(serverVersion) || serverVersion < 0) {
      throw new Error('Invalid server version')
    }
    const current = (await this.peek(did, resource)) ?? 0
    // The 409 body reports the server's current version; the retry must publish
    // strictly above it. Persist max(local, server)+1 so monotonicity holds even
    // after a fresh re-install whose local counter started behind the server.
    const floor = Math.max(current, serverVersion)
    if (floor >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Profile publish version overflow')
    }
    const reconciled = floor + 1
    await this.write(did, resource, reconciled)
    return reconciled
  }

  private async write(did: string, resource: ProfileServiceResourceKind, version: number): Promise<void> {
    const key = this.keyFor(did, resource)
    this.fallback.set(key, version)
    this.storage?.setItem(key, String(version))
  }

  private keyFor(did: string, resource: ProfileServiceResourceKind): string {
    return `${this.keyPrefix}${did}:${resource}`
  }

  private get storage(): Storage | undefined {
    try {
      return globalThis.localStorage
    } catch {
      return undefined
    }
  }
}

export class ProfileResourceRollbackError extends Error {
  constructor(
    readonly did: string,
    readonly fetchedVersion: number,
    readonly lastSeenVersion: number,
    readonly resource: ProfileServiceResourceKind,
  ) {
    super(`Profile resource rollback detected for ${did} (${resource}): fetched version ${fetchedVersion} is lower than last seen version ${lastSeenVersion}`)
    this.name = 'ProfileResourceRollbackError'
  }
}

/**
 * A best-effort dual publish (FallbackDiscoveryAdapter) that reached SOME but not
 * ALL targets. The publish is NOT a hard failure — at least one server has the
 * data — so OfflineFirstDiscoveryAdapter keeps the dirty flag (rather than
 * clearing it) and re-publishes the missing target on the next sync trigger; the
 * idempotent 409 path makes that retry safe. It is deliberately distinct from a
 * transport failure so the UI does not surface it as an error.
 */
export class DiscoveryPartialPublishError extends Error {
  constructor(
    readonly succeededTargets: string[],
    readonly failedTargets: string[],
    readonly cause?: unknown,
  ) {
    super(`Discovery publish reached ${succeededTargets.length}/${succeededTargets.length + failedTargets.length} targets (missing: ${failedTargets.join(', ')})`)
    this.name = 'DiscoveryPartialPublishError'
  }
}

/**
 * Normalize a discovery target's base URL into a stable store-namespace key:
 * lowercase scheme+host (the URL parser already lowercases host), no query/hash,
 * no trailing slash. Used to namespace the per-target rollback + publish-version
 * caches so a second profile server cannot cross-contaminate the primary.
 */
export function normalizeDiscoveryServerKey(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  }
}

export class LocalProfileVersionCache implements ProfileVersionCache {
  private readonly fallback = new Map<string, number>()

  /**
   * @param keyPrefix        Namespaced prefix, e.g. `wot:profile-version:{serverKey}:`.
   *                         With a second profile target (FallbackDiscoveryAdapter)
   *                         two adapters must NOT share a rollback baseline: the
   *                         primary's v10 would trip a false rollback against a
   *                         secondary legitimately at v9 (Codex R1 SF4).
   * @param legacyKeyPrefix  Un-namespaced prefix of the pre-namespace format,
   *                         e.g. `wot:profile-version:`. Set (PRIMARY only) to
   *                         LAZY-MIGRATE the baseline: silently switching the
   *                         namespace would drop the rollback baseline and weaken
   *                         rollback detection until the next fetch — a security
   *                         regression, not a benign cache miss. Secondary targets
   *                         pass no legacyKeyPrefix and deliberately start empty
   *                         (they have never seen this server).
   */
  constructor(
    private readonly keyPrefix = 'wot:profile-version:',
    private readonly legacyKeyPrefix?: string,
  ) {}

  async getLastSeenVersion(did: string, resource: ProfileServiceResourceKind): Promise<number | undefined> {
    const key = this.keyFor(did, resource)
    let raw = this.storage?.getItem(key) ?? undefined
    // Pre-resource single-key migration (VE-3): the legacy `{keyPrefix}{did}` value
    // predates the resource dimension. Only meaningful for an un-namespaced
    // keyPrefix (default); a no-op for namespaced instances.
    if (raw === undefined && resource === 'profile') {
      raw = this.storage?.getItem(this.keyPrefix + did) ?? undefined
    }
    // Lazy legacy-namespace adoption (Codex R1 point 4): a namespaced PRIMARY
    // inherits the pre-namespace baseline exactly once, rewrites it under the
    // namespaced key + drops the legacy key so rollback detection keeps its
    // baseline across the upgrade and the shared legacy key stops bleeding across
    // targets. Falls through to the pre-resource legacy key for `profile`.
    if (raw === undefined && this.legacyKeyPrefix) {
      raw = this.adoptLegacy(key, `${this.legacyKeyPrefix}${did}:${resource}`)
      if (raw === undefined && resource === 'profile') {
        raw = this.adoptLegacy(key, `${this.legacyKeyPrefix}${did}`)
      }
    }
    const value = raw === undefined ? this.fallback.get(key) : Number(raw)
    if (value === undefined) return undefined
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }

  private adoptLegacy(namespacedKey: string, legacyKey: string): string | undefined {
    const legacyRaw = this.storage?.getItem(legacyKey) ?? undefined
    if (legacyRaw === undefined) return undefined
    try {
      this.storage?.setItem(namespacedKey, legacyRaw)
      this.storage?.removeItem(legacyKey)
    } catch {
      // storage full/denied — still return the baseline; migration retries later.
    }
    return legacyRaw
  }

  async setLastSeenVersion(did: string, resource: ProfileServiceResourceKind, version: number): Promise<void> {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error('Invalid profile version')
    }
    const key = this.keyFor(did, resource)
    this.fallback.set(key, version)
    this.storage?.setItem(key, String(version))
  }

  private keyFor(did: string, resource: ProfileServiceResourceKind): string {
    return `${this.keyPrefix}${did}:${resource}`
  }

  private get storage(): Storage | undefined {
    try {
      return globalThis.localStorage
    } catch {
      return undefined
    }
  }
}

/**
 * Discovery adapter interface for public profile lookup.
 *
 * Framework-agnostic: Can be implemented with HTTP REST (POC, wot-profiles),
 * Automerge Auto-Groups, IPFS, DHT, or Nostr.
 *
 * The DiscoveryAdapter answers the question: "Who is this DID?"
 * — before any contact exists.
 *
 * Design principles:
 * - All data is Ed25519-signed (JWS) — integrity without confidentiality
 * - The DID owner controls what is public
 * - Anonymously readable — no login needed
 * - No authentication — the cryptographic signature IS the authorization
 * - Server is a dumb cache — truth lives locally
 *
 * Three orthogonal axes:
 *   Discovery (this) → Messaging → Replication
 *   VOR dem Kontakt    ZWISCHEN     INNERHALB
 *   öffentlich         privat       Gruppe
 */
export interface DiscoveryAdapter {
  // Publish own public data (signed as JWS)
  publishProfile(data: PublicProfile, identity: IdentitySession): Promise<void>
  publishAttestations(data: PublicAttestationsData, identity: IdentitySession): Promise<void>
  /**
   * Publish the holder's list of received live verification-attestations
   * (`/p/{did}/v`, Sync 004 Z.24-32). Additive sibling of publishAttestations.
   * The HTTP implementation is wired in Step 3.
   */
  publishVerifications(data: PublicVerificationsData, identity: IdentitySession): Promise<void>

  // Resolve public data for a DID (verifies JWS signature)
  resolveProfile(did: string): Promise<ProfileResolveResult>
  resolveAttestations(did: string): Promise<Attestation[]>
  /**
   * Resolve the holder's published verification-attestations (`/p/{did}/v`).
   * Returns the derived `Attestation[]` form, mirroring resolveAttestations.
   * The HTTP implementation is wired in Step 3.
   */
  resolveVerifications(did: string): Promise<Attestation[]>

  // Optional: batch summary for multiple DIDs (unsigned, server-derived counts)
  resolveSummaries?(dids: string[]): Promise<ProfileSummary[]>
}

/**
 * DiscoveryAdapter that also exposes the resource-dimensional version cache it
 * writes on every resolve (Sync 004 Z.181). The recovery workflow reads back the
 * exact versions the resolve path recorded, so it needs the SAME instance.
 * HttpDiscoveryAdapter implements this directly; FallbackDiscoveryAdapter delegates
 * to its PRIMARY target (the primary's version/rollback space leads — the analog
 * of DualVaultClient returning the first-reachable vault's docInfo).
 */
export interface VersionedDiscoveryAdapter extends DiscoveryAdapter {
  getVersionCache(): ProfileVersionCache
}
