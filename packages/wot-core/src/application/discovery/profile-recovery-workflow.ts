import type { Attestation } from '../../types/attestation'
import type { PublicProfile } from '../../types/identity'
import type { DidDocument, ProfileServiceResourceKind } from '../../protocol'
import { classifyProfileRecoveryArtifact } from '../../protocol'
import type { DiscoveryAdapter, ProfileVersionCache } from '../../ports/DiscoveryAdapter'

/**
 * Sync 004 Recovery-Fallback (Z.207-220) — application workflow.
 *
 * Reconstructs ONLY public profile/discovery data from the profile service when
 * Vault / Personal Doc / CRDT state is unreachable after an identity recovery
 * (Mnemonic → Seed → DID). The DARF-NICHT catalogue (Z.218: private wallet
 * state, unpublished received attestations, private contacts, space content
 * keys, space-membership secrets, Personal-Doc-only state, vault secrets) is
 * enforced STRUCTURALLY: this module imports no private-state path and never
 * touches Wallet/Vault/Personal-Doc storage. Each recoverable artifact is run
 * through `classifyProfileRecoveryArtifact` — only `allowed` classifications are
 * carried into the result.
 *
 * Z.220 (MUSS): no special fetches. All checks (JWS verify, did↔path,
 * version-monotonicity / rollback) run through the adapter's NORMAL resolve
 * paths. A rollback during recovery propagates as an error and is never
 * swallowed.
 *
 * Z.220 (data boundary): recovered data is PUBLIC profile/discovery data only.
 * It is NOT a canonical replacement for the Personal Doc or the Vault. The
 * consumer (Step 6) re-imports the recovered attestations/verifications with
 * `accepted: true`, but the workflow itself draws no private state and is not a
 * source of truth for it.
 */

export type RecoverableProfileArtifact =
  | 'did-document'
  | 'public-profile-data'
  | 'did-document-keyAgreement'
  | 'did-document-service'
  | 'published-verifications'
  | 'deliberately-published-attestations'

/** A reconstructed resource with its discovery-service provenance + version. */
export interface RecoveredResource<T> {
  /** The reconstructed payload. */
  value: T
  /** Provenance is always the profile-service fallback (Sync 004 Z.208). */
  source: 'profile-service-fallback'
  /**
   * The resource `version` recorded by the adapter's resolve path (Sync 004
   * Z.181 per-resource monotonic counter), or `undefined` when the resource was
   * absent (404). Read from the version cache the resolve path just wrote — no
   * extra fetch (Z.220).
   */
  version: number | undefined
}

export interface ProfileRecoveryResult {
  did: string
  /** Recovered DID document (Z.211 allowed), or null when no `/p` exists. */
  didDocument: RecoveredResource<DidDocument> | null
  /** Recovered public profile data (Z.212 allowed), or null when no `/p` exists. */
  profile: RecoveredResource<PublicProfile> | null
  /** Deliberately published verification-attestations (`/v`, Z.213 allowed). */
  verifications: RecoveredResource<Attestation[]>
  /** Deliberately published attestations (`/a`, Z.214 allowed). */
  attestations: RecoveredResource<Attestation[]>
  /**
   * The artifact classifications that passed the `allowed` guard for this run.
   * Documents the structural DARF/DARF-NICHT enforcement (classify-guard) for
   * auditing; only `allowed` artifacts are ever reconstructed.
   */
  recoveredArtifacts: readonly RecoverableProfileArtifact[]
}

export interface ProfileRecoveryWorkflowDeps {
  discovery: Pick<DiscoveryAdapter, 'resolveProfile' | 'resolveVerifications' | 'resolveAttestations'>
  /**
   * The SAME resource-dimensional version cache the discovery adapter writes on
   * resolve (Sync 004 Z.181). The workflow only READS it to surface each
   * resource's version into the result — it performs no monotonicity logic of
   * its own (that lives in the resolve path, Z.220).
   */
  versionCache: ProfileVersionCache
}

export interface ProfileRecoveryWorkflow {
  /**
   * Reconstruct the public profile/discovery state for `did` from the profile
   * service. Resolves `/p`, `/v`, `/a` via the adapter's normal paths, runs each
   * artifact through the `allowed`-only classify guard, and returns the
   * recoverable artifacts with their source + version. A 404 profile yields an
   * empty (but non-throwing) result; a rollback during any resolve propagates.
   */
  recoverPublicState(did: string): Promise<ProfileRecoveryResult>
}

/**
 * Guard: an artifact may only enter the result when
 * `classifyProfileRecoveryArtifact` returns `disposition === 'allowed'`. This is
 * the single chokepoint that makes the Z.218 DARF-NICHT catalogue structurally
 * unreachable — a forbidden (or unknown) artifact name can never be carried.
 */
function isAllowed(artifact: string): boolean {
  return classifyProfileRecoveryArtifact(artifact).disposition === 'allowed'
}

export function createProfileRecoveryWorkflow(deps: ProfileRecoveryWorkflowDeps): ProfileRecoveryWorkflow {
  const { discovery, versionCache } = deps

  const readVersion = async (did: string, resource: ProfileServiceResourceKind): Promise<number | undefined> => {
    // The resolve path already wrote the last-seen version (Z.181). We only read
    // it back to expose provenance — no extra discovery fetch (Z.220).
    return versionCache.getLastSeenVersion(did, resource)
  }

  return {
    async recoverPublicState(did: string): Promise<ProfileRecoveryResult> {
      const recoveredArtifacts: RecoverableProfileArtifact[] = []

      // 1. /p — DID document + public profile data (incl. keyAgreement/service).
      //    Resolve throws on rollback (Z.220); we do NOT swallow it.
      const profileResult = await discovery.resolveProfile(did)
      const profileVersion = profileResult.profile !== null ? await readVersion(did, 'profile') : undefined

      let profile: RecoveredResource<PublicProfile> | null = null
      let didDocument: RecoveredResource<DidDocument> | null = null

      if (profileResult.profile !== null && isAllowed('public-profile-data')) {
        profile = { value: profileResult.profile, source: 'profile-service-fallback', version: profileVersion }
        recoveredArtifacts.push('public-profile-data')
      }
      if (profileResult.didDocument && isAllowed('did-document')) {
        didDocument = { value: profileResult.didDocument, source: 'profile-service-fallback', version: profileVersion }
        recoveredArtifacts.push('did-document')
        // keyAgreement/service are part of the DID document and are themselves
        // allowed artifacts (Z.215/216) — record them as recovered when present.
        if (profileResult.didDocument.keyAgreement && isAllowed('did-document-keyAgreement')) {
          recoveredArtifacts.push('did-document-keyAgreement')
        }
        if (profileResult.didDocument.service && isAllowed('did-document-service')) {
          recoveredArtifacts.push('did-document-service')
        }
      }

      // 2. /v + /a — published VC lists. The adapter returns the already-derived,
      //    already-verified, disjointly-filtered Attestation[] form (Step 3).
      //    Rollback on either resolve propagates (Z.220).
      const verificationsList = isAllowed('published-verifications')
        ? await discovery.resolveVerifications(did)
        : []
      const verificationsVersion = await readVersion(did, 'verifications')
      if (isAllowed('published-verifications')) {
        recoveredArtifacts.push('published-verifications')
      }

      const attestationsList = isAllowed('deliberately-published-attestations')
        ? await discovery.resolveAttestations(did)
        : []
      const attestationsVersion = await readVersion(did, 'attestations')
      if (isAllowed('deliberately-published-attestations')) {
        recoveredArtifacts.push('deliberately-published-attestations')
      }

      return {
        did,
        didDocument,
        profile,
        verifications: {
          value: verificationsList,
          source: 'profile-service-fallback',
          version: verificationsVersion,
        },
        attestations: {
          value: attestationsList,
          source: 'profile-service-fallback',
          version: attestationsVersion,
        },
        recoveredArtifacts,
      }
    },
  }
}
