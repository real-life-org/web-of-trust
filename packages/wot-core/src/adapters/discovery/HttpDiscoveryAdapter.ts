import type { PublicProfile } from '../../types/identity'
import type { Attestation } from '../../types/attestation'
import type { IdentitySession } from '../../types/identity-session'
import {
  LocalProfileVersionCache,
  ProfileResourceRollbackError,
} from '../../ports/DiscoveryAdapter'
import type {
  DiscoveryAdapter,
  ProfileResolveResult,
  ProfileVersionCache,
  PublicAttestationsData,
  ProfileSummary,
} from '../../ports/DiscoveryAdapter'
import {
  detectProfileResourceRollback,
  verifyProfileServiceResourceJws,
  type ProfileServiceResourcePayload,
} from '../../protocol/sync/profile-service-resource'
import { verifyJwsByDidResolver } from '../../protocol/identity/jws-did-verify'
import { createDidKeyResolver } from '../../protocol/identity/did-key'
import type { DidResolver } from '../../protocol/identity/did-document'
import type { ProtocolCryptoAdapter } from '../../protocol/crypto/ports'
import { WebCryptoProtocolCryptoAdapter } from '../protocol-crypto'
import { createProfilePublicationWorkflow } from '../../application/discovery'
import { flattenProfilePublicationPayload } from '../../application/identity/profile-document'
import { getTraceLog } from '../../storage/TraceLog'

/**
 * HTTP-based DiscoveryAdapter implementation.
 *
 * POC implementation backed by wot-profiles (HTTP REST + SQLite).
 * Replaceable by Automerge Auto-Groups, IPFS, DHT, etc.
 */
export class HttpDiscoveryAdapter implements DiscoveryAdapter {
  private readonly TIMEOUT_MS = 3_000
  private readonly publicationWorkflow = createProfilePublicationWorkflow()

  constructor(
    private baseUrl: string,
    private versionCache: ProfileVersionCache = new LocalProfileVersionCache(),
    private didResolver: DidResolver = createDidKeyResolver(),
    private crypto: ProtocolCryptoAdapter = new WebCryptoProtocolCryptoAdapter(),
  ) {}

  private fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS)
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
  }

  async publishProfile(data: PublicProfile, identity: IdentitySession): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const jws = await this.publicationWorkflow.signProfile(data, identity)
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(data.did)}`,
        { method: 'PUT', body: jws, headers: { 'Content-Type': 'application/jws' } },
      )
      if (!res.ok) throw new Error(`Profile upload failed: ${res.status}`)
      trace.log({ store: 'profiles', operation: 'write', label: `publishProfile ${data.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did: data.did, name: data.name } })
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'write', label: `publishProfile ${data.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did: data.did } })
      throw err
    }
  }

  async publishAttestations(data: PublicAttestationsData, identity: IdentitySession): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const jws = await identity.signJws(data)
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(data.did)}/a`,
        { method: 'PUT', body: jws, headers: { 'Content-Type': 'application/jws' } },
      )
      if (!res.ok) throw new Error(`Attestations upload failed: ${res.status}`)
      trace.log({ store: 'profiles', operation: 'write', label: `publishAttestations ${data.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did: data.did, count: data.attestations?.length ?? 0 } })
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'write', label: `publishAttestations ${data.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did: data.did } })
      throw err
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
        payload = null
      }
      if (!payload) {
        trace.log({ store: 'profiles', operation: 'read', label: `resolveProfile ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, meta: { did, found: false } })
        return { profile: null, fromCache: false }
      }
      const profile = flattenProfilePublicationPayload(payload)
      const lastSeenVersion = await this.versionCache.getLastSeenProfileVersion(did)
      if (detectProfileResourceRollback({ fetchedVersion: payload.version, lastSeenVersion })) {
        throw new ProfileResourceRollbackError(did, payload.version, lastSeenVersion!)
      }
      await this.versionCache.setLastSeenProfileVersion(did, payload.version)
      trace.log({ store: 'profiles', operation: 'read', label: `resolveProfile ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, found: true, name: profile.name } })
      return { profile, didDocument: payload.didDocument, version: payload.version, fromCache: false }
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'read', label: `resolveProfile ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did } })
      throw err
    }
  }

  async resolveAttestations(did: string): Promise<Attestation[]> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(did)}/a`)
      if (res.status === 404) {
        trace.log({ store: 'profiles', operation: 'read', label: `resolveAttestations ${did.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, count: 0 } })
        return []
      }
      if (!res.ok) throw new Error(`Attestations fetch failed: ${res.status}`)
      const jws = await res.text()
      let payload: Record<string, unknown> | null = null
      try {
        const verified = await verifyJwsByDidResolver(jws, {
          expectedDid: did,
          didResolver: this.didResolver,
          crypto: this.crypto,
        })
        payload = verified.payload
      } catch {
        payload = null
      }
      if (!payload) return []
      // VE-1: Sync 004 Z.28 + ListResource-Schema sehen hier eine Liste von
      // Compact-JWS-Strings vor. Der heutige DiscoveryAdapter-Vertrag liefert
      // strukturierte Attestation[] direkt; die Migration auf Compact-JWS ist ein
      // eigener Slice (1.B.3-discovery-attestations). Hier bewusst Behavior-Erhalt:
      // Payload weiter als PublicAttestationsData behandeln.
      const data = payload as unknown as PublicAttestationsData
      const attestations = data.attestations ?? []
      trace.log({ store: 'profiles', operation: 'read', label: `resolveAttestations ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, count: attestations.length } })
      return attestations
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'read', label: `resolveAttestations ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did } })
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
