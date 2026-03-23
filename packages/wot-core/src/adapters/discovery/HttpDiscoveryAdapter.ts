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
import { ProfileService } from '../../services/ProfileService'
import { getTraceLog } from '../../storage/TraceLog'

/**
 * HTTP-based DiscoveryAdapter implementation.
 *
 * POC implementation backed by wot-profiles (HTTP REST + SQLite).
 * Replaceable by Automerge Auto-Groups, IPFS, DHT, etc.
 */
export class HttpDiscoveryAdapter implements DiscoveryAdapter {
  private readonly TIMEOUT_MS = 3_000

  constructor(private baseUrl: string) {}

  private fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS)
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
  }

  async publishProfile(data: PublicProfile, identity: WotIdentity): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const jws = await identity.signJws(data)
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(data.did)}`,
        { method: 'PUT', body: jws, headers: { 'Content-Type': 'text/plain' } },
      )
      if (!res.ok) throw new Error(`Profile upload failed: ${res.status}`)
      trace.log({ store: 'profiles', operation: 'write', label: `publishProfile ${data.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did: data.did, name: data.name } })
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'write', label: `publishProfile ${data.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did: data.did } })
      throw err
    }
  }

  async publishVerifications(data: PublicVerificationsData, identity: WotIdentity): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const jws = await identity.signJws(data)
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(data.did)}/v`,
        { method: 'PUT', body: jws, headers: { 'Content-Type': 'text/plain' } },
      )
      if (!res.ok) throw new Error(`Verifications upload failed: ${res.status}`)
      trace.log({ store: 'profiles', operation: 'write', label: `publishVerifications ${data.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did: data.did, count: data.verifications?.length ?? 0 } })
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'write', label: `publishVerifications ${data.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did: data.did } })
      throw err
    }
  }

  async publishAttestations(data: PublicAttestationsData, identity: WotIdentity): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const jws = await identity.signJws(data)
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(data.did)}/a`,
        { method: 'PUT', body: jws, headers: { 'Content-Type': 'text/plain' } },
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
      const result = await ProfileService.verifyProfile(jws)
      const profile = result.valid && result.profile ? result.profile : null
      trace.log({ store: 'profiles', operation: 'read', label: `resolveProfile ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, found: !!profile, name: profile?.name } })
      return { profile, fromCache: false }
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'read', label: `resolveProfile ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did } })
      throw err
    }
  }

  async resolveVerifications(did: string): Promise<Verification[]> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(did)}/v`)
      if (res.status === 404) {
        trace.log({ store: 'profiles', operation: 'read', label: `resolveVerifications ${did.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, count: 0 } })
        return []
      }
      if (!res.ok) throw new Error(`Verifications fetch failed: ${res.status}`)
      const jws = await res.text()
      const result = await ProfileService.verifyProfile(jws)
      if (!result.valid || !result.profile) return []
      const data = result.profile as unknown as PublicVerificationsData
      const verifications = data.verifications ?? []
      trace.log({ store: 'profiles', operation: 'read', label: `resolveVerifications ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { did, count: verifications.length } })
      return verifications
    } catch (err) {
      trace.log({ store: 'profiles', operation: 'read', label: `resolveVerifications ${did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { did } })
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
      const result = await ProfileService.verifyProfile(jws)
      if (!result.valid || !result.profile) return []
      const data = result.profile as unknown as PublicAttestationsData
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
