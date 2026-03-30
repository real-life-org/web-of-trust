# Web of Trust — Protocol Specification v0.1

**Status:** Draft
**Date:** 2026-03-30
**Purpose:** Language-agnostic protocol specification. Any implementation (TypeScript, Rust, etc.) that follows this spec can interoperate with any other.

---

## 1. Decentralized Identifier (DID)

**Format:** `did:key:z<base58btc>`

```
did:key:z + base58btc( [0xed, 0x01] || ed25519_public_key_32_bytes )
```

- Multicodec prefix for Ed25519 public key: `0xed01` (2 bytes)
- Multibase prefix: `z` (indicates base58btc encoding)
- Base58 alphabet: Bitcoin-style (no 0, O, I, l)

**Example:** `did:key:z6MkhaXgBZDvotzL8V6N7LrM9nH3MQvx3Q9N6YqVR7F3G`

---

## 2. Key Derivation

All keys are derived deterministically from a single seed:

```
BIP39 Mnemonic (12 words, 128-bit entropy)
  │
  ▼
Master Seed (32 bytes) = mnemonicToSeed(mnemonic, passphrase="")
  │
  ├─ HKDF-SHA256(seed, info="wot-identity-v1",   bits=256) → Ed25519 key pair (signing)
  ├─ HKDF-SHA256(seed, info="wot-encryption-v1",  bits=256) → X25519 key pair (encryption)
  └─ HKDF-SHA256(seed, info=<custom>,             bits=256) → framework-specific keys
```

- BIP39 passphrase is always empty string (same mnemonic = same identity everywhere)
- HKDF salt: empty (zero-length)
- Same seed always produces the same DID on any device

---

## 3. Message Envelope

All messages between peers use this envelope format:

```json
{
  "v": 1,
  "id": "uuid",
  "type": "verification | attestation | contact-request | space-invite | content | personal-sync | ack | ...",
  "fromDid": "did:key:z...",
  "toDid": "did:key:z...",
  "createdAt": "2026-03-30T12:00:00.000Z",
  "encoding": "json",
  "payload": "...",
  "signature": "base64url-ed25519-signature"
}
```

### Signature

The signature covers a canonical string of pipe-separated fields in fixed order:

```
v|id|type|fromDid|toDid|createdAt|payload
```

- Encoding: UTF-8
- Algorithm: Ed25519
- Output: Base64URL-encoded 64-byte signature

---

## 4. Verification Protocol

Mutual verification between two people via challenge-response:

### Step 1: Challenge (A → B, typically via QR code)

```json
{
  "nonce": "random-base64url",
  "timestamp": "2026-03-30T12:00:00.000Z",
  "fromDid": "did:key:z...",
  "fromPublicKey": "base64url-ed25519-public-key",
  "fromName": "Alice"
}
```

### Step 2: Response (B → A)

```json
{
  "nonce": "echo-same-nonce",
  "timestamp": "2026-03-30T12:00:01.000Z",
  "toDid": "did:key:z...",
  "toPublicKey": "base64url-ed25519-public-key",
  "toName": "Bob",
  "fromDid": "did:key:z...",
  "fromPublicKey": "base64url-ed25519-public-key",
  "fromName": "Alice"
}
```

### Step 3: Verification Documents

Each side creates and delivers a signed Verification:

```json
{
  "id": "uuid",
  "from": "did:key:z...",
  "to": "did:key:z...",
  "timestamp": "2026-03-30T12:00:02.000Z",
  "proof": {
    "type": "Ed25519Signature2020",
    "verificationMethod": "did:key:z...#z...",
    "created": "2026-03-30T12:00:02.000Z",
    "proofPurpose": "authentication",
    "proofValue": "base64url-signature"
  }
}
```

Both directions are independent documents (A→B and B→A).

---

## 5. Attestation Format

A signed claim from one identity about another:

```json
{
  "id": "uuid",
  "from": "did:key:z...",
  "to": "did:key:z...",
  "claim": "Excellent carpenter, built my kitchen",
  "tags": ["craftsmanship", "carpentry"],
  "context": "Renovated our community space in 2025",
  "createdAt": "2026-03-30T12:00:00.000Z",
  "proof": {
    "type": "Ed25519Signature2020",
    "verificationMethod": "did:key:z...#z...",
    "created": "2026-03-30T12:00:00.000Z",
    "proofPurpose": "assertionMethod",
    "proofValue": "base64url-signature"
  }
}
```

- Only the sender (from) signs
- Stored at the recipient (to)
- Recipient controls visibility via acceptance

---

## 6. JWS (JSON Web Signature)

Used for signing arbitrary payloads (e.g., profile updates):

```
BASE64URL(header) . BASE64URL(payload) . BASE64URL(signature)
```

Header:
```json
{ "alg": "EdDSA", "typ": "JWT" }
```

Algorithm: Ed25519, Base64URL encoding without padding.

---

## 7. Encryption

### 7.1 Asymmetric (ECIES — for 1:1 messages)

```
Sender:
  1. Generate ephemeral X25519 key pair
  2. ECDH: ephemeral_private × recipient_public → shared_secret (32 bytes)
  3. HKDF-SHA256(shared_secret, salt=zeros(32), info="wot-ecies-v1") → AES key
  4. AES-256-GCM encrypt(plaintext, aes_key, random_nonce_12_bytes)
  5. Send: { ephemeralPublicKey, ciphertext, nonce }

Recipient:
  1. ECDH: own_private × ephemeral_public → same shared_secret
  2. Same HKDF → same AES key
  3. AES-256-GCM decrypt
```

### 7.2 Symmetric (for group spaces)

```
  AES-256-GCM encrypt(plaintext, group_key_32_bytes, random_nonce_12_bytes)
  → { ciphertext, nonce, spaceId, generation, fromDid }
```

- Group key: 32 random bytes, shared with all space members
- Nonce: 12 bytes, random, never reused with same key
- Generation: increments on key rotation (member removal)

---

## 8. Trust Graph (planned)

Quantitative trust over the verification network:

- **Edges:** Unidirectional. A verifies B does not imply B verifies A.
- **Weights:** Percentage (0-100%) per edge, assigned by the source node.
- **Decay:** Each hop multiplies: `trust(A→C) = trust(A→B) × trust(B→C)`
- **Multipath:** Multiple independent paths increase aggregated trust (algorithm TBD).
- **Thresholds:** Application-defined. Example: "Accept vouchers above 60% trust."

---

## 9. Resource References

Addressing resources across the protocol:

```
wot:<type>:<id>[/<sub-path>]

Types: attestation, verification, contact, space, item

Examples:
  wot:attestation:abc-123
  wot:space:family/item/event-789
  wot:contact:did:key:z6Mk...
```

---

## 10. Cryptographic Constants

| Component | Algorithm | Size | Notes |
| --- | --- | --- | --- |
| Signing | Ed25519 | 32-byte secret + 32-byte public | |
| Encryption (1:1) | X25519 + HKDF-SHA256 + AES-256-GCM | 32-byte keys, 12-byte nonce | Ephemeral key per message |
| Encryption (group) | AES-256-GCM | 32-byte key, 12-byte nonce | Random nonce per message |
| Key derivation | HKDF-SHA256 | 256-bit output | Empty salt |
| DID encoding | Base58btc | Variable | Multicodec prefix 0xed01 |
| Signature encoding | Base64URL | 64 bytes | No padding |
| Mnemonic | BIP39 | 12 words (128-bit entropy) | |

---

## 11. Compatibility Requirements

An implementation is compatible with this spec if it can:

1. **Generate** a DID from a BIP39 mnemonic that matches any other implementation
2. **Verify** signatures produced by any other implementation
3. **Parse and produce** MessageEnvelopes with correct canonical signing
4. **Complete** the verification handshake with any other implementation
5. **Decrypt** messages encrypted by any other implementation (ECIES + AES-256-GCM)

Implementations MAY omit features (e.g., trust graph, group spaces) but MUST correctly handle the formats they do implement.
