import { JsonValue } from '../crypto/jcs';
import { ProtocolCryptoAdapter } from '../crypto/ports';
export interface VerifiedSdJwtVc {
    issuerPayload: Record<string, unknown>;
    disclosures: JsonValue[];
    disclosureDigests: string[];
}
export interface VerifySdJwtVcOptions {
    crypto: ProtocolCryptoAdapter;
}
export declare function encodeSdJwtDisclosure(disclosure: JsonValue): string;
export declare function digestSdJwtDisclosure(encodedDisclosure: string, cryptoAdapter: ProtocolCryptoAdapter): Promise<string>;
export declare function createSdJwtVcCompact(issuerSignedJwt: string, disclosures: JsonValue[]): string;
export declare function verifySdJwtVc(sdJwtCompact: string, options: VerifySdJwtVcOptions): Promise<VerifiedSdJwtVc>;
//# sourceMappingURL=sd-jwt-vc.d.ts.map