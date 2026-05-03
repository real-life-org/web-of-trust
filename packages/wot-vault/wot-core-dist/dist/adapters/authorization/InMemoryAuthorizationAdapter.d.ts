import { ResourceRef } from '../../types/resource-ref';
import { AuthorizationAdapter } from '../../ports/AuthorizationAdapter';
import { CapabilityJws, CapabilityVerificationResult, Permission, SignFn } from '../../crypto/capabilities';
/**
 * In-memory AuthorizationAdapter for testing and simple use cases.
 *
 * Stores capabilities and revocations in memory.
 * Requires a SignFn for creating/delegating capabilities.
 */
export declare class InMemoryAuthorizationAdapter implements AuthorizationAdapter {
    private myDid;
    private sign;
    /** Capabilities granted TO this user (received from others) */
    private received;
    /** Capabilities granted BY this user (issued to others) */
    private granted;
    /** Revoked capability IDs */
    private revoked;
    constructor(myDid: string, sign: SignFn);
    grant(resource: ResourceRef, toDid: string, permissions: Permission[], expiration: string): Promise<CapabilityJws>;
    delegate(parentCapabilityJws: CapabilityJws, toDid: string, permissions: Permission[], expiration?: string): Promise<CapabilityJws>;
    verify(capabilityJws: CapabilityJws): Promise<CapabilityVerificationResult>;
    canAccess(did: string, resource: ResourceRef, permission: Permission): Promise<boolean>;
    revoke(capabilityId: string): Promise<void>;
    isRevoked(capabilityId: string): Promise<boolean>;
    store(capabilityJws: CapabilityJws): Promise<void>;
    getMyCapabilities(resource?: ResourceRef): Promise<CapabilityJws[]>;
    getGrantedCapabilities(resource?: ResourceRef): Promise<CapabilityJws[]>;
}
//# sourceMappingURL=InMemoryAuthorizationAdapter.d.ts.map