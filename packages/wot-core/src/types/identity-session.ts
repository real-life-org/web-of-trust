export interface IdentityEncryptedPayload {
  ciphertext: Uint8Array
  nonce: Uint8Array
  ephemeralPublicKey?: Uint8Array
}

export interface PublicIdentityMaterial {
  did: string
  kid: string
  ed25519PublicKey: Uint8Array
  x25519PublicKey: Uint8Array
}

export interface IdentitySession {
  getDid(): string
  sign(data: string): Promise<string>
  signJws(payload: unknown): Promise<string>
  deriveFrameworkKey(info: string): Promise<Uint8Array>
  getPublicKeyMultibase(): Promise<string>
  getEncryptionPublicKeyBytes(): Promise<Uint8Array>
  encryptForRecipient(plaintext: Uint8Array, recipientPublicKeyBytes: Uint8Array): Promise<IdentityEncryptedPayload>
  decryptForMe(payload: IdentityEncryptedPayload): Promise<Uint8Array>
  deleteStoredIdentity(): Promise<void>
}

export type PublicIdentitySession = IdentitySession & PublicIdentityMaterial

// Operation-shaped vault handle returned by IdentitySeedVault.unlock* methods.
// Reference contract: the handle exposes identity material and operations bound
// to the vault-internal seed without ever returning raw BIP39 seed bytes to the
// application layer (wot-identity@0.1 / wot-spec PR #74 / ADR 0001).
export interface IdentityVaultUnlockHandle extends PublicIdentityMaterial {
  signEd25519(data: Uint8Array): Promise<Uint8Array>
  decryptForMe(payload: IdentityEncryptedPayload): Promise<Uint8Array>
  deriveFrameworkKey(info: string, length?: number): Promise<Uint8Array>
}
