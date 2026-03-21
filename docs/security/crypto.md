# Cryptography

> Which algorithms we use, why, and how they fit together.

*As of March 17, 2026*

---

## Key Derivation

### From Seed to Key Pair

```
BIP39 Mnemonic (12 words, German wordlist, 128-bit entropy)
    │
    ▼ HKDF (SHA-256, info="wot-identity-ed25519")
Ed25519 Key Pair ──► did:key ──► Identity
    │
    ▼ HKDF (SHA-256, info="wot-encryption-x25519")
X25519 Key Pair ──► Asymmetric Encryption (ECIES)
```

**Why HKDF and not PBKDF2/Argon2?** The BIP39 seed already has 128-bit entropy — that's strong enough. PBKDF2/Argon2 are designed for weak inputs (passwords) and would only add unnecessary slowdown here. HKDF is the right choice for "strong input → derive multiple keys".

**File:** `wot-core/src/identity/WotIdentity.ts`

### Local Seed Protection

```
User Password
    │
    ▼ PBKDF2 (100,000 iterations, SHA-256, random salt)
AES-256-GCM Key
    │
    ▼ AES-256-GCM Encrypt
Encrypted Seed ──► IndexedDB
```

**Why PBKDF2?** The password has low entropy — PBKDF2 with 100k iterations makes brute-force attacks expensive. Argon2 would be better (memory-hard) but is not available in Web Crypto API.

**File:** `wot-core/src/identity/SeedStorage.ts`

---

## Algorithm Overview

| Purpose | Algorithm | Details |
|---------|-----------|---------|
| Identity (signing) | Ed25519 | did:key, non-extractable via Web Crypto |
| Asymmetric encryption | X25519 ECIES | Ephemeral ECDH + HKDF + AES-256-GCM |
| Symmetric encryption | AES-256-GCM | GroupKey for space content |
| Key derivation (seed → keys) | HKDF-SHA256 | Different `info` strings per key |
| Key derivation (password → key) | PBKDF2-SHA256 | 100,000 iterations |
| Seed generation | BIP39 | 12 words, German wordlist, 128-bit |
| Envelope signatures | Ed25519 | Canonical fields, base64url |
| JWS (profiles, capabilities) | Ed25519 | Compact serialization |

---

## Encryption Layers

### Space Content (CRDT Sync)

```
CRDT change (Yjs update / Automerge change)
    │
    ▼ AES-256-GCM (GroupKey, random nonce)
Ciphertext
    │
    ▼ WebSocket (TLS)
Relay server (sees only ciphertext)
    │
    ▼ WebSocket (TLS)
Recipient
    │
    ▼ AES-256-GCM decrypt (GroupKey)
CRDT change
```

**File:** `wot-core/src/services/EncryptedSyncService.ts`

### GroupKey Distribution (Space Invite)

```
GroupKey (32 bytes)
    │
    ▼ X25519 ECIES (ephemeral key + recipient public key)
Encrypted GroupKey
    │
    ▼ space-invite message (signed)
Recipient
    │
    ▼ X25519 ECIES decrypt (own private key)
GroupKey
```

Only the recipient can decrypt — the relay sees only ciphertext.

**File:** `wot-core/src/identity/WotIdentity.ts` → `encryptForRecipient()` / `decryptForMe()`

### Key Rotation (on removeMember)

```
Member removed
    │
    ▼ New GroupKey generated
    │
    ├── For each remaining member:
    │   ▼ X25519 ECIES (member public key)
    │   Encrypted new key ──► group-key-rotation message
    │
    └── Removed member does NOT receive new key
        → Cannot decrypt new messages (forward secrecy)
```

**File:** `wot-core/src/services/GroupKeyService.ts`

### 1:1 Messages (Attestations, Invites)

```
Plaintext payload
    │
    ▼ X25519 ECIES (ephemeral ECDH + HKDF + AES-256-GCM)
Ciphertext + ephemeral public key + nonce
    │
    ▼ MessageEnvelope (signed with Ed25519)
Relay → Recipient
```

Each 1:1 message uses a fresh ephemeral key — forward secrecy per message.

---

## Envelope Signatures

Every MessageEnvelope is signed:

```
Signing input (pipe-separated):
  v | id | type | fromDid | toDid | createdAt | payload

Ed25519 Sign (sender's private key)
    │
    ▼
signature (base64url)
```

Recipient verifies:
1. Extract public key from `fromDid` (did:key multicodec)
2. Reconstruct signing input
3. `crypto.subtle.verify('Ed25519', publicKey, signature, input)`

**File:** `wot-core/src/crypto/envelope-auth.ts`

---

## Web Crypto API

All cryptographic operations use the **native Web Crypto API** (`crypto.subtle`). No external crypto libraries in the critical path.

| Operation | Web Crypto Method |
|-----------|-------------------|
| Ed25519 sign/verify | `crypto.subtle.sign/verify('Ed25519')` |
| X25519 ECDH | `crypto.subtle.deriveBits({ name: 'X25519' })` |
| AES-256-GCM | `crypto.subtle.encrypt/decrypt({ name: 'AES-GCM' })` |
| HKDF | `crypto.subtle.deriveBits/deriveKey({ name: 'HKDF' })` |
| PBKDF2 | `crypto.subtle.deriveKey({ name: 'PBKDF2' })` |
| Random | `crypto.getRandomValues()` |

**Ed25519/X25519 browser support:** Chrome 113+, Firefox 130+, Safari 17+. Older browsers (e.g., Chrome 133 from February 2025) may have issues — recommend browser update.

**Private keys:** Where possible, `extractable: false` — the private key cannot be exported from the Web Crypto store.

---

## Open Items

| Item | Status | Description |
|------|--------|-------------|
| **Argon2 instead of PBKDF2** | Open | Memory-hard, better against GPU attacks. Not available in Web Crypto API, requires WASM library. |
| **CGKA (Keyhive/BeeKEM)** | Future | Continuous Group Key Agreement — enables read-only members and automatic ratchet. Pre-alpha, earliest 2027. |
| **MLS Key Rotation** | Future | Messaging Layer Security — standardized protocol for group key management. |
| **Certificate Pinning** | Open | TLS certificate pinning for mobile apps. |
