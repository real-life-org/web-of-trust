import type { PublicProfile } from '../types/identity'
import type { Attestation } from '../types/attestation'
import type { IdentitySession } from '../types/identity-session'
import type { DidDocument } from '../protocol'

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

export interface ProfileVersionCache {
  getLastSeenProfileVersion(did: string): Promise<number | undefined>
  setLastSeenProfileVersion(did: string, version: number): Promise<void>
}

export class ProfileResourceRollbackError extends Error {
  constructor(
    readonly did: string,
    readonly fetchedVersion: number,
    readonly lastSeenVersion: number,
  ) {
    super(`Profile resource rollback detected for ${did}: fetched version ${fetchedVersion} is lower than last seen version ${lastSeenVersion}`)
    this.name = 'ProfileResourceRollbackError'
  }
}

export class LocalProfileVersionCache implements ProfileVersionCache {
  private readonly fallback = new Map<string, number>()

  constructor(private readonly keyPrefix = 'wot:profile-version:') {}

  async getLastSeenProfileVersion(did: string): Promise<number | undefined> {
    const stored = this.storage?.getItem(this.keyPrefix + did)
    const value = stored === null || stored === undefined ? this.fallback.get(did) : Number(stored)
    if (value === undefined) return undefined
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }

  async setLastSeenProfileVersion(did: string, version: number): Promise<void> {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error('Invalid profile version')
    }
    this.fallback.set(did, version)
    this.storage?.setItem(this.keyPrefix + did, String(version))
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

  // Resolve public data for a DID (verifies JWS signature)
  resolveProfile(did: string): Promise<ProfileResolveResult>
  resolveAttestations(did: string): Promise<Attestation[]>

  // Optional: batch summary for multiple DIDs (unsigned, server-derived counts)
  resolveSummaries?(dids: string[]): Promise<ProfileSummary[]>
}
