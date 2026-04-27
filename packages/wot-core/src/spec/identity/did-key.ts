import { decodeBase58, encodeBase58 } from '../crypto/encoding'
import type { DidDocument } from './did-document'

const ED25519_PREFIX = new Uint8Array([0xed, 0x01])
const X25519_PREFIX = new Uint8Array([0xec, 0x01])

export function publicKeyToDidKey(publicKey: Uint8Array): string {
  return `did:key:${ed25519PublicKeyToMultibase(publicKey)}`
}

export function ed25519PublicKeyToMultibase(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(ED25519_PREFIX.length + publicKey.length)
  prefixed.set(ED25519_PREFIX)
  prefixed.set(publicKey, ED25519_PREFIX.length)
  return `z${encodeBase58(prefixed)}`
}

export function x25519PublicKeyToMultibase(publicKey: Uint8Array): string {
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
  if (!did.startsWith('did:key:z')) throw new Error('Expected did:key')
  return ed25519MultibaseToPublicKeyBytes(`z${did.slice('did:key:z'.length)}`)
}

export function ed25519MultibaseToPublicKeyBytes(multibase: string): Uint8Array {
  if (!multibase.startsWith('z')) throw new Error('Expected base58btc multibase key')
  const decoded = decodeBase58(multibase.slice(1))
  if (decoded[0] !== ED25519_PREFIX[0] || decoded[1] !== ED25519_PREFIX[1]) {
    throw new Error('Expected Ed25519 multibase key')
  }
  return decoded.slice(ED25519_PREFIX.length)
}

export function resolveDidKey(did: string): DidDocument {
  const publicKeyMultibase = ed25519PublicKeyToMultibase(didKeyToPublicKeyBytes(did))
  return {
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
    keyAgreement: [],
  }
}
