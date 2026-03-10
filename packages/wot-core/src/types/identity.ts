export interface Profile {
  name: string
  bio?: string
  avatar?: string
  offers?: string[]
  needs?: string[]
}

export interface Identity {
  did: string
  profile: Profile
  createdAt: string
  updatedAt: string
}

export interface KeyPair {
  publicKey: CryptoKey
  privateKey: CryptoKey
}

export interface PublicProfile {
  did: string
  name: string
  bio?: string
  avatar?: string
  offers?: string[]
  needs?: string[]
  encryptionPublicKey?: string  // Base64URL-encoded X25519 public key (32 bytes)
  updatedAt: string
}
