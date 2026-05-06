export type ProfileRecoveryArtifactDisposition = 'allowed' | 'forbidden' | 'unknown'

export type ProfileRecoveryArtifactDataBoundary =
  | 'public-profile-discovery-data'
  | 'private-or-non-discovery-state'
  | 'out-of-scope'

export type ProfileRecoveryVerificationGate =
  | 'jws-signature-verification'
  | 'did-path-consistency'
  | 'version-monotonicity'

export interface ProfileRecoveryArtifactClassification {
  artifact: string
  disposition: ProfileRecoveryArtifactDisposition
  recoverySource: 'profile-service-fallback'
  dataBoundary: ProfileRecoveryArtifactDataBoundary
  canonicalReplacementFor: readonly string[]
  normativeDecision: 'real-life-org/wot-spec#19'
}

export const PROFILE_RECOVERY_DATA_BOUNDARY = {
  recoveredDataKind: 'public-profile-discovery-data',
  canonicalReplacementFor: [],
  notCanonicalReplacementFor: [
    'personal-doc',
    'vault',
    'private-wallet',
    'private-sync-state',
  ],
} as const

const PROFILE_RECOVERY_SOURCE = 'profile-service-fallback' as const
const PROFILE_RECOVERY_NORMATIVE_DECISION = 'real-life-org/wot-spec#19' as const

const ALLOWED_PROFILE_RECOVERY_ARTIFACTS = [
  'did-document',
  'public-profile-data',
  'published-verifications',
  'deliberately-published-attestations',
  'did-document-keyAgreement',
  'did-document-service',
] as const

const FORBIDDEN_PROFILE_RECOVERY_ARTIFACTS = [
  'private-wallet-state',
  'unpublished-received-attestations',
  'private-contacts-not-public-profile-derived',
  'space-content-keys',
  'space-membership-secrets',
  'personal-doc-only-state',
  'vault-secrets',
  'private-sync-state',
] as const

export type ProfileRecoveryArtifact =
  | (typeof ALLOWED_PROFILE_RECOVERY_ARTIFACTS)[number]
  | (typeof FORBIDDEN_PROFILE_RECOVERY_ARTIFACTS)[number]

const PROFILE_RECOVERY_VERIFICATION_GATES: readonly ProfileRecoveryVerificationGate[] = [
  'jws-signature-verification',
  'did-path-consistency',
  'version-monotonicity',
]

export function classifyProfileRecoveryArtifact(artifact: string): ProfileRecoveryArtifactClassification {
  if ((ALLOWED_PROFILE_RECOVERY_ARTIFACTS as readonly string[]).includes(artifact)) {
    return {
      artifact,
      disposition: 'allowed',
      recoverySource: PROFILE_RECOVERY_SOURCE,
      dataBoundary: PROFILE_RECOVERY_DATA_BOUNDARY.recoveredDataKind,
      canonicalReplacementFor: [...PROFILE_RECOVERY_DATA_BOUNDARY.canonicalReplacementFor],
      normativeDecision: PROFILE_RECOVERY_NORMATIVE_DECISION,
    }
  }

  if ((FORBIDDEN_PROFILE_RECOVERY_ARTIFACTS as readonly string[]).includes(artifact)) {
    return {
      artifact,
      disposition: 'forbidden',
      recoverySource: PROFILE_RECOVERY_SOURCE,
      dataBoundary: 'private-or-non-discovery-state',
      canonicalReplacementFor: [],
      normativeDecision: PROFILE_RECOVERY_NORMATIVE_DECISION,
    }
  }

  return {
    artifact,
    disposition: 'unknown',
    recoverySource: PROFILE_RECOVERY_SOURCE,
    dataBoundary: 'out-of-scope',
    canonicalReplacementFor: [],
    normativeDecision: PROFILE_RECOVERY_NORMATIVE_DECISION,
  }
}

export function listProfileRecoveryVerificationGates(): ProfileRecoveryVerificationGate[] {
  return [...PROFILE_RECOVERY_VERIFICATION_GATES]
}
