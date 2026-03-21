/**
 * Capability Primitives — Create, verify, and delegate capability tokens.
 *
 * A Capability is a signed token granting a DID specific permissions
 * on a resource. Capabilities are:
 * - Offline-verifiable (Ed25519 signature via did:key)
 * - Delegatable (with attenuation — can only restrict, never expand)
 * - Chainable (proof chains: Alice → Bob → Carl)
 * - Expiring (mandatory expiration, no eternal tokens)
 *
 * These are pure protocol functions (like signJws, createDid) — not an adapter.
 * The AuthorizationAdapter uses these for stateful operations (storage, queries).
 *
 * Inspired by UCAN and Willow/Meadowcap.
 */

import { verifyJws, extractJwsPayload } from './jws'
import { didToPublicKeyBytes } from './did'
import type { ResourceRef } from '../types/resource-ref'

// --- Types ---

export type Permission = 'read' | 'write' | 'delete' | 'delegate'

export interface Capability {
  id: string
  issuer: string          // DID of the granter
  audience: string        // DID of the recipient
  resource: ResourceRef   // wot:<type>:<id>[/<sub-path>]
  permissions: Permission[]
  expiration: string      // ISO 8601 — mandatory
  proof?: string          // JWS of the parent capability (for delegation chains)
}

/** A capability encoded as JWS (signed by the issuer) */
export type CapabilityJws = string

export interface VerifiedCapability {
  valid: true
  capability: Capability
  chain: Capability[]     // Full delegation chain (root first)
}

export interface CapabilityError {
  valid: false
  error: string
}

export type CapabilityVerificationResult = VerifiedCapability | CapabilityError

/**
 * Sign function — signs a payload and returns JWS compact serialization.
 * Typically provided by WotIdentity.signJws.bind(identity).
 */
export type SignFn = (payload: unknown) => Promise<string>

// --- Create ---

/**
 * Create and sign a capability token.
 *
 * @param params - Capability parameters
 * @param sign - Sign function (e.g. identity.signJws.bind(identity))
 * @returns Signed capability as JWS string
 */
export async function createCapability(
  params: {
    issuer: string
    audience: string
    resource: ResourceRef
    permissions: Permission[]
    expiration: string
  },
  sign: SignFn,
): Promise<CapabilityJws> {
  const capability: Capability = {
    id: crypto.randomUUID(),
    issuer: params.issuer,
    audience: params.audience,
    resource: params.resource,
    permissions: [...params.permissions].sort(),
    expiration: params.expiration,
  }

  return sign(capability)
}

// --- Verify ---

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
export async function verifyCapability(
  capabilityJws: CapabilityJws,
  now?: Date,
): Promise<CapabilityVerificationResult> {
  const currentTime = now ?? new Date()

  // 1. Extract payload to get issuer DID
  const rawPayload = extractJwsPayload(capabilityJws)
  if (!rawPayload || typeof rawPayload !== 'object') {
    return { valid: false, error: 'Invalid capability: cannot extract payload' }
  }

  const capability = rawPayload as Capability

  // 2. Validate required fields
  const fieldError = validateCapabilityFields(capability)
  if (fieldError) {
    return { valid: false, error: fieldError }
  }

  // 3. Check expiration
  const expiry = new Date(capability.expiration)
  if (isNaN(expiry.getTime())) {
    return { valid: false, error: 'Invalid expiration date' }
  }
  if (currentTime >= expiry) {
    return { valid: false, error: 'Capability has expired' }
  }

  // 4. Import issuer's public key from did:key and verify signature
  let publicKey: CryptoKey
  try {
    const publicKeyBytes = didToPublicKeyBytes(capability.issuer)
    publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      true,
      ['verify'],
    )
  } catch {
    return { valid: false, error: `Cannot resolve issuer DID: ${capability.issuer}` }
  }

  const jwsResult = await verifyJws(capabilityJws, publicKey)
  if (!jwsResult.valid) {
    return { valid: false, error: `Invalid signature: ${jwsResult.error}` }
  }

  // 5. If delegated, verify the proof chain
  const chain: Capability[] = []
  if (capability.proof) {
    const parentResult = await verifyCapability(capability.proof, now)
    if (!parentResult.valid) {
      return { valid: false, error: `Invalid delegation chain: ${parentResult.error}` }
    }

    const parent = parentResult.capability

    // Attenuation check: audience of parent must be issuer of child
    if (parent.audience !== capability.issuer) {
      return {
        valid: false,
        error: `Delegation chain broken: parent audience (${parent.audience}) !== child issuer (${capability.issuer})`,
      }
    }

    // Attenuation check: resource must match
    if (parent.resource !== capability.resource) {
      return {
        valid: false,
        error: `Delegation resource mismatch: parent (${parent.resource}) !== child (${capability.resource})`,
      }
    }

    // Attenuation check: permissions must be subset
    const parentPerms = new Set(parent.permissions)
    for (const perm of capability.permissions) {
      if (!parentPerms.has(perm)) {
        return {
          valid: false,
          error: `Permission escalation: "${perm}" not in parent permissions [${parent.permissions.join(', ')}]`,
        }
      }
    }

    // Attenuation check: expiration must be <= parent
    const parentExpiry = new Date(parent.expiration)
    if (expiry > parentExpiry) {
      return {
        valid: false,
        error: 'Delegated capability expires after parent',
      }
    }

    // Parent must allow delegation
    if (!parent.permissions.includes('delegate')) {
      return {
        valid: false,
        error: 'Parent capability does not include "delegate" permission',
      }
    }

    chain.push(...parentResult.chain, parent)
  }

  return { valid: true, capability, chain }
}

/**
 * Extract a capability from a JWS without verifying the signature.
 * Useful for inspecting tokens or debugging.
 */
export function extractCapability(capabilityJws: CapabilityJws): Capability | null {
  const payload = extractJwsPayload(capabilityJws)
  if (!payload || typeof payload !== 'object') return null
  return payload as Capability
}

// --- Delegate ---

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
export async function delegateCapability(
  parentCapabilityJws: CapabilityJws,
  params: {
    audience: string
    permissions: Permission[]
    expiration: string
  },
  sign: SignFn,
): Promise<CapabilityJws> {
  // Extract parent to get resource and validate
  const parent = extractCapability(parentCapabilityJws)
  if (!parent) {
    throw new Error('Invalid parent capability')
  }

  // Check parent has delegate permission
  if (!parent.permissions.includes('delegate')) {
    throw new Error('Parent capability does not include "delegate" permission')
  }

  // Attenuation: permissions must be subset of parent
  const parentPerms = new Set(parent.permissions)
  for (const perm of params.permissions) {
    if (!parentPerms.has(perm)) {
      throw new Error(`Cannot delegate permission "${perm}" — not in parent [${parent.permissions.join(', ')}]`)
    }
  }

  // Attenuation: expiration must be <= parent
  const parentExpiry = new Date(parent.expiration)
  const childExpiry = new Date(params.expiration)
  if (childExpiry > parentExpiry) {
    throw new Error('Delegated capability cannot expire after parent')
  }

  const capability: Capability = {
    id: crypto.randomUUID(),
    issuer: parent.audience, // Delegator is the audience of the parent
    audience: params.audience,
    resource: parent.resource,
    permissions: [...params.permissions].sort(),
    expiration: params.expiration,
    proof: parentCapabilityJws,
  }

  return sign(capability)
}

// --- Helpers ---

function validateCapabilityFields(cap: Partial<Capability>): string | null {
  if (!cap.id) return 'Missing field: id'
  if (!cap.issuer) return 'Missing field: issuer'
  if (!cap.audience) return 'Missing field: audience'
  if (!cap.resource) return 'Missing field: resource'
  if (!cap.permissions || !Array.isArray(cap.permissions) || cap.permissions.length === 0) {
    return 'Missing or empty field: permissions'
  }
  if (!cap.expiration) return 'Missing field: expiration'

  const validPerms: Set<string> = new Set(['read', 'write', 'delete', 'delegate'])
  for (const perm of cap.permissions) {
    if (!validPerms.has(perm)) {
      return `Invalid permission: "${perm}"`
    }
  }

  return null
}
