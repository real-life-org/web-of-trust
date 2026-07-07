// Legacy crypto barrel — dies in Phase 2 with the Automerge-adapter-stack refactor.
// Only the (deprecated) envelope-auth operations remain. Capability primitives moved
// to application/authorization; encoding consolidated into protocol/crypto/encoding.
export {
  canonicalSigningInput,
  signEnvelope,
  verifyEnvelope,
} from './envelope-auth'
export type {
  EnvelopeSignFn,
  EnvelopeVerifyFn,
} from './envelope-auth'
