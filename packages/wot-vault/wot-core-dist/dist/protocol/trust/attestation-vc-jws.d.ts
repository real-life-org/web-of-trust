import { ProtocolCryptoAdapter } from '../crypto/ports';
import { JcsEd25519SignFn } from '../crypto/jws';
export interface AttestationVcPayload {
    '@context': string[];
    id?: string;
    type: string[];
    issuer: string;
    credentialSubject: {
        id: string;
        claim: string;
        [key: string]: unknown;
    };
    validFrom: string;
    iss: string;
    sub: string;
    nbf: number;
    jti?: string;
    iat?: number;
    exp?: number;
    [key: string]: unknown;
}
export interface CreateAttestationVcJwsOptions {
    payload: AttestationVcPayload;
    kid: string;
    signingSeed: Uint8Array;
}
export interface CreateAttestationVcJwsWithSignerOptions {
    payload: AttestationVcPayload;
    kid: string;
    sign: JcsEd25519SignFn;
}
export interface VerifyAttestationVcJwsOptions {
    crypto: ProtocolCryptoAdapter;
}
export declare function createAttestationVcJws(options: CreateAttestationVcJwsOptions): Promise<string>;
export declare function createAttestationVcJwsWithSigner(options: CreateAttestationVcJwsWithSignerOptions): Promise<string>;
export declare function verifyAttestationVcJws(jws: string, options: VerifyAttestationVcJwsOptions): Promise<AttestationVcPayload>;
//# sourceMappingURL=attestation-vc-jws.d.ts.map