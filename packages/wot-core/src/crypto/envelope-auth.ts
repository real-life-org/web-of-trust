/**
 * Envelope Authentication — Sign and verify MessageEnvelope signatures
 *
 * Uses Ed25519 signatures over canonical envelope fields.
 * Signature covers: v|id|type|fromDid|toDid|createdAt|payload
 *
 * This prevents message spoofing — only the holder of the private key
 * matching fromDid can produce a valid signature.
 */

import type { MessageEnvelope } from '../types/messaging'
import { didKeyToPublicKeyBytes } from '../protocol/identity/did-key'
import { decodeBase64Url, toBuffer } from './encoding'

// SPEC-UNKLAR: real-life-org/wot-spec#96 — pipe-separiertes Envelope-Signing
// (v|id|type|fromDid|toDid|createdAt|payload) vs protocol JCS+JWS; plus direkter
// crypto.subtle-Default-Verify (Browser-Global) und Kopplung an MessageEnvelope.
// Schichtzuordnung & Entkopplung in Phase 1.B.3 klären, nicht als 1.A-Move.

/**
 * Create the canonical string to sign for a MessageEnvelope.
 * Fields are pipe-separated in a fixed order — deterministic and unambiguous.
 */
export function canonicalSigningInput(envelope: MessageEnvelope): string {
  return `${envelope.v}|${envelope.id}|${envelope.type}|${envelope.fromDid}|${envelope.toDid}|${envelope.createdAt}|${envelope.payload}`
}

/**
 * Sign function type — matches the IdentitySession sign method.
 * Takes a string, returns base64url-encoded Ed25519 signature.
 */
export type EnvelopeSignFn = (data: string) => Promise<string>

/**
 * Verify function type — takes data string, base64url signature, and signer DID.
 * Returns true if signature is valid. Portable: can be implemented with any crypto backend.
 */
export type EnvelopeVerifyFn = (data: string, signature: string, signerDid: string) => Promise<boolean>

/**
 * Sign a MessageEnvelope.
 * Mutates the envelope's `signature` field in-place and returns it.
 *
 * @param envelope - The envelope to sign
 * @param sign - Signing function (e.g., identity.sign.bind(identity))
 */
export async function signEnvelope(
  envelope: MessageEnvelope,
  sign: EnvelopeSignFn,
): Promise<MessageEnvelope> {
  const input = canonicalSigningInput(envelope)
  envelope.signature = await sign(input)
  return envelope
}

/**
 * Default verify implementation using Web Crypto API.
 * Extracts Ed25519 public key from did:key and verifies signature.
 */
async function webCryptoVerify(data: string, signature: string, signerDid: string): Promise<boolean> {
  const publicKeyBytes = didKeyToPublicKeyBytes(signerDid)
  const publicKey = await crypto.subtle.importKey(
    'raw',
    publicKeyBytes,
    { name: 'Ed25519' },
    true,
    ['verify'],
  )

  const inputBytes = new TextEncoder().encode(data)
  const signatureBytes = decodeBase64Url(signature)

  return crypto.subtle.verify(
    'Ed25519',
    publicKey,
    toBuffer(signatureBytes),
    inputBytes,
  )
}

/**
 * Verify a MessageEnvelope's signature against fromDid.
 *
 * Extracts the Ed25519 public key from envelope.fromDid (did:key),
 * then verifies the signature over the canonical fields.
 *
 * Returns true if signature is valid, false otherwise.
 * Never throws — returns false on any error.
 *
 * @param envelope - The envelope to verify
 * @param verify - Optional verify function (default: Web Crypto API)
 */
export async function verifyEnvelope(
  envelope: MessageEnvelope,
  verify: EnvelopeVerifyFn = webCryptoVerify,
): Promise<boolean> {
  try {
    if (!envelope.signature) return false

    const input = canonicalSigningInput(envelope)
    return await verify(input, envelope.signature, envelope.fromDid)
  } catch {
    return false
  }
}
