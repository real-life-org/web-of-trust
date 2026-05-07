import { MessageEnvelope } from '../types/messaging';
/**
 * Create the canonical string to sign for a MessageEnvelope.
 * Fields are pipe-separated in a fixed order — deterministic and unambiguous.
 */
export declare function canonicalSigningInput(envelope: MessageEnvelope): string;
/**
 * Sign function type — matches WotIdentity.sign() signature.
 * Takes a string, returns base64url-encoded Ed25519 signature.
 */
export type EnvelopeSignFn = (data: string) => Promise<string>;
/**
 * Verify function type — takes data string, base64url signature, and signer DID.
 * Returns true if signature is valid. Portable: can be implemented with any crypto backend.
 */
export type EnvelopeVerifyFn = (data: string, signature: string, signerDid: string) => Promise<boolean>;
/**
 * Sign a MessageEnvelope.
 * Mutates the envelope's `signature` field in-place and returns it.
 *
 * @param envelope - The envelope to sign
 * @param sign - Signing function (e.g., identity.sign.bind(identity))
 */
export declare function signEnvelope(envelope: MessageEnvelope, sign: EnvelopeSignFn): Promise<MessageEnvelope>;
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
export declare function verifyEnvelope(envelope: MessageEnvelope, verify?: EnvelopeVerifyFn): Promise<boolean>;
//# sourceMappingURL=envelope-auth.d.ts.map