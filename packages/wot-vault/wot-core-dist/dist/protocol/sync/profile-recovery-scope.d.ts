export type ProfileRecoveryArtifactDisposition = 'allowed' | 'forbidden' | 'unknown';
export type ProfileRecoveryArtifactDataBoundary = 'public-profile-discovery-data' | 'private-or-non-discovery-state' | 'out-of-scope';
export type ProfileRecoveryVerificationGate = 'jws-signature-verification' | 'did-path-consistency' | 'version-monotonicity';
export interface ProfileRecoveryArtifactClassification {
    artifact: string;
    disposition: ProfileRecoveryArtifactDisposition;
    recoverySource: 'profile-service-fallback';
    dataBoundary: ProfileRecoveryArtifactDataBoundary;
    canonicalReplacementFor: readonly string[];
    normativeDecision: 'real-life-org/wot-spec#19';
}
export declare const PROFILE_RECOVERY_DATA_BOUNDARY: {
    readonly recoveredDataKind: "public-profile-discovery-data";
    readonly canonicalReplacementFor: readonly [];
    readonly notCanonicalReplacementFor: readonly ["personal-doc", "vault", "private-wallet", "private-sync-state"];
};
declare const ALLOWED_PROFILE_RECOVERY_ARTIFACTS: readonly ["did-document", "public-profile-data", "published-verifications", "deliberately-published-attestations", "did-document-keyAgreement", "did-document-service"];
declare const FORBIDDEN_PROFILE_RECOVERY_ARTIFACTS: readonly ["private-wallet-state", "unpublished-received-attestations", "private-contacts-not-public-profile-derived", "space-content-keys", "space-membership-secrets", "personal-doc-only-state", "vault-secrets", "private-sync-state"];
export type ProfileRecoveryArtifact = (typeof ALLOWED_PROFILE_RECOVERY_ARTIFACTS)[number] | (typeof FORBIDDEN_PROFILE_RECOVERY_ARTIFACTS)[number];
export declare function classifyProfileRecoveryArtifact(artifact: string): ProfileRecoveryArtifactClassification;
export declare function listProfileRecoveryVerificationGates(): ProfileRecoveryVerificationGate[];
export {};
//# sourceMappingURL=profile-recovery-scope.d.ts.map