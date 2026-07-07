import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { decodeJws } from '../crypto/jws'
import { didOrKidToDid, ed25519MultibaseToPublicKeyBytes } from './did-key'
import type { DidResolver } from './did-document'

export interface VerifyJwsByDidResolverOptions {
  didResolver: DidResolver
  crypto: ProtocolCryptoAdapter
  expectedDid?: string
}

export interface VerifyJwsByDidResolverResult {
  did: string
  payload: Record<string, unknown>
}

// Generic EdDSA-JWS verify over kid -> DidResolver. Deliberately carries no
// resource schema; consumers validate the payload shape themselves.
// VE-4: the payload DID is bound to the kid DID (and to expectedDid when set),
// so a signer for DID A cannot get a payload claiming did:B accepted.
//
// The verify mechanics (alg whitelist, kid resolve, verificationMethod match)
// are deliberately duplicated from profile-service-resource.ts; consolidation is
// scoped to the W3 adapter-audit slice, not here.
export async function verifyJwsByDidResolver(
  jws: string,
  options: VerifyJwsByDidResolverOptions,
): Promise<VerifyJwsByDidResolverResult> {
  const decoded = decodeJws(jws)
  if (typeof decoded.header !== 'object' || decoded.header === null) {
    throw new Error('Invalid JWS header')
  }
  const header = decoded.header as Record<string, unknown>
  if (header.alg !== 'EdDSA') throw new Error('Unsupported JWS alg')
  if (typeof header.kid !== 'string' || header.kid.length === 0) throw new Error('Missing JWS kid')

  const kidDid = didOrKidToDid(header.kid)
  if (options.expectedDid !== undefined && kidDid !== options.expectedDid) {
    throw new Error('JWS kid DID does not match expected DID')
  }

  if (typeof decoded.payload !== 'object' || decoded.payload === null || Array.isArray(decoded.payload)) {
    throw new Error('Invalid JWS payload')
  }
  const payload = decoded.payload as Record<string, unknown>
  if (typeof payload.did !== 'string' || payload.did.length === 0) {
    throw new Error('Missing payload DID')
  }
  if (payload.did !== kidDid) {
    throw new Error('JWS payload DID does not match kid DID')
  }

  const didDocument = await options.didResolver.resolve(kidDid)
  if (!didDocument) throw new Error('Unable to resolve DID')
  // Bind the resolved document to the requested DID, so a buggy/misconfigured
  // resolver cannot return a foreign document whose verificationMethod happens to
  // match the kid (mirrors the check in profile-service-resource.ts).
  if (didDocument.id !== kidDid) throw new Error('Resolved DID document does not match DID')

  const verificationMethod = didDocument.verificationMethod.find(
    (method) => method.id === header.kid || (method.id.startsWith('#') && `${kidDid}${method.id}` === header.kid),
  )
  if (!verificationMethod) throw new Error('Unable to resolve verification method')
  const publicKey = ed25519MultibaseToPublicKeyBytes(verificationMethod.publicKeyMultibase)

  const valid = await options.crypto.verifyEd25519(decoded.signingInput, decoded.signature, publicKey)
  if (!valid) throw new Error('Invalid JWS signature')

  return { did: kidDid, payload }
}
