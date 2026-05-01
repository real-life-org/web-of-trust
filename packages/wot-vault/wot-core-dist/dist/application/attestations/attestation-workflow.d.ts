import { IdentitySession } from '../identity';
import { Attestation } from '../../types/attestation';
import { AttestationVcPayload, ProtocolCryptoAdapter } from '../../protocol';
export interface AttestationWorkflowOptions {
    crypto: ProtocolCryptoAdapter;
    randomId?: () => string;
    now?: () => Date;
}
export interface CreateAttestationInput {
    issuer: IdentitySession;
    subjectDid: string;
    claim: string;
    tags?: string[];
}
export declare class AttestationWorkflow {
    private readonly crypto;
    private readonly randomId;
    private readonly now;
    constructor(options: AttestationWorkflowOptions);
    createAttestation(input: CreateAttestationInput): Promise<Attestation>;
    verifyAttestation(attestation: Attestation): Promise<boolean>;
    verifyAttestationVcJws(jws: string): Promise<AttestationVcPayload>;
    exportAttestation(attestation: Attestation): string;
    importAttestation(encoded: string): Promise<Attestation>;
    private createVcPayload;
    private attestationFromVcPayload;
    private payloadMatchesAttestation;
    private assertComplete;
}
//# sourceMappingURL=attestation-workflow.d.ts.map