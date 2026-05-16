import { JsonValue } from '../crypto/jcs';
import { ProtocolCryptoAdapter } from '../crypto/ports';
export interface VerifiedSdJwtVc {
    issuerKid: string;
    issuerPayload: Record<string, unknown>;
    disclosures: JsonValue[];
    disclosureDigests: string[];
}
export interface VerifySdJwtVcOptions {
    crypto: ProtocolCryptoAdapter;
}
export interface VerifyHmcTrustListSdJwtVcOptions extends VerifySdJwtVcOptions {
    expectedVct: string;
    now: Date;
}
export declare function encodeSdJwtDisclosure(disclosure: JsonValue): string;
export declare function digestSdJwtDisclosure(encodedDisclosure: string, cryptoAdapter: ProtocolCryptoAdapter): Promise<string>;
export declare function createSdJwtVcCompact(issuerSignedJwt: string, disclosures: JsonValue[]): string;
export declare function verifySdJwtVc(sdJwtCompact: string, options: VerifySdJwtVcOptions): Promise<VerifiedSdJwtVc>;
export declare function verifyHmcTrustListSdJwtVc(sdJwtCompact: string, options: VerifyHmcTrustListSdJwtVcOptions): Promise<VerifiedSdJwtVc>;
//# sourceMappingURL=sd-jwt-vc.d.ts.map