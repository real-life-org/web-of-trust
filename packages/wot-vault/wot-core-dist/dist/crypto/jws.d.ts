/**
 * Sign data and return JWS compact serialization
 *
 * @param payload - The data to sign (will be JSON stringified)
 * @param privateKey - CryptoKey for signing (Ed25519)
 * @returns JWS compact serialization string (header.payload.signature)
 */
export declare function signJws(payload: unknown, privateKey: CryptoKey): Promise<string>;
/**
 * Verify a JWS signature
 *
 * @param jws - JWS compact serialization string
 * @param publicKey - CryptoKey for verification (Ed25519)
 * @returns Object with verification result and decoded payload
 */
export declare function verifyJws(jws: string, publicKey: CryptoKey): Promise<{
    valid: boolean;
    payload?: unknown;
    error?: string;
}>;
/**
 * Extract payload from JWS without verifying signature
 * Useful for debugging or when signature verification happens separately
 */
export declare function extractJwsPayload(jws: string): unknown | null;
//# sourceMappingURL=jws.d.ts.map