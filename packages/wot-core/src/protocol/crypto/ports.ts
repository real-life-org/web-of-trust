export interface ProtocolIdentityVaultCryptoHandle {
  readonly ed25519PublicKey: Uint8Array
  readonly x25519PublicKey: Uint8Array
  signEd25519(data: Uint8Array): Promise<Uint8Array>
  decryptForMe(ephemeralPublicKey: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>
  deriveFrameworkKey(info: string, length: number): Promise<Uint8Array>
}

export interface ProtocolCryptoAdapter {
  verifyEd25519(input: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean>
  sha256(input: Uint8Array): Promise<Uint8Array>
  hkdfSha256(input: Uint8Array, info: string, length: number): Promise<Uint8Array>
  x25519PublicFromSeed(seed: Uint8Array): Promise<Uint8Array>
  x25519SharedSecret(privateSeed: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array>
  aes256GcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>
  aes256GcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>
  createIdentityVaultCryptoHandle?(bip39Seed: Uint8Array): Promise<ProtocolIdentityVaultCryptoHandle>
}
