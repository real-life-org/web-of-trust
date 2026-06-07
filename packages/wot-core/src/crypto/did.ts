import { encodeBase58, decodeBase58 } from './encoding'

// Ed25519 multicodec prefix (0xed01)
const ED25519_PUB_PREFIX = new Uint8Array([0xed, 0x01])

/**
 * Create a did:key from Ed25519 public key bytes
 * Format: did:key:z<base58btc-encoded-multicodec-pubkey>
 */
export function createDid(publicKeyBytes: Uint8Array): string {
  // Create multicodec-prefixed key
  const prefixedKey = new Uint8Array(ED25519_PUB_PREFIX.length + publicKeyBytes.length)
  prefixedKey.set(ED25519_PUB_PREFIX)
  prefixedKey.set(publicKeyBytes, ED25519_PUB_PREFIX.length)

  // Encode as base58btc with 'z' prefix for did:key
  const multibase = 'z' + encodeBase58(prefixedKey)

  return `did:key:${multibase}`
}

/**
 * Extract Ed25519 public key bytes from did:key
 */
export function didToPublicKeyBytes(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) {
    throw new Error('Invalid did:key format')
  }

  const multibase = did.slice('did:key:z'.length)
  const prefixedKey = decodeBase58(multibase)

  // Verify prefix
  if (prefixedKey[0] !== ED25519_PUB_PREFIX[0] || prefixedKey[1] !== ED25519_PUB_PREFIX[1]) {
    throw new Error('Invalid multicodec prefix for Ed25519')
  }

  return prefixedKey.slice(ED25519_PUB_PREFIX.length)
}

// SPEC-UNKLAR: real-life-org/wot-spec#97 — isValidDid & getDefaultDisplayName haben
// keine echten Konsumenten (nur Barrel-Re-Exports). Beim crypto->protocol-Move (1.B)
// ersatzlos streichen statt tote Protocol-API anzulegen. createDid/didToPublicKeyBytes
// existieren bereits byte-identisch in protocol/identity/did-key.ts.
/**
 * Validate did:key format
 */
export function isValidDid(did: string): boolean {
  try {
    if (!did.startsWith('did:key:z')) return false
    didToPublicKeyBytes(did)
    return true
  } catch {
    return false
  }
}

/**
 * Generate a short display name from a DID
 * Format: "User-{6chars}" from the end of the DID
 */
export function getDefaultDisplayName(did: string): string {
  if (!did) return 'User'
  const suffix = did.slice(-6)
  return `User-${suffix}`
}
