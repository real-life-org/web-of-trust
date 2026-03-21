# Privacy

> Data protection considerations in the Web of Trust.

*As of March 17, 2026*

---

## Core Principles

### Data Minimization

Only required data is collected:

- Name (self-chosen)
- Photo (optional)
- Contacts (only verified)
- Self-created content

Not collected:

- No phone number
- No email address
- No location data (unless explicitly in items)
- No address book upload
- No operator account required

### Local Control

- All data stored locally (IndexedDB)
- Export possible at any time
- Deletion possible (local + server request)
- No operator account needed

---

## What the Servers See

### Relay Server (wss://relay.utopia-lab.org)

| What the relay sees | What it does NOT see |
|---------------------|---------------------|
| DID pairs (who to whom) | Message content (E2E encrypted) |
| Timing (when sync occurs) | Profile data |
| Message sizes | Attestations |
| IP addresses | Space content |
| Message types (space-invite, content, etc.) | GroupKeys |

### Vault Server (https://vault.utopia-lab.org)

| What the vault sees | What it does NOT see |
|---------------------|---------------------|
| Encrypted blobs | Plaintext content |
| DID of the owner | What the docs contain |
| Document sizes | Who is a member |
| Access timestamps | GroupKeys |

### Profiles Server (https://profiles.utopia-lab.org)

| What the server sees | Note |
|---------------------|------|
| Public profile (name, bio, photo) | Intentionally public, JWS-signed |
| DID | Pseudonym, not real identity |

### Contact Graph

The relay can partially infer who communicates with whom (DID pairs). However, it does not know who is behind the DIDs — only pseudonymous identifiers.

**Mitigation options (not implemented):**

- Padding (all messages same size)
- Dummy traffic
- Onion routing

**Current decision:** Accepted as trade-off for usability.

---

## Anonymity vs. Pseudonymity

Users are **pseudonymous**, not anonymous:

- DID = random pseudonym (no name, no email)
- Name = self-chosen (can be a pseudonym)
- Verification = face-to-face — the verifier knows the real person

De-anonymization possible through:

| Method | Risk |
|--------|------|
| Verifier knows real identity | High |
| Attestation content reveals details | Medium |
| Metadata correlation | Medium |
| IP analysis | Medium (VPN as mitigation) |

---

## GDPR Compliance

### User Rights

| Right | Implementation |
|-------|---------------|
| Access (Art. 15) | Export function |
| Rectification (Art. 16) | Profile editable |
| Erasure (Art. 17) | Local deletion + server request |
| Data portability (Art. 20) | JSON export (PersonalDoc) |
| Objection (Art. 21) | No profiling, no tracking |

### Deletion

| Data type | Deletable? | Note |
|-----------|-----------|------|
| Profile | Yes | Local + profiles server |
| Space content | Yes | Local deletion, key rotation |
| Contacts | Hideable | Via excludedMembers |
| Verifications | No | Immutable, stored at recipient |
| Attestations | Hideable | Recipient can set `hidden=true` |

### Recipient Principle

Verifications and attestations are stored at the **recipient**, not the sender:

- Recipient controls what is visible about them
- No write conflicts (everyone writes only to their own store)
- Attestations can be hidden (`hidden=true`)
- Verifications cannot be hidden (they control contact status)

### Why Verifications/Attestations Are Not Deletable

Verifications and attestations are signed statements about the past ("I met Anna on 2025-01-05"). These facts cannot be undone. However, the recipient can hide attestations.

---

## Recommendations for Users

For maximum privacy:

- Use a pseudonymous profile
- Don't upload a real photo
- Use a VPN
- Only verify trustworthy people
- Be careful with attestation content
- Recovery phrase on paper only, never store digitally
