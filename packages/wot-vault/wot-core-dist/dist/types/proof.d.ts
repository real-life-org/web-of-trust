/**
 * Cryptographic proof for signed documents
 * Based on W3C Data Integrity 1.0
 */
export interface Proof {
    type: 'Ed25519Signature2020';
    verificationMethod: string;
    created: string;
    proofPurpose: 'assertionMethod' | 'authentication';
    proofValue: string;
}
//# sourceMappingURL=proof.d.ts.map