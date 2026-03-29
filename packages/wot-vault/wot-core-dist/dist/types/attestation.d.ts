import { Proof } from './proof';
/**
 * An attestation is a signed statement about someone.
 * Like a gift - the sender gives, the recipient decides to accept.
 *
 * Empfänger-Prinzip: Stored at the recipient (to).
 * Only the sender (from) signs. The recipient controls visibility via metadata.
 *
 * Example: Anna attests "Ben helped in the garden"
 * - Anna creates: { from: anna, to: ben, claim: "...", proof: anna_sig }
 * - Stored at: Ben
 * - Ben decides: accepted = true/false (via AttestationMetadata)
 */
export interface Attestation {
    id: string;
    from: string;
    to: string;
    claim: string;
    tags?: string[];
    context?: string;
    createdAt: string;
    proof: Proof;
}
/**
 * Local metadata for attestations (not signed, not synced)
 * Controlled entirely by the recipient
 */
export interface AttestationMetadata {
    attestationId: string;
    accepted: boolean;
    acceptedAt?: string;
}
//# sourceMappingURL=attestation.d.ts.map