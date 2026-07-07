import type { PublicProfile } from '../../types/identity'
import type { Attestation } from '../../types/attestation'
import type { IdentitySession } from '../../types/identity-session'
import {
  LocalProfilePublishVersionStore,
  LocalProfileVersionCache,
  ProfileResourceRollbackError,
  normalizeDiscoveryServerKey,
} from '../../ports/DiscoveryAdapter'
import type {
  ProfilePublishVersionStore,
  ProfileResolveResult,
  ProfileVersionCache,
  PublicAttestationsData,
  PublicVerificationsData,
  ProfileSummary,
  VersionedDiscoveryAdapter,
} from '../../ports/DiscoveryAdapter'
import {
  detectProfileResourceRollback,
  verifyProfileServiceResourceJws,
  type ProfileServiceListResourceKind,
  type ProfileServiceListResourcePayload,
  type ProfileServiceResourcePayload,
} from '../../protocol/sync/profile-service-resource'
import { isVerificationAttestation } from '../../protocol/trust/attestation-vc-jws'
import { createDidKeyResolver } from '../../protocol/identity/did-key'
import type { DidResolver } from '../../protocol/identity/did-document'
import type { ProtocolCryptoAdapter } from '../../protocol/crypto/ports'
import { WebCryptoProtocolCryptoAdapter } from '../protocol-crypto'
import { createProfilePublicationWorkflow } from '../../application/discovery'
import { importVerifiedAttestationFromVcJws } from '../../application/attestations/import-attestation'
import { flattenProfilePublicationPayload } from '../../application/identity/profile-document'
import { getTraceLog } from '../../storage/TraceLog'

/**
 * HTTP-based DiscoveryAdapter implementation.
 *
 * POC implementation backed by wot-profiles (HTTP REST + SQLite).
 * Replaceable by Automerge Auto-Groups, IPFS, DHT, etc.
 */
export class HttpDiscoveryAdapter implements VersionedDiscoveryAdapter {
  private readonly TIMEOUT_MS = 3_000
  private readonly publicationWorkflow = createProfilePublicationWorkflow()
  /** Z.183 idempotency guard: last verified JWS + derived result per `{serverKey}:{did}:{resource}`. */
  private readonly lastVerified = new Map<string, { jws: string; attestations: Attestation[]; version: number }>()
  /** Normalized base-URL namespace for the per-target version/rollback caches. */
  private readonly serverKey: string
  private readonly versionCache: ProfileVersionCache
  private readonly publishVersions: ProfilePublishVersionStore

  constructor(
    private baseUrl: string,
    versionCache?: ProfileVersionCache,
    private didResolver: DidResolver = createDidKeyResolver(),
    private crypto: ProtocolCryptoAdapter = new WebCryptoProtocolCryptoAdapter(),
    publishVersions?: ProfilePublishVersionStore,
    options?: { serverKey?: string; adoptLegacyCacheKeys?: boolean },
  ) {
    this.serverKey = options?.serverKey ?? normalizeDiscoveryServerKey(baseUrl)
    // Namespace the persistent rollback + publish-version caches per target so a
    // SECOND profile server (FallbackDiscoveryAdapter) cannot share `{did}:{resource}`
    // keys with the primary (Codex R1 SF4: the primary's v10 would trip a false
    // rollback against a secondary legitimately at v9). The PRIMARY lazy-migrates
    // the pre-namespace keys so its rollback baseline survives the upgrade —
    // adoptLegacyCacheKeys defaults true because a lone single-server adapter IS
    // the primary. A secondary passes adoptLegacyCacheKeys:false and starts empty
    // (it has never seen this server). Injected stores keep their own namespace.
    const adopt = options?.adoptLegacyCacheKeys ?? true
    this.versionCache = versionCache
      ?? new LocalProfileVersionCache(`wot:profile-version:${this.serverKey}:`, adopt ? 'wot:profile-version:' : undefined)
    this.publishVersions = publishVersions
      ?? new LocalProfilePublishVersionStore(`wot:profile-publish-version:${this.serverKey}:`, adopt ? 'wot:profile-publish-version:' : undefined)
  }

  /**
   * The resource-dimensional version cache this adapter writes on every resolve
   * (Sync 004 Z.181). Exposed so the recovery workflow can read back the exact
   * versions the resolve path just recorded — injecting the SAME instance avoids
   * a second cache that would report `undefined` versions (VE-5).
   */
  getVersionCache(): ProfileVersionCache {
    return this.versionCache
  }

  private fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS)
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
  }

  async publishProfile(data: PublicProfile, identity: IdentitySession): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      // VE-6/Stop-4: `/p` shares the same persistent monotonic counter as `/v`+`/a`
      // (one mechanism for all three resources) instead of the old `Date.now()`
      // default. The library `buildProfilePublicationPayload` Date.now() fallback
      // stays as a non-wired default but the adapter never relies on it.
      let version = await this.publishVersions.next(data.did, 'profile')
      let res = await this.putProfile(data, identity, version)
      if (res.status === 409) {
        const serverVersion = await this.readConflictVersion(res)
        if (serverVersion !== undefined) {
          version = await this.publishVersions.reconcile(data.did, 'profile', serverVersion)
          res = await this.putProfile(data, identity, version)
        }
      }
      if (!res.ok) throw new Error(`Profile upload failed: ${res.status}`)
      trace.log({ store: 'profiles', operation: 'write', label: `publishProfile ${data.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did: data.did, name: data.name, version } })
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'write', label: `publishProfile ${data.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did: data.did } })
      throw err
    }
  }

  private async putProfile(data: PublicProfile, identity: IdentitySession, version: number): Promise<Response> {
    const jws = await this.publicationWorkflow.signProfile(data, identity, { version })
    return this.fetchWithTimeout(
      `${this.baseUrl}/p/${encodeURIComponent(data.did)}`,
      { method: 'PUT', body: jws, headers: { 'Content-Type': 'application/jws' } },
    )
  }

  async publishAttestations(data: PublicAttestationsData, identity: IdentitySession): Promise<void> {
    const items = (data.attestations ?? []).map((attestation) => attestation.vcJws)
    await this.publishListResource('attestations', data.did, items, data.updatedAt, identity, data.attestations?.length ?? 0)
  }

  async publishVerifications(data: PublicVerificationsData, identity: IdentitySession): Promise<void> {
    const items = (data.verifications ?? []).map((verification) => verification.vcJws)
    await this.publishListResource('verifications', data.did, items, data.updatedAt, identity, data.verifications?.length ?? 0)
  }

  /**
   * Build + PUT a Sync 004 Z.106-126 ListResource: `{did, version, <kind>:
   * [<VC-JWS-compact-strings>], updatedAt}`, signed by the owner. The published
   * items are the ORIGINAL `attestation.vcJws` — nothing is re-signed (VE-1).
   *
   * `version` is a local, persistent, monotonic counter (VE-6, NOT Date.now()).
   * On a 409 the server reports its current version in the body; we reconcile the
   * local floor and retry EXACTLY ONCE with `serverVersion + 1` (Sync 004 Z.162),
   * then surface the error — no retry loop.
   */
  private async publishListResource(
    kind: ProfileServiceListResourceKind,
    did: string,
    items: string[],
    updatedAt: string,
    identity: IdentitySession,
    count: number,
  ): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    const label = kind === 'verifications' ? 'publishVerifications' : 'publishAttestations'
    const path = kind === 'verifications' ? 'v' : 'a'
    try {
      let version = await this.publishVersions.next(did, kind)
      let res = await this.putListResource(kind, did, path, items, updatedAt, version, identity)
      if (res.status === 409) {
        // Single spec-conform retry (Sync 004 Z.162): the 409 body carries the
        // server's current version; republish strictly above it, once.
        const serverVersion = await this.readConflictVersion(res)
        if (serverVersion !== undefined) {
          version = await this.publishVersions.reconcile(did, kind, serverVersion)
          res = await this.putListResource(kind, did, path, items, updatedAt, version, identity)
        }
      }
      if (!res.ok) throw new Error(`${label} upload failed: ${res.status}`)
      trace.log({ store: 'profiles', operation: 'write', label: `${label} ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, count, version } })
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'write', label: `${label} ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did } })
      throw err
    }
  }

  private async putListResource(
    kind: ProfileServiceListResourceKind,
    did: string,
    path: string,
    items: string[],
    updatedAt: string,
    version: number,
    identity: IdentitySession,
  ): Promise<Response> {
    const payload: ProfileServiceListResourcePayload =
      kind === 'verifications'
        ? { did, version, verifications: items, updatedAt }
        : { did, version, attestations: items, updatedAt }
    const jws = await identity.signJws(payload)
    return this.fetchWithTimeout(
      `${this.baseUrl}/p/${encodeURIComponent(did)}/${path}`,
      { method: 'PUT', body: jws, headers: { 'Content-Type': 'application/jws' } },
    )
  }

  private async readConflictVersion(res: Response): Promise<number | undefined> {
    try {
      const body = (await res.clone().json()) as { version?: unknown }
      return Number.isSafeInteger(body.version) && (body.version as number) >= 0 ? (body.version as number) : undefined
    } catch {
      return undefined
    }
  }

  async resolveProfile(did: string): Promise<ProfileResolveResult> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(did)}`)
      if (res.status === 404) {
        trace.log({ store: 'profiles', operation: 'read', label: `resolveProfile ${did.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, found: false } })
        return { profile: null, fromCache: false }
      }
      if (!res.ok) throw new Error(`Profile fetch failed: ${res.status}`)
      const jws = await res.text()
      let payload: ProfileServiceResourcePayload | null = null
      try {
        payload = await verifyProfileServiceResourceJws(jws, {
          expectedDid: did,
          resourceKind: 'profile',
          didResolver: this.didResolver,
          crypto: this.crypto,
        })
      } catch {
        // Graceful degradation: an unverifiable or malformed profile resource is
        // treated as absent (profile: null), not surfaced — see the
        // verification-fails test. A fetch/transport fault still throws via the
        // outer catch; only verification failures are absorbed here.
        payload = null
      }
      if (!payload) {
        trace.log({ store: 'profiles', operation: 'read', label: `resolveProfile ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, meta: { did, found: false } })
        return { profile: null, fromCache: false }
      }
      const profile = flattenProfilePublicationPayload(payload)
      const lastSeenVersion = await this.versionCache.getLastSeenVersion(did, 'profile')
      if (detectProfileResourceRollback({ fetchedVersion: payload.version, lastSeenVersion, resource: 'profile' })) {
        throw new ProfileResourceRollbackError(did, payload.version, lastSeenVersion!, 'profile')
      }
      await this.versionCache.setLastSeenVersion(did, 'profile', payload.version)
      trace.log({ store: 'profiles', operation: 'read', label: `resolveProfile ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, found: true, name: profile.name } })
      return { profile, didDocument: payload.didDocument, version: payload.version, fromCache: false }
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'read', label: `resolveProfile ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did } })
      throw err
    }
  }

  async resolveAttestations(did: string): Promise<Attestation[]> {
    return this.resolveListResource('attestations', did)
  }

  async resolveVerifications(did: string): Promise<Attestation[]> {
    return this.resolveListResource('verifications', did)
  }

  /**
   * Resolve a Sync 004 Z.106-126 ListResource (`/a` or `/v`) into the derived
   * `Attestation[]` form (VE-1, port contract unchanged).
   *
   * Pipeline: verify the owner ListResource-JWS (`verifyProfileServiceResourceJws`
   * + did↔path) — invalid owner JWS ⇒ discard the WHOLE resource (empty + warn);
   * rollback check per resource (Z.181) re-throws `ProfileResourceRollbackError`;
   * each item VC-JWS runs through the shared `importAttestation` semantics; the
   * subject-invariant `attestation.to === did` and the disjoint `WotVerification`
   * filter (VE-2, enforced lesend too) reject stray items with a warning so one
   * bad item cannot DoS the whole list.
   */
  private async resolveListResource(kind: ProfileServiceListResourceKind, did: string): Promise<Attestation[]> {
    const trace = getTraceLog()
    const start = performance.now()
    const label = kind === 'verifications' ? 'resolveVerifications' : 'resolveAttestations'
    const path = kind === 'verifications' ? 'v' : 'a'
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(did)}/${path}`)
      if (res.status === 404) {
        trace.log({ store: 'profiles', operation: 'read', label: `${label} ${did.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, count: 0 } })
        return []
      }
      if (!res.ok) throw new Error(`${label} fetch failed: ${res.status}`)
      const jws = await res.text()

      // Z.183 SHOULD: if the exact same JWS bytes were already verified+derived,
      // skip the re-verification/re-derivation and return the cached result.
      // The idempotency fast-path may skip the crypto work, but it MUST NOT skip
      // the rollback check: the last-seen baseline lives in versionCache
      // (LocalProfileVersionCache = shared localStorage), so another tab/adapter
      // instance can have advanced it past this instance's cached version. If the
      // broker then re-serves the same older JWS, returning it as "idempotent"
      // would silently bypass rollback detection. Re-check against the current
      // baseline before trusting the cached result. (Codex review #198)
      const guardKey = `${this.serverKey}:${did}:${kind}`
      const guarded = this.lastVerified.get(guardKey)
      if (guarded && guarded.jws === jws) {
        const lastSeenVersion = await this.versionCache.getLastSeenVersion(did, kind)
        if (detectProfileResourceRollback({ fetchedVersion: guarded.version, lastSeenVersion, resource: kind })) {
          throw new ProfileResourceRollbackError(did, guarded.version, lastSeenVersion!, kind)
        }
        trace.log({ store: 'profiles', operation: 'read', label: `${label} ${did.slice(0, 24)}… (idempotent)`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, count: guarded.attestations.length } })
        // Return a copy so a consumer mutating the array can't tamper with the
        // cached idempotency result served to later resolves. (CodeRabbit #198)
        return [...guarded.attestations]
      }

      let payload: ProfileServiceListResourcePayload | null = null
      try {
        payload = await verifyProfileServiceResourceJws(jws, {
          expectedDid: did,
          resourceKind: kind,
          didResolver: this.didResolver,
          crypto: this.crypto,
        })
      } catch (err) {
        // VE-1: an unverifiable/malformed owner ListResource (bad signature, wrong
        // DID/path, structured legacy payload) is discarded whole — empty + warn,
        // not surfaced. A fetch/transport fault still throws via the outer catch.
        console.warn(`[HttpDiscoveryAdapter] ${label}: discarding resource for ${did} — invalid owner JWS:`, err instanceof Error ? err.message : err)
        payload = null
      }
      if (!payload) return []

      // Rollback protection per resource (Sync 004 Z.181), independent baseline.
      const lastSeenVersion = await this.versionCache.getLastSeenVersion(did, kind)
      if (detectProfileResourceRollback({ fetchedVersion: payload.version, lastSeenVersion, resource: kind })) {
        throw new ProfileResourceRollbackError(did, payload.version, lastSeenVersion!, kind)
      }
      await this.versionCache.setLastSeenVersion(did, kind, payload.version)

      const items: string[] = ('verifications' in payload ? payload.verifications : payload.attestations) ?? []
      const attestations: Attestation[] = []
      for (const item of items) {
        let derived
        try {
          derived = await importVerifiedAttestationFromVcJws(item, {
            crypto: this.crypto,
            didResolver: this.didResolver,
          })
        } catch (err) {
          console.warn(`[HttpDiscoveryAdapter] ${label}: skipping invalid item for ${did}:`, err instanceof Error ? err.message : err)
          continue
        }
        // Subject-invariant (VE-1, one form): published resources are statements
        // ABOUT the holder, so the derived subject must be the resource DID.
        if (derived.attestation.to !== did) {
          console.warn(`[HttpDiscoveryAdapter] ${label}: skipping item whose subject ${derived.attestation.to} !== ${did}`)
          continue
        }
        // Disjoint split enforced lesend (VE-2): `/v` keeps only WotVerification
        // payloads, `/a` only the rest.
        const isVerification = isVerificationAttestation(derived.payload)
        if (kind === 'verifications' ? !isVerification : isVerification) {
          console.warn(`[HttpDiscoveryAdapter] ${label}: skipping item with wrong split for ${kind}`)
          continue
        }
        attestations.push(derived.attestation)
      }

      // Store a copy so the returned `attestations` array (handed to the caller
      // below) and the cached idempotency entry don't alias. (CodeRabbit #198)
      this.lastVerified.set(guardKey, { jws, attestations: [...attestations], version: payload.version })
      trace.log({ store: 'profiles', operation: 'read', label: `${label} ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, count: attestations.length, version: payload.version } })
      return attestations
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'read', label: `${label} ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did } })
      throw err
    }
  }

  async resolveSummaries(dids: string[]): Promise<ProfileSummary[]> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const params = dids.map(d => encodeURIComponent(d)).join(',')
      const res = await this.fetchWithTimeout(`${this.baseUrl}/s?dids=${params}`)
      if (!res.ok) throw new Error(`Summary fetch failed: ${res.status}`)
      const summaries = await res.json()
      trace.log({ store: 'profiles', operation: 'read', label: `resolveSummaries (${dids.length} DIDs)`, durationMs: Math.round(performance.now() - start), success: true, meta: { count: dids.length, results: summaries.length } })
      return summaries
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'read', label: `resolveSummaries (${dids.length} DIDs)`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { count: dids.length } })
      throw err
    }
  }
}
