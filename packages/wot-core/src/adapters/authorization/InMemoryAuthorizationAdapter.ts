import type { ResourceRef } from '../../types/resource-ref'
import type { AuthorizationAdapter } from '../../ports/AuthorizationAdapter'
import {
  createCapability,
  verifyCapability,
  delegateCapability,
  extractCapability,
  type CapabilityJws,
  type CapabilityVerificationResult,
  type Permission,
  type SignFn,
} from '../../crypto/capabilities'

/**
 * In-memory AuthorizationAdapter for testing and simple use cases.
 *
 * Stores capabilities and revocations in memory.
 * Requires a SignFn for creating/delegating capabilities.
 */
export class InMemoryAuthorizationAdapter implements AuthorizationAdapter {
  private myDid: string
  private sign: SignFn

  /** Capabilities granted TO this user (received from others) */
  private received: CapabilityJws[] = []

  /** Capabilities granted BY this user (issued to others) */
  private granted: CapabilityJws[] = []

  /** Revoked capability IDs */
  private revoked: Set<string> = new Set()

  constructor(myDid: string, sign: SignFn) {
    this.myDid = myDid
    this.sign = sign
  }

  async grant(
    resource: ResourceRef,
    toDid: string,
    permissions: Permission[],
    expiration: string,
  ): Promise<CapabilityJws> {
    const jws = await createCapability(
      {
        issuer: this.myDid,
        audience: toDid,
        resource,
        permissions,
        expiration,
      },
      this.sign,
    )
    this.granted.push(jws)
    return jws
  }

  async delegate(
    parentCapabilityJws: CapabilityJws,
    toDid: string,
    permissions: Permission[],
    expiration?: string,
  ): Promise<CapabilityJws> {
    const parent = extractCapability(parentCapabilityJws)
    if (!parent) throw new Error('Invalid parent capability')

    const exp = expiration ?? parent.expiration
    const jws = await delegateCapability(
      parentCapabilityJws,
      { audience: toDid, permissions, expiration: exp },
      this.sign,
    )
    this.granted.push(jws)
    return jws
  }

  async verify(capabilityJws: CapabilityJws): Promise<CapabilityVerificationResult> {
    const result = await verifyCapability(capabilityJws)
    if (!result.valid) return result

    // Check revocation for the capability and all ancestors in chain
    if (this.revoked.has(result.capability.id)) {
      return { valid: false, error: `Capability ${result.capability.id} has been revoked` }
    }
    for (const ancestor of result.chain) {
      if (this.revoked.has(ancestor.id)) {
        return { valid: false, error: `Ancestor capability ${ancestor.id} has been revoked` }
      }
    }

    return result
  }

  async canAccess(
    did: string,
    resource: ResourceRef,
    permission: Permission,
  ): Promise<boolean> {
    // Search all stored capabilities (received + granted)
    const allCapabilities = [...this.received, ...this.granted]

    for (const jws of allCapabilities) {
      const cap = extractCapability(jws)
      if (!cap) continue
      if (cap.audience !== did) continue
      if (cap.resource !== resource) continue
      if (!cap.permissions.includes(permission)) continue

      // Found a matching capability — verify it's still valid
      const result = await this.verify(jws)
      if (result.valid) return true
    }

    return false
  }

  async revoke(capabilityId: string): Promise<void> {
    this.revoked.add(capabilityId)
  }

  async isRevoked(capabilityId: string): Promise<boolean> {
    return this.revoked.has(capabilityId)
  }

  async store(capabilityJws: CapabilityJws): Promise<void> {
    this.received.push(capabilityJws)
  }

  async getMyCapabilities(resource?: ResourceRef): Promise<CapabilityJws[]> {
    if (!resource) return [...this.received]
    return this.received.filter(jws => {
      const cap = extractCapability(jws)
      return cap && cap.resource === resource
    })
  }

  async getGrantedCapabilities(resource?: ResourceRef): Promise<CapabilityJws[]> {
    if (!resource) return [...this.granted]
    return this.granted.filter(jws => {
      const cap = extractCapability(jws)
      return cap && cap.resource === resource
    })
  }
}
