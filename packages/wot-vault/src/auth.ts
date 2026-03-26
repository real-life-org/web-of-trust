import {
  verifyCapability,
  extractCapability,
  extractJwsPayload,
  verifyJws,
  didToPublicKeyBytes,
} from '@web.of.trust/core'
import type { Permission } from '@web.of.trust/core'
import type { IncomingMessage } from 'http'

/**
 * Auth result from verifying a request.
 */
export interface AuthResult {
  authenticated: boolean
  did?: string
  error?: string
}

/**
 * Capability auth result — extends AuthResult with permission check.
 */
export interface CapabilityAuthResult extends AuthResult {
  authorized: boolean
}

/**
 * Verify the identity of a request sender.
 *
 * Checks the Authorization header for a Bearer JWS token:
 *   Authorization: Bearer <JWS>
 *
 * The JWS payload must contain: { did: string, iat: number }
 * The signature is verified against the public key from did:key.
 * Token validity: 5 minutes from iat.
 */
export async function verifyIdentity(req: IncomingMessage): Promise<AuthResult> {
  const authHeader = req.headers['authorization']
  if (!authHeader?.startsWith('Bearer ')) {
    return { authenticated: false, error: 'Missing Authorization header' }
  }

  const token = authHeader.slice(7)

  // Extract payload to get DID
  const payload = extractJwsPayload(token) as {
    did?: string
    iat?: number
  } | null

  if (!payload?.did) {
    return { authenticated: false, error: 'Invalid token: missing did' }
  }

  if (!payload.iat) {
    return { authenticated: false, error: 'Invalid token: missing iat' }
  }

  // Check token age (5 minute window)
  const now = Date.now() / 1000
  const age = now - payload.iat
  if (age < -60 || age > 300) {
    return { authenticated: false, error: 'Token expired or clock skew too large' }
  }

  // Verify signature against did:key
  let publicKey: CryptoKey
  try {
    const publicKeyBytes = didToPublicKeyBytes(payload.did)
    publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      true,
      ['verify'],
    )
  } catch {
    return { authenticated: false, error: `Cannot resolve DID: ${payload.did}` }
  }

  const result = await verifyJws(token, publicKey)
  if (!result.valid) {
    return { authenticated: false, error: `Invalid signature: ${result.error}` }
  }

  return { authenticated: true, did: payload.did }
}

/**
 * Verify that a request has a valid capability for a document.
 *
 * Checks:
 * 1. Identity (Authorization header) — who is making the request?
 * 2. Capability (X-Capability header) — do they have permission?
 * 3. The capability's audience matches the authenticated DID
 * 4. The capability's resource matches the requested docId
 * 5. The capability includes the required permission
 */
export async function verifyAccess(
  req: IncomingMessage,
  docId: string,
  requiredPermission: Permission,
): Promise<CapabilityAuthResult> {
  // 1. Verify identity
  const identity = await verifyIdentity(req)
  if (!identity.authenticated) {
    return { ...identity, authorized: false }
  }

  // 2. Get capability from header
  const capabilityJws = req.headers['x-capability'] as string | undefined
  if (!capabilityJws) {
    return {
      authenticated: true,
      did: identity.did,
      authorized: false,
      error: 'Missing X-Capability header',
    }
  }

  // 3. Verify capability cryptographically
  const capResult = await verifyCapability(capabilityJws)
  if (!capResult.valid) {
    return {
      authenticated: true,
      did: identity.did,
      authorized: false,
      error: `Invalid capability: ${capResult.error}`,
    }
  }

  const cap = capResult.capability

  // 4. Check audience matches authenticated DID
  if (cap.audience !== identity.did) {
    return {
      authenticated: true,
      did: identity.did,
      authorized: false,
      error: 'Capability audience does not match authenticated DID',
    }
  }

  // 5. Check resource matches docId
  // Capability resource format: wot:space:<spaceId>
  // We accept if the resource contains the docId or matches exactly
  const capDoc = extractCapability(capabilityJws)
  if (!capDoc) {
    return {
      authenticated: true,
      did: identity.did,
      authorized: false,
      error: 'Cannot extract capability',
    }
  }

  // Resource must reference the document being accessed
  // Format: wot:space:<docId> or wot:space:<spaceId> where spaceId maps to docId
  if (!cap.resource.includes(docId)) {
    return {
      authenticated: true,
      did: identity.did,
      authorized: false,
      error: `Capability resource (${cap.resource}) does not match document (${docId})`,
    }
  }

  // 6. Check permission
  if (!cap.permissions.includes(requiredPermission)) {
    return {
      authenticated: true,
      did: identity.did,
      authorized: false,
      error: `Missing permission: ${requiredPermission}`,
    }
  }

  return {
    authenticated: true,
    did: identity.did,
    authorized: true,
  }
}
