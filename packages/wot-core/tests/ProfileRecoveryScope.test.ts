import { describe, expect, it } from 'vitest'
import {
  PROFILE_RECOVERY_DATA_BOUNDARY,
  classifyProfileRecoveryArtifact,
  listProfileRecoveryVerificationGates,
} from '../src/protocol'

describe('Sync 004 profile-service recovery fallback scope', () => {
  const allowedArtifacts = [
    'did-document',
    'public-profile-data',
    'published-verifications',
    'deliberately-published-attestations',
    'did-document-keyAgreement',
    'did-document-service',
  ]

  const forbiddenArtifacts = [
    'private-wallet-state',
    'unpublished-received-attestations',
    'private-contacts-not-public-profile-derived',
    'space-content-keys',
    'space-membership-secrets',
    'personal-doc-only-state',
    'vault-secrets',
    'private-sync-state',
  ]

  it.each(allowedArtifacts)('allows public profile-service artifact %s', (artifact) => {
    expect(classifyProfileRecoveryArtifact(artifact)).toEqual({
      artifact,
      disposition: 'allowed',
      recoverySource: 'profile-service-fallback',
      dataBoundary: 'public-profile-discovery-data',
      canonicalReplacementFor: [],
      normativeDecision: 'real-life-org/wot-spec#19',
    })
  })

  it.each(forbiddenArtifacts)('forbids private or non-discovery artifact %s', (artifact) => {
    expect(classifyProfileRecoveryArtifact(artifact)).toEqual({
      artifact,
      disposition: 'forbidden',
      recoverySource: 'profile-service-fallback',
      dataBoundary: 'private-or-non-discovery-state',
      canonicalReplacementFor: [],
      normativeDecision: 'real-life-org/wot-spec#19',
    })
  })

  it('treats unknown artifacts as out of scope instead of allowing them by default', () => {
    expect(classifyProfileRecoveryArtifact('local-crdt-cache-snapshot')).toEqual({
      artifact: 'local-crdt-cache-snapshot',
      disposition: 'unknown',
      recoverySource: 'profile-service-fallback',
      dataBoundary: 'out-of-scope',
      canonicalReplacementFor: [],
      normativeDecision: 'real-life-org/wot-spec#19',
    })
  })

  it('lists the mandatory verification gates for profile-service recovery fallback', () => {
    expect(listProfileRecoveryVerificationGates()).toEqual([
      'jws-signature-verification',
      'did-path-consistency',
      'version-monotonicity',
    ])
  })

  it('makes recovered data explicitly public discovery data, not canonical private-state replacement', () => {
    expect(PROFILE_RECOVERY_DATA_BOUNDARY).toEqual({
      recoveredDataKind: 'public-profile-discovery-data',
      canonicalReplacementFor: [],
      notCanonicalReplacementFor: [
        'personal-doc',
        'vault',
        'private-wallet',
        'private-sync-state',
      ],
    })

    for (const artifact of allowedArtifacts) {
      expect(classifyProfileRecoveryArtifact(artifact)).toMatchObject({
        dataBoundary: PROFILE_RECOVERY_DATA_BOUNDARY.recoveredDataKind,
        canonicalReplacementFor: PROFILE_RECOVERY_DATA_BOUNDARY.canonicalReplacementFor,
      })
    }
  })

  it('returns a defensive canonicalReplacementFor list for allowed classifications', () => {
    const classification = classifyProfileRecoveryArtifact('did-document')
    const returnedCanonicalReplacements = classification.canonicalReplacementFor as string[]

    returnedCanonicalReplacements.push('personal-doc')

    expect(PROFILE_RECOVERY_DATA_BOUNDARY.canonicalReplacementFor).toEqual([])
    expect(classifyProfileRecoveryArtifact('did-document')).toMatchObject({
      canonicalReplacementFor: [],
    })
  })
})
