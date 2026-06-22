import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { publicKeyToDidKey, bytesToHex } from '@web_of_trust/core/protocol'

// Single shared crypto adapter (the vector-validated WebCrypto implementation).
// Reused everywhere so the spike never re-implements crypto/JWS/classifiers.
export const crypto = new WebCryptoProtocolCryptoAdapter()

export interface Author {
  /** 32-byte Ed25519 seed = signingSeed for createLogEntryJws. */
  readonly seed: Uint8Array
  /** 32-byte Ed25519 public key. */
  readonly pub: Uint8Array
  /** did:key:z... */
  readonly did: string
  /** DID URL WITH fragment — required by log-entry validation. */
  readonly authorKid: string
}

const textEncoder = new TextEncoder()

export function utf8(value: string): Uint8Array {
  return textEncoder.encode(value)
}

/**
 * Deterministic 32-byte seed from a label, so test runs are reproducible.
 * (We hash the label rather than relying on randomness.)
 */
export async function deriveSeed(label: string): Promise<Uint8Array> {
  return crypto.sha256(utf8(`sync-spike/seed/${label}`))
}

export async function makeAuthor(seed: Uint8Array): Promise<Author> {
  if (seed.length !== 32) throw new Error('makeAuthor: seed must be 32 bytes')
  const pub = await crypto.ed25519PublicKeyFromSeed(seed)
  const did = publicKeyToDidKey(pub)
  // Idiomatic single-device construction. Identity-004 (multi device key) stays
  // a clean future drop-in: this is the ONLY place authorKid is assembled.
  const authorKid = `${did}#sig-0`
  return { seed, pub, did, authorKid }
}

export async function makeAuthorFromLabel(label: string): Promise<Author> {
  return makeAuthor(await deriveSeed(label))
}

/**
 * Space Content Key derivation for the spike: deterministic per (docId, keyGeneration).
 * A different keyGeneration yields a different 32-byte AES key (key rotation).
 */
export async function deriveSpaceContentKey(docId: string, keyGeneration: number): Promise<Uint8Array> {
  return crypto.sha256(utf8(`space-content-key|${docId}|gen${keyGeneration}`))
}

/** Stable content hash (hex) of opaque bytes — used for broker seq-collision detection. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  return bytesToHex(await crypto.sha256(bytes))
}

/** Canonical lowercase UUIDv4 (Node randomUUID returns a valid v4). */
export function newUuid(): string {
  return globalThis.crypto.randomUUID()
}
