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
    const jws = await identity.signJws(data)
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/p/${encodeURIComponent(data.did)}`,
      { method: 'PUT', body: jws, headers: { 'Content-Type': 'text/plain' } },
    )
    if (!res.ok) throw new Error(`Profile upload failed: ${res.status}`)
  }

  async publishVerifications(data: PublicVerificationsData, identity: WotIdentity): Promise<void> {
    const jws = await identity.signJws(data)
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/p/${encodeURIComponent(data.did)}/v`,
      { method: 'PUT', body: jws, headers: { 'Content-Type': 'text/plain' } },
    )
    if (!res.ok) throw new Error(`Verifications upload failed: ${res.status}`)
  }

  async publishAttestations(data: PublicAttestationsData, identity: WotIdentity): Promise<void> {
    const jws = await identity.signJws(data)
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/p/${encodeURIComponent(data.did)}/a`,
      { method: 'PUT', body: jws, headers: { 'Content-Type': 'text/plain' } },
    )
    if (!res.ok) throw new Error(`Attestations upload failed: ${res.status}`)
  }

  async resolveProfile(did: string): Promise<ProfileResolveResult> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(did)}`)
    if (res.status === 404) return { profile: null, fromCache: false }
    if (!res.ok) throw new Error(`Profile fetch failed: ${res.status}`)
    const jws = await res.text()
    const result = await ProfileService.verifyProfile(jws)
    const profile = result.valid && result.profile ? result.profile : null
    return { profile, fromCache: false }
  }

  async resolveVerifications(did: string): Promise<Verification[]> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(did)}/v`)
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`Verifications fetch failed: ${res.status}`)
    const jws = await res.text()
    const result = await ProfileService.verifyProfile(jws)
    if (!result.valid || !result.profile) return []
    const data = result.profile as unknown as PublicVerificationsData
    return data.verifications ?? []
  }

  async resolveAttestations(did: string): Promise<Attestation[]> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(did)}/a`)
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`Attestations fetch failed: ${res.status}`)
    const jws = await res.text()
    const result = await ProfileService.verifyProfile(jws)
    if (!result.valid || !result.profile) return []
    const data = result.profile as unknown as PublicAttestationsData
    return data.attestations ?? []
  }

  async resolveSummaries(dids: string[]): Promise<ProfileSummary[]> {
    const params = dids.map(d => encodeURIComponent(d)).join(',')
    const res = await this.fetchWithTimeout(`${this.baseUrl}/s?dids=${params}`)
    if (!res.ok) throw new Error(`Summary fetch failed: ${res.status}`)
    return res.json()
  }
}
