import { ResourceRef } from '../types/resource-ref';
export type Permission = 'read' | 'write' | 'delete' | 'delegate';
export interface Capability {
    id: string;
    issuer: string;
    audience: string;
    resource: ResourceRef;
    permissions: Permission[];
    expiration: string;
    proof?: string;
}
/** A capability encoded as JWS (signed by the issuer) */
export type CapabilityJws = string;
export interface VerifiedCapability {
    valid: true;
    capability: Capability;
    chain: Capability[];
}
export interface CapabilityError {
    valid: false;
    error: string;
}
export type CapabilityVerificationResult = VerifiedCapability | CapabilityError;
/**
 * Sign function — signs a payload and returns JWS compact serialization.
 * Typically provided by WotIdentity.signJws.bind(identity).
 */
export type SignFn = (payload: unknown) => Promise<string>;
/**
 * Create and sign a capability token.
 *
 * @param params - Capability parameters
 * @param sign - Sign function (e.g. identity.signJws.bind(identity))
 * @returns Signed capability as JWS string
 */
export declare function createCapability(params: {
    issuer: string;
    audience: string;
    resource: ResourceRef;
    permissions: Permission[];
    expiration: string;
}, sign: SignFn): Promise<CapabilityJws>;
/**
 * Verify a capability JWS: signature, expiration, and delegation chain.
 *
 * Verification checks:
 * 1. JWS signature is valid (issuer's Ed25519 key from did:key)
 * 2. Capability has not expired
 * 3. If delegated (has proof): parent chain is valid and permissions are attenuated
 *
 * @param capabilityJws - The signed capability token
 * @param now - Current time for expiration check (default: new Date())
 * @returns Verification result with decoded capability or error
 */
export declare function verifyCapability(capabilityJws: CapabilityJws, now?: Date): Promise<CapabilityVerificationResult>;
/**
 * Extract a capability from a JWS without verifying the signature.
 * Useful for inspecting tokens or debugging.
 */
export declare function extractCapability(capabilityJws: CapabilityJws): Capability | null;
/**
 * Create a delegated capability with attenuated permissions.
 *
 * The new capability:
 * - Has the delegator as issuer (= audience of parent)
 * - Can only have a subset of the parent's permissions
 * - Cannot expire later than the parent
 * - Carries the parent JWS as proof
 *
 * @param parentCapabilityJws - The parent capability (must include 'delegate' permission)
 * @param params - Delegation parameters
 * @param sign - Sign function of the delegator (audience of parent)
 * @returns Signed delegated capability as JWS
 */
export declare function delegateCapability(parentCapabilityJws: CapabilityJws, params: {
    audience: string;
    permissions: Permission[];
    expiration: string;
}, sign: SignFn): Promise<CapabilityJws>;
//# sourceMappingURL=capabilities.d.ts.map