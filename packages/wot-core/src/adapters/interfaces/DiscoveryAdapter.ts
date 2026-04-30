import type { PublicProfile } from '../../types/identity'
import type { Verification } from '../../types/verification'
import type { Attestation } from '../../types/attestation'
import type { IdentitySession } from '../../application'

/**
 * Published verifications data — wraps an array of verifications
 * about a DID, signed by the DID owner as JWS.
 */
export interface PublicVerificationsData {
  did: string
  verifications: Verification[]
  updatedAt: string
}

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
  fromCache: boolean
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
  publishVerifications(data: PublicVerificationsData, identity: IdentitySession): Promise<void>
  publishAttestations(data: PublicAttestationsData, identity: IdentitySession): Promise<void>

  // Resolve public data for a DID (verifies JWS signature)
  resolveProfile(did: string): Promise<ProfileResolveResult>
  resolveVerifications(did: string): Promise<Verification[]>
  resolveAttestations(did: string): Promise<Attestation[]>

  // Optional: batch summary for multiple DIDs (unsigned, server-derived counts)
  resolveSummaries?(dids: string[]): Promise<ProfileSummary[]>
}
