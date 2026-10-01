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

**File:** `wot-core/src/protocol/sync/encryption.ts` (`encryptOneShot`/`decryptOneShot` for random-nonce one-shot payloads, `encryptLogPayload`/`decryptLogPayload` for the deterministic-nonce log path)

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

**Files:** `wot-core/src/ports/key-management.ts` (`KeyManagementPort`), `wot-core/src/application/sync/group-key-workflow.ts` (creation/rotation/apply/import), `wot-core/src/adapters/key-management/` (`InMemoryKeyManagementAdapter`)

### 1:1 Messages (Attestations, Invites)

```
Plaintext payload
    │
    ▼ X25519 ECIES (ephemeral ECDH + HKDF + AES-256-GCM)
Ciphertext + ephemeral public key + nonce
    │
    ▼ DIDComm envelope (inbox/1.0); sender bound by the inner JWS inside the ECIES body
Relay → Recipient
```

Each 1:1 message uses a fresh ephemeral key — forward secrecy per message.

---

## Sender Authenticity (Inner JWS, Log-Entry JWS)

The transport envelope (DIDComm v2 plaintext, Sync 003) carries **no crypto** — authenticity lives inside the body:

```
Inbox messages (inbox/1.0, space-invite, member-update, key-rotation):
  plaintext body ──► inner JWS (Ed25519, sender's Identity Key)
                 ──► ECIES (X25519 + HKDF + AES-256-GCM) for the recipient
  recipient: decrypt ──► verify inner JWS (kid → did:key) ──► sender = JWS signer

Space content (log-entry/1.0):
  encrypted CRDT update ──► log-entry JWS (Ed25519, authorKid = <did>#key)
  recipient/relay: verify log-entry JWS (authority via authorKid, never envelope `from`)
```

The envelope's `from`/`to` are routing hints only, never an authority anchor. The legacy signed `MessageEnvelope` (`signEnvelope`/`verifyEnvelope`) is removed (wot#386) — the relay never accepted it.

**Files:** `wot-core/src/protocol/messaging/inbox-inner-jws.ts`, `wot-core/src/application/messaging/inbox-reception-workflow.ts` (`receiveInboxMessage`), `wot-core/src/protocol/sync/log-entry.ts` (`verifyLogEntryJws`)

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
