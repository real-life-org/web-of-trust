export { encodeBase58, decodeBase58, encodeBase64Url, decodeBase64Url, encodeBase64, decodeBase64, toBuffer, } from './encoding';
export { createDid, didToPublicKeyBytes, isValidDid, getDefaultDisplayName, } from './did';
export { signJws, verifyJws, extractJwsPayload, } from './jws';
export { createCapability, verifyCapability, delegateCapability, extractCapability, } from './capabilities';
export type { Capability, CapabilityJws, Permission, SignFn, VerifiedCapability, CapabilityError, CapabilityVerificationResult, } from './capabilities';
export { canonicalSigningInput, signEnvelope, verifyEnvelope, } from './envelope-auth';
export type { EnvelopeSignFn, EnvelopeVerifyFn, } from './envelope-auth';
//# sourceMappingURL=index.d.ts.map