// Sync 001/002 framing constants for AES-GCM payloads (nonce || ciphertext || tag).
// Internal module — not re-exported from protocol/index.ts.
export const NONCE_LENGTH = 12
export const AES_GCM_TAG_LENGTH = 16
