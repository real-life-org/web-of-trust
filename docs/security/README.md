# Security

> Web of Trust security concept — honest assessment, as of March 17, 2026

## Contents

| Document | Description |
|----------|-------------|
| [Cryptography](crypto.md) | Key derivation, encryption, signatures — what we use and why |
| [Threat Model](threat-model.md) | Attack vectors, STRIDE analysis, scenarios |
| [Privacy](privacy.md) | Data protection, metadata, GDPR |

---

## Security Principles

### 1. Zero Trust Server

The relay server and the vault are **not trusted**:

- See only encrypted data (AES-256-GCM)
- Cannot read content
- Cannot forge identities (Ed25519 signatures)
- Cannot recover deleted data

Even if the server is compromised, content remains encrypted, identities remain safe, verifications remain valid.

### 2. Cryptographic Identity

```
Recovery Phrase (12 words, BIP39)
    │
    ▼ HKDF
Master Seed
    ├── Ed25519 Key Pair (signing, did:key)
    └── X25519 Key Pair (encryption, ECIES)
```

The private key is protected locally with a password (PBKDF2, 100,000 iterations + AES-GCM).

### 3. GroupKey = Access

```
Create Space
    │
    ▼
GroupKey generated (AES-256-GCM)
    │
    ├── All CRDT changes encrypted
    ├── New member → key delivered via asymmetric encryption (X25519 ECIES)
    └── Member removed → key rotation (new key to all remaining members)
```

**Whoever has the GroupKey can read and write.** This is the primary access control mechanism.

### 4. Signed Messages

Every message envelope is signed with Ed25519. The recipient verifies the signature against `fromDid` (did:key → public key). Only the creator (`members[0]`) can perform membership changes.

---

## Security Properties

| Property | Status | Description |
|----------|--------|-------------|
| **E2E Encryption** | ✅ | AES-256-GCM, server sees only ciphertext |
| **Authenticity** | ✅ | Ed25519 envelope signatures verify sender |
| **Integrity** | ✅ | Signatures protect against manipulation |
| **Forward Secrecy (Space)** | ✅ | Key rotation on removeMember — removed member cannot decrypt new messages |
| **Forward Secrecy (1:1)** | ✅ | Ephemeral X25519 ECDH per message |
| **Post-Compromise Security** | ⚠️ | No automatic ratchet like Signal — compromised GroupKey remains valid until next rotation |
| **Decentralization** | ✅ | No central authority, no operator account required |
| **Offline Capability** | ✅ | All operations possible locally |

---

## Known Limitations

| Limitation | Description | Accepted? |
|------------|-------------|-----------|
| **No Read-Only** | Whoever has the GroupKey can also write | Yes — requires CGKA (Keyhive, earliest 2027) |
| **GroupKey sharing** | A member can share the key out-of-band | Yes — unavoidable with symmetric encryption |
| **Metadata visible** | Server sees timing, IP, DID pairs, message sizes | Yes — trade-off with usability |
| **No Ratchet** | No automatic key ratchet like Signal | Yes — key rotation only on removeMember |

---

## Capability System (UCAN-inspired)

The project contains a UCAN-inspired capability system (`crypto/capabilities.ts`). It is currently **only used in wot-vault** as an HTTP auth token (self-issued identity proof). It is **not** wired into the ReplicationAdapter — there it provides no real security value because:

- P2P has no server that checks capabilities
- `canAccess()` only checks the local store — anyone can self-sign a capability
- Real protection comes from GroupKey + envelope signature + `members[0]` check

The capability primitives remain as building blocks for future server scenarios (e.g., shared vault with creator-root-of-trust, delegation to third parties).

---

## File Reference

| File | Purpose |
|------|---------|
| `wot-core/src/identity/WotIdentity.ts` | Key generation, HKDF, Ed25519, X25519 ECIES |
| `wot-core/src/identity/SeedStorage.ts` | PBKDF2 + AES-GCM seed encryption |
| `wot-core/src/crypto/envelope-auth.ts` | Envelope sign/verify (Ed25519) |
| `wot-core/src/services/EncryptedSyncService.ts` | AES-256-GCM encryption for CRDT sync |
| `wot-core/src/services/GroupKeyService.ts` | GroupKey management + key rotation |
| `wot-core/src/crypto/capabilities.ts` | UCAN-inspired capability tokens |
| `wot-vault/src/auth.ts` | Vault-side HTTP auth |
