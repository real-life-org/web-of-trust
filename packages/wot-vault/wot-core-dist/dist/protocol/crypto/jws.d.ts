import { ProtocolCryptoAdapter } from './ports';
import { JsonValue } from './jcs';
export interface DecodedJws<Header = Record<string, unknown>, Payload = Record<string, unknown>> {
    header: Header;
    payload: Payload;
    signingInput: Uint8Array;
    signature: Uint8Array;
}
export type JcsEd25519SignFn = (signingInput: Uint8Array) => Promise<Uint8Array>;
export interface VerifyJwsWithPublicKeyOptions {
    publicKey: Uint8Array;
    crypto: ProtocolCryptoAdapter;
}
export declare function decodeJws<Header = Record<string, unknown>, Payload = Record<string, unknown>>(jws: string): DecodedJws<Header, Payload>;
export declare function createJcsEd25519Jws(header: Record<string, JsonValue>, payload: JsonValue, signingSeed: Uint8Array): Promise<string>;
export declare function createJcsEd25519JwsWithSigner(header: Record<string, JsonValue>, payload: JsonValue, sign: JcsEd25519SignFn): Promise<string>;
export declare function verifyJwsWithPublicKey(jws: string, options: VerifyJwsWithPublicKeyOptions): Promise<DecodedJws>;
//# sourceMappingURL=jws.d.ts.map