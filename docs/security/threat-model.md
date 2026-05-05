# Threat Model

> Attack vectors and mitigations in the Web of Trust — honest analysis.

*As of March 17, 2026*

---

## Actors

### Legitimate Actors

| Actor | Description |
|-------|-------------|
| **User** | App user with own identity (Ed25519 key pair) |
| **Contact** | Verified contact (mutual QR code verification) |
| **Space Admin / Creator** | Locally known authority for membership changes; current adapters still derive this from creator state, while core exposes broader disposition vocabulary for future adapter integration |
| **Space Member** | Has GroupKey, can read and write |

### Attackers

| Attacker | Capabilities |
|----------|-------------|
| **Passive network attacker** | Can observe traffic |
| **Active network attacker** | Can manipulate traffic |
| **Compromised relay** | Full access to relay server (routing, metadata) |
| **Compromised vault** | Full access to encrypted backups |
| **Malicious member** | Space member with GroupKey and malicious intent |
| **Stolen device** | Physical access to an unlocked device |

---

## What Actually Protects — And What Doesn't

### Protection Matrix

| Threat | Protection | Strength | Details |
|--------|-----------|----------|---------|
| Relay reads content | AES-256-GCM (GroupKey) | ✅ Strong | Server sees only ciphertext |
| Relay forges sender | Ed25519 envelope signature | ✅ Strong | `verifyEnvelope()` in both adapters |
| Outsider joins space | GroupKey (X25519 ECIES encrypted) | ✅ Strong | No key, no access |
| Removed member reads on | Key rotation | ✅ Strong | New key, removed member excluded |
| Unauthorized membership change | Current adapters: envelope signature + creator-derived authority checks | ⚠️ Medium | Core now exposes member-update disposition vocabulary, but durable pending/unverified-pending state and canonical confirmation are not yet wired into adapters |
| Member shares GroupKey | — | ❌ Not preventable | Shared secret, by design |
| Member writes unwanted content | — | ❌ No read-only | Whoever has the key can produce CRDT changes |
| Vault data read | AES-256-GCM (GroupKey) | ✅ Strong | Vault sees only ciphertext |
| Seed stolen | PBKDF2 + AES-GCM (password) | ⚠️ Medium | Depends on password strength |
| Recovery phrase compromised | — | ❌ Full access | Phrase = identity, not revocable |

---

## STRIDE Analysis

### S — Spoofing (Identity Forgery)

| Threat | Risk | Mitigation |
|--------|------|------------|
| Create fake identity | Low | Identity = Ed25519 key pair, cryptographically bound |
| Forge sender (relay attack) | Low | Envelope signature verifies `fromDid` (Ed25519) |
| Forge verification | Low | Verifications are signed, QR code face-to-face |
| Forge attestation | Low | Attestations are signed, signature chain verifiable |
| Manipulate QR code | Medium | DID and public key must match cryptographically |
| Social engineering | High | "I'm Max, scan my QR" — technically not preventable |

### T — Tampering (Manipulation)

| Threat | Risk | Mitigation |
|--------|------|------------|
| Modify message on relay | Low | E2E encryption + envelope signature |
| Manipulate CRDT state (external) | Low | Without GroupKey, no valid ciphertext producible |
| Manipulate CRDT state (member) | Medium | **Not preventable** — whoever has the key can write |
| Forge member-update | Low | Current adapters require a valid envelope signature and creator-derived authority; core disposition evaluation exists for future pending/unverified adapter handling |
| Manipulate local data | Medium | Compromised device = game over |

### R — Repudiation (Deniability)

| Threat | Risk | Mitigation |
|--------|------|------------|
| Deny attestation | Low | Ed25519 signature proves authorship |
| Deny verification | Low | Signature proves action |
| Deny CRDT change | Medium | CRDT changes are not individually signed — `fromDid` in EncryptedSyncService, but no per-change proof |

### I — Information Disclosure

| Threat | Risk | Mitigation |
|--------|------|------------|
| Server reads content | Low | E2E encryption (AES-256-GCM) |
| Network sniffer | Low | TLS + E2E |
| Metadata leak | Medium | Server sees timing, IP, DID pairs, message sizes |
| Device loss (unlocked) | High | All local data readable |
| Device loss (locked) | Low | OS encryption protects |
| Recovery phrase compromised | Critical | Full access to identity + all data |

### D — Denial of Service

| Threat | Risk | Mitigation |
|--------|------|------------|
| Relay DDoS | Medium | Standard DDoS protection, app works offline |
| Spam messages | Low | Relay only accepts messages to registered DIDs |
| Storage attack (vault) | Medium | Vault auth (JWS identity proof), rate limiting |

### E — Elevation of Privilege

| Threat | Risk | Mitigation |
|--------|------|------------|
| Member becomes admin authority | Low | Current adapters derive authority from creator state; core disposition semantics are available for future admin/member authority classification |
| Server abuses power | Low | Server has no content rights (E2E) |
| Member grants self admin rights | Low | Current adapters require signed messages and creator-derived authority; durable pending/canonical confirmation semantics are pending adapter work |

---

## Scenarios

### Scenario 1: Compromised Relay

```text
Attacker controls the relay server.

Can:
  - Store/analyze encrypted messages (ciphertext)
  - Collect metadata (who communicates when with whom)
  - Delay or drop messages (DoS)
  - Perform traffic analysis

Cannot:
  - Decrypt content (no GroupKey)
  - Forge sender (envelope signature)
  - Add/remove members without passing the current adapter signature and creator-derived authority checks
  - Steal identities (private keys only local)
```

### Scenario 2: Malicious Space Member

```text
Bob is a member of a space and has the GroupKey.

Can:
  - Read all space content (has GroupKey)
  - Write/modify content (has GroupKey)
  - Share GroupKey with third parties (out-of-band)
  - Take screenshots, copy content
  - Change space name and image

Cannot:
  - Remove other members without current creator-derived authority
  - Officially invite new members without passing current adapter authorization checks
  - Forge member-update that passes current envelope signature and authority checks; future adapter work will classify unknown/lower-authority updates as unverified-pending or ignored
  - Read other spaces (separate GroupKey per space)
```

**Mitigation:** Current authorized removal rotates keys so Bob is locked out of new content. Old content remains compromised. Canonical pending-state confirmation is planned adapter work, not current runtime behavior.

### Scenario 3: Recovery Phrase Compromised

```text
Attacker knows the 12 words.

Can:
  - Restore identity on another device
  - Derive all keys (HKDF is deterministic)
  - Decrypt all encrypted data
  - Act as victim (sign, attest)
  - Enter all spaces (GroupKeys retrievable from vault/relay)

Required response:
  1. Create new identity
  2. Inform all contacts
  3. Re-verify with contacts
  4. Leave old spaces, create new ones
```

**Critical:** Recovery phrase = full access. Not revocable. Therefore: phrase on paper only, never store digitally.

### Scenario 4: Stolen Device (Unlocked)

```text
Attacker has physical access to an unlocked device.

Can:
  - See all local data (IndexedDB)
  - Act as victim (private key is loaded)
  - Create new attestations
  - Read and write to spaces

Cannot:
  - Export private key (extractable: false in Web Crypto)
  - See recovery phrase (not stored after onboarding)

Mitigation:
  - Recommend device lock
  - Biometric auth for sensitive actions (TODO)
  - Remote wipe signaling (TODO)
```

---

## Trust Hierarchy

```text
1. Own private key          → Full control over identity
2. Recovery phrase          → Can reconstruct key (= #1)
3. GroupKey (per space)     → Read + write in that space
4. Verified contacts       → See shared content, can attest
5. Relay server            → Transport only, sees ciphertext + metadata
6. Vault server            → Backup only, sees ciphertext
7. Unverified              → See only public profile (if available)
```

---

## Accepted Risks

| Risk | Description | Why accepted |
|------|-------------|--------------|
| **Metadata** | Server sees communication patterns | Trade-off with usability, VPN as option |
| **Screenshots** | Contacts can photograph content | Technically not preventable |
| **Social engineering** | Verify wrong person | User responsibility, face-to-face minimizes risk |
| **No read-only** | All members can write | Requires CGKA (Keyhive), earliest 2027 |
| **GroupKey sharing** | Member shares key out-of-band | Unavoidable with symmetric encryption |
| **No ratchet** | Key remains valid until rotation | Key rotation only on removeMember |
