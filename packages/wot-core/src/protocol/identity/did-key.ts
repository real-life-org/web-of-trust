import { decodeBase58, encodeBase58 } from '../crypto/encoding'
import type { DidDocument, DidResolver } from './did-document'

const ED25519_PREFIX = new Uint8Array([0xed, 0x01])
const X25519_PREFIX = new Uint8Array([0xec, 0x01])
const PUBLIC_KEY_LENGTH = 32

class DidKeyValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DidKeyValidationError'
  }
}

export function publicKeyToDidKey(publicKey: Uint8Array): string {
  return `did:key:${ed25519PublicKeyToMultibase(publicKey)}`
}

export function ed25519PublicKeyToMultibase(publicKey: Uint8Array): string {
  assertPublicKeyLength(publicKey, 'Ed25519')
  const prefixed = new Uint8Array(ED25519_PREFIX.length + publicKey.length)
  prefixed.set(ED25519_PREFIX)
  prefixed.set(publicKey, ED25519_PREFIX.length)
  return `z${encodeBase58(prefixed)}`
}

export function x25519PublicKeyToMultibase(publicKey: Uint8Array): string {
  assertPublicKeyLength(publicKey, 'X25519')
  const prefixed = new Uint8Array(X25519_PREFIX.length + publicKey.length)
  prefixed.set(X25519_PREFIX)
  prefixed.set(publicKey, X25519_PREFIX.length)
  return `z${encodeBase58(prefixed)}`
}

export function didOrKidToDid(didOrKid: string): string {
  return didOrKid.split('#', 1)[0]
}

export function didKeyToPublicKeyBytes(didOrKid: string): Uint8Array {
  const did = didOrKidToDid(didOrKid)
  if (!did.startsWith('did:key:z')) throw new DidKeyValidationError('Expected did:key')
  return ed25519MultibaseToPublicKeyBytes(`z${did.slice('did:key:z'.length)}`)
}

export interface ResolveDidKeyOptions {
  keyAgreement?: DidDocument['keyAgreement']
  service?: NonNullable<DidDocument['service']>
}

export type DidKeyResolverDocuments = Partial<Record<string, ResolveDidKeyOptions>>

export function ed25519MultibaseToPublicKeyBytes(multibase: string): Uint8Array {
  const decoded = decodeBase58Multibase(multibase)
  if (decoded[0] !== ED25519_PREFIX[0] || decoded[1] !== ED25519_PREFIX[1]) {
    throw new DidKeyValidationError('Expected Ed25519 multibase key')
  }
  const publicKey = decoded.slice(ED25519_PREFIX.length)
  assertPublicKeyLength(publicKey, 'Ed25519')
  return publicKey
}

export function x25519MultibaseToPublicKeyBytes(multibase: string): Uint8Array {
  const decoded = decodeBase58Multibase(multibase)
  if (decoded[0] !== X25519_PREFIX[0] || decoded[1] !== X25519_PREFIX[1]) {
    throw new DidKeyValidationError('Expected X25519 multibase key')
  }
  const publicKey = decoded.slice(X25519_PREFIX.length)
  assertPublicKeyLength(publicKey, 'X25519')
  return publicKey
}

export function resolveDidKey(did: string, options: ResolveDidKeyOptions = {}): DidDocument {
  assertBareDidKey(did)
  const publicKeyMultibase = ed25519PublicKeyToMultibase(didKeyToPublicKeyBytes(did))
  const keyAgreement = cloneKeyAgreement(options.keyAgreement) ?? []
  const service = cloneService(options.service)
  const document: DidDocument = {
    id: did,
    verificationMethod: [
      {
        id: '#sig-0',
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyMultibase,
      },
    ],
    authentication: ['#sig-0'],
    assertionMethod: ['#sig-0'],
    keyAgreement,
  }

  if (service) document.service = service

  return document
}

// Identity 003 DID resolution: did:key returns a bare document unless the
// resolver is configured with enriched keyAgreement/service vector fields.
export function createDidKeyResolver(documents: DidKeyResolverDocuments = {}): DidResolver {
  const snapshot = snapshotDidKeyResolverDocuments(documents)

  return {
    async resolve(did: string): Promise<DidDocument | null> {
      if (!did.startsWith('did:key:')) return null

      try {
        return resolveDidKey(did, getDidKeyResolverOptions(snapshot, did))
      } catch (error) {
        if (!(error instanceof DidKeyValidationError)) throw error
        return null
      }
    },
  }
}

function snapshotDidKeyResolverDocuments(documents: DidKeyResolverDocuments): DidKeyResolverDocuments {
  const snapshot = Object.create(null) as DidKeyResolverDocuments
  for (const [did, options] of Object.entries(documents)) {
    if (options) snapshot[did] = cloneResolveDidKeyOptions(options)
  }
  return snapshot
}

function getDidKeyResolverOptions(
  documents: DidKeyResolverDocuments,
  did: string,
): ResolveDidKeyOptions | undefined {
  return Object.prototype.hasOwnProperty.call(documents, did) ? documents[did] : undefined
}

function cloneResolveDidKeyOptions(options: ResolveDidKeyOptions): ResolveDidKeyOptions {
  const clone: ResolveDidKeyOptions = {}
  const keyAgreement = cloneKeyAgreement(options.keyAgreement)
  const service = cloneService(options.service)
  if (keyAgreement) clone.keyAgreement = keyAgreement
  if (service) clone.service = service
  return clone
}

function cloneKeyAgreement(
  keyAgreement: DidDocument['keyAgreement'] | undefined,
): DidDocument['keyAgreement'] | undefined {
  return keyAgreement?.map((entry) => ({ ...entry }))
}

function cloneService(service: NonNullable<DidDocument['service']> | undefined): DidDocument['service'] | undefined {
  // Empty service input means the bare did:key document omits optional service entries.
  if (!service || service.length === 0) return undefined
  return service?.map((entry) => ({ ...entry }))
}

function assertBareDidKey(did: string): void {
  if (did.includes('#')) throw new DidKeyValidationError('Expected bare DID without fragment')
  if (!did.startsWith('did:key:z')) throw new DidKeyValidationError('Expected did:key')
}

function assertPublicKeyLength(publicKey: Uint8Array, algorithm: 'Ed25519' | 'X25519'): void {
  if (publicKey.length !== PUBLIC_KEY_LENGTH) {
    throw new DidKeyValidationError(`Expected ${PUBLIC_KEY_LENGTH}-byte ${algorithm} public key`)
  }
}

function decodeBase58Multibase(multibase: string): Uint8Array {
  if (!multibase.startsWith('z')) throw new DidKeyValidationError('Expected base58btc multibase key')

  try {
    return decodeBase58(multibase.slice(1))
  } catch (error) {
    throw new DidKeyValidationError(error instanceof Error ? error.message : String(error))
  }
}
