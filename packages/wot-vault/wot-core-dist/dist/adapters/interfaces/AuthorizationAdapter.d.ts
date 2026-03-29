import { ResourceRef } from '../../types/resource-ref';
import { CapabilityJws, CapabilityVerificationResult, Permission } from '../../crypto/capabilities';
/**
 * AuthorizationAdapter — Stateful layer for capability management.
 *
 * Manages the lifecycle of capability tokens:
 * - Granting capabilities to other DIDs
 * - Storing received capabilities
 * - Querying who can access what
 * - Verifying access (signature + expiration + chain + revocation)
 * - Revoking capabilities
 *
 * The cryptographic primitives (create, verify, delegate) live in
 * crypto/capabilities.ts. This adapter adds state: storage, queries,
 * and revocation lists.
 *
 * Implementations:
 * - InMemoryAuthorizationAdapter (tests)
 * - AutomergeAuthorizationAdapter (Demo-App, stores in Personal-Doc)
 * - StatelessAuthorizationAdapter (wot-vault, verify-only)
 */
export interface AuthorizationAdapter {
    /** Grant a capability to another DID. Signs and stores it. */
    grant(resource: ResourceRef, toDid: string, permissions: Permission[], expiration: string): Promise<CapabilityJws>;
    /**
     * Delegate a received capability to another DID (attenuation only).
     * Permissions must be a subset of the parent's.
     * Expiration must be <= parent's.
     */
    delegate(parentCapabilityJws: CapabilityJws, toDid: string, permissions: Permission[], expiration?: string): Promise<CapabilityJws>;
    /**
     * Verify a capability: signature, expiration, chain, and revocation.
     * Returns the full decoded capability and chain on success.
     */
    verify(capabilityJws: CapabilityJws): Promise<CapabilityVerificationResult>;
    /**
     * Check if a DID can perform an action on a resource.
     * Convenience method that searches stored capabilities.
     */
    canAccess(did: string, resource: ResourceRef, permission: Permission): Promise<boolean>;
    /** Revoke a capability by ID. Only the issuer can revoke. */
    revoke(capabilityId: string): Promise<void>;
    /** Check if a capability ID has been revoked. */
    isRevoked(capabilityId: string): Promise<boolean>;
    /** Store a received capability (e.g. from a space invite). */
    store(capabilityJws: CapabilityJws): Promise<void>;
    /** Get all capabilities granted TO the current user. */
    getMyCapabilities(resource?: ResourceRef): Promise<CapabilityJws[]>;
    /** Get all capabilities granted BY the current user. */
    getGrantedCapabilities(resource?: ResourceRef): Promise<CapabilityJws[]>;
}
//# sourceMappingURL=AuthorizationAdapter.d.ts.map