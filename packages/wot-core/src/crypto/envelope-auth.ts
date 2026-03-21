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
import { didToPublicKeyBytes } from './did'
import { decodeBase64Url } from './encoding'

/**
 * Create the canonical string to sign for a MessageEnvelope.
 * Fields are pipe-separated in a fixed order — deterministic and unambiguous.
 */
export function canonicalSigningInput(envelope: MessageEnvelope): string {
  return `${envelope.v}|${envelope.id}|${envelope.type}|${envelope.fromDid}|${envelope.toDid}|${envelope.createdAt}|${envelope.payload}`
}

/**
 * Sign function type — matches WotIdentity.sign() signature.
 * Takes a string, returns base64url-encoded Ed25519 signature.
 */
export type EnvelopeSignFn = (data: string) => Promise<string>

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
 * Verify a MessageEnvelope's signature against fromDid.
 *
 * Extracts the Ed25519 public key from envelope.fromDid (did:key),
 * then verifies the signature over the canonical fields.
 *
 * Returns true if signature is valid, false otherwise.
 * Never throws — returns false on any error.
 */
export async function verifyEnvelope(envelope: MessageEnvelope): Promise<boolean> {
  try {
    if (!envelope.signature) return false

    // Extract public key from fromDid
    const publicKeyBytes = didToPublicKeyBytes(envelope.fromDid)
    const publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      true,
      ['verify'],
    )

    // Reconstruct signing input
    const input = canonicalSigningInput(envelope)
    const inputBytes = new TextEncoder().encode(input)

    // Decode signature
    const signatureBytes = decodeBase64Url(envelope.signature)

    return await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      signatureBytes.buffer.slice(
        signatureBytes.byteOffset,
        signatureBytes.byteOffset + signatureBytes.byteLength,
      ),
      inputBytes,
    )
  } catch {
    return false
  }
}
