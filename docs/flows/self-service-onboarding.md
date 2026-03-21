# Self-Service Onboarding Flow

## Overview

This flow describes the complete process by which a person joins the Web of Trust. The process is designed to be self-explanatory and shareable by multipliers.

**Goal:** A simple, self-guided process from invitation to a finished profile with QR code.

**Technical prerequisite (2026):** All relevant browsers natively support Ed25519 via the Web Crypto API.

> **Out of scope:** Shop integration (Zeitgutschein ordering, affiliate tracking) is explicitly out of scope for the current implementation. The relevant steps are marked below.

---

## User journey

```text
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│Invitation│───►│  Join    │───►│ Create   │───►│  Invite  │
│ received │    │  WoT     │    │ profile  │    │ (others) │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │               │               │               │
     │               │               │               │
   Link/QR       Generate        Name,             Own
   scan          keys            portrait          invite
                 Save                              link
                 recovery
```

---

## Step 1: Receive invitation

### Context

A person receives an invitation from someone already in the Web of Trust — either as:

- A link (via messenger, email, etc.)
- A QR code (on a time voucher or business card)

### URL structure

```text
https://web-of-trust.de/join/{inviter-did-fragment}/{invite-code}

Example:
https://web-of-trust.de/join/z6MkhaXg/A7B3C9
```

**Components:**

- `z6MkhaXg` — Short form of the inviter's DID (first 8 characters after `z`)
- `A7B3C9` — One-time invite code (prevents spam, enables tracking)

### Landing page

```text
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                     🌐 Web of Trust                             │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                                                         │   │
│   │              [Portrait of inviter]                      │   │
│   │                                                         │   │
│   │                    Timo                                 │   │
│   │               has invited you                           │   │
│   │                                                         │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Web of Trust is a decentralised network for                    │
│  genuine connections between people.                            │
│                                                                 │
│  • Your identity belongs to you (not a platform)               │
│  • Trust is built through real encounters                       │
│  • No central control, no surveillance                          │
│                                                                 │
│               ┌─────────────────────────┐                       │
│               │        Join now         │                       │
│               └─────────────────────────┘                       │
│                                                                 │
│  Already a member? [Sign in]                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 2: Join the Web of Trust

### 2.1 Generate key pair

**User sees:**

```text
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                  Your digital identity                          │
│                                                                 │
│  We are now creating your personal key pair.                    │
│  Think of it as a digital fingerprint — unique                  │
│  and only yours.                                                │
│                                                                 │
│                    [Spinner / animation]                        │
│                                                                 │
│              Generating keys...                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Under the hood:**

```typescript
// 1. Generate 128-bit entropy for 12 words
const entropy = crypto.getRandomValues(new Uint8Array(16));

// 2. Derive mnemonic from entropy (BIP39, German wordlist)
const mnemonic = entropyToMnemonic(entropy, germanWordlist); // 12 words

// 3. Derive seed from mnemonic (BIP39 standard)
const seed = await mnemonicToSeed(mnemonic);

// 4. Derive HKDF master key (non-extractable)
const masterKey = await crypto.subtle.importKey(
  'raw', seed,
  { name: 'HKDF' },
  false, // non-extractable
  ['deriveKey', 'deriveBits']
);

// 5. Derive Ed25519 signing key via HKDF
const signingKeyBytes = await crypto.subtle.deriveBits(
  { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encode('sign') },
  masterKey,
  256
);

// 6. Compute DID from public key
const publicKey = ed25519.getPublicKey(new Uint8Array(signingKeyBytes));
const did = createDidFromPublicKey(publicKey); // did:key:z6Mk...

// 7. Store master key in IndexedDB (non-extractable CryptoKey object)
await keyStorage.store(masterKey);
```

### 2.2 Show recovery phrase

**CRITICAL:** The recovery phrase is shown ONCE and is the ONLY way to restore the identity.

**User sees:**

```text
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│              ⚠️  Your recovery phrase                          │
│                                                                │
│  These 12 words are the ONLY way to restore your identity.     │
│  Write them down on paper RIGHT NOW.                           │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                                                         │   │
│  │   1. absurd      2. banane     3. chaos                 │   │
│  │   4. donner      5. eiche      6. falke                 │   │
│  │   7. garten      8. hafen      9. insel                 │   │
│  │  10. jagd       11. kiste     12. lampe                 │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ □ I have written the words on paper                     │   │
│  │ □ I understand that without these words I lose          │   │
│  │   access to my identity                                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│               ┌─────────────────────────┐                      │
│               │        Continue         │  (disabled until ✓✓) │
│               └─────────────────────────┘                      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**UI rules:**

- No screenshot capability (where technically possible)
- Navigation blocked until both checkboxes are ticked
- No "Back" button — words are shown only once
- No copy to clipboard

### 2.3 Recovery phrase quiz

**User sees:**

```text
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                    Security check                               │
│                                                                 │
│  Please confirm that you have written down the words.           │
│                                                                 │
│  What is the 4th word?                                          │
│                                                                 │
│     ○ chaos                                                     │
│     ○ donner    ←                                              │
│     ○ eiche                                                     │
│     ○ falke                                                     │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  What is the 9th word?                                          │
│                                                                 │
│     ○ hafen                                                     │
│     ○ insel     ←                                              │
│     ○ jagd                                                      │
│     ○ kiste                                                     │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  What is the 11th word?                                         │
│                                                                 │
│     ○ insel                                                     │
│     ○ jagd                                                      │
│     ○ kiste     ←                                              │
│     ○ lampe                                                     │
│                                                                 │
│               ┌─────────────────────────┐                      │
│               │        Confirm          │                      │
│               └─────────────────────────┘                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Logic:**

- 3 random positions out of 12
- Multiple choice with 4 options (1 correct, 3 wrong from word list)
- On failure: return to recovery phrase display

---

## Step 3: Create profile

### User sees

```text
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                    Your profile                                 │
│                                                                 │
│  ┌──────────────┐                                              │
│  │              │                                              │
│  │   [Camera]   │  Add photo (optional)                        │
│  │              │                                              │
│  └──────────────┘                                              │
│                                                                 │
│  Name *                                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Lisa                                                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Short description                                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Gardener & community person                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  What I offer (optional)                                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Gardening, herbal knowledge, jam                        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Contact (optional, shown on your profile)                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Email: lisa@example.com                                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│               ┌─────────────────────────┐                      │
│               │      Create profile     │                      │
│               └─────────────────────────┘                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Under the hood:**

```typescript
const profile = {
  did: "did:key:z6Mk...",
  name: "Lisa",
  bio: "Gardener & community person",
  offerings: ["Gardening", "herbal knowledge", "jam"],
  contact: {
    email: "lisa@example.com"
  },
  portrait: "base64...", // optional
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

// Sign with JWS
const signedProfile = await identity.signJws(profile);

// Store in PersonalDoc CRDT (Y.Map)
personalDoc.profile.set('data', signedProfile);

// Push to wot-profiles server (public discovery)
await profileService.signProfile(profile);
```

---

## Step 4: First verification

After joining, the inviter automatically becomes the first contact.

**User sees:**

```text
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│             ✓ Welcome to Web of Trust, Lisa!                   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                                                         │   │
│  │  Your first contact:                                    │   │
│  │                                                         │   │
│  │  ┌────────┐                                            │   │
│  │  │ [Photo]│  Timo                                      │   │
│  │  └────────┘  invited you                               │   │
│  │                                                         │   │
│  │  Status: Connection pending                            │   │
│  │                                                         │   │
│  │  Tip: Next time you meet Timo in person, scan          │   │
│  │  each other's QR codes to verify the connection.      │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  What would you like to do next?                               │
│                                                                 │
│  ┌─────────────────────────┐  ┌─────────────────────────┐     │
│  │    Invite others        │  │    View my profile      │     │
│  └─────────────────────────┘  └─────────────────────────┘     │
│                                                                 │
│  ┌─────────────────────────┐                                   │
│  │    Download QR code     │                                   │
│  └─────────────────────────┘                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 5: Invite others

Every user can create invitations after joining.

**User sees:**

```text
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                   Invite others                                 │
│                                                                 │
│  Share your invite link:                                        │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ https://web-of-trust.de/join/z6MkhaXg/L9X2K7            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  [Copy]  [WhatsApp]  [Telegram]  [Email]                        │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  Or show your QR code:                                          │
│                                                                 │
│           ┌───────────────────┐                                │
│           │                   │                                │
│           │     [QR code]     │                                │
│           │                   │                                │
│           └───────────────────┘                                │
│                                                                 │
│  [Save as image]  [Print]                                       │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  Your invitations:                                              │
│                                                                 │
│  • L9X2K7 — Not yet redeemed                                   │
│  • M4N8P2 — Max (joined 25.01.2026)                            │
│  • K7R3W9 — Not yet redeemed                                   │
│                                                                 │
│  [Create new invitation]                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Public profile page

URL: `https://web-of-trust.de/p/{did}` or short form `https://web-of-trust.de/p/{did-fragment}`

**View for visitors:**

```text
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │                    [Portrait]                            │  │
│  │                                                          │  │
│  │                       Lisa                               │  │
│  │             Gardener & community person                  │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  What I offer:                                                  │
│  • Gardening                                                    │
│  • Herbal knowledge                                             │
│  • Jam                                                          │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  Contact:                                                       │
│  📧 lisa@example.com                                            │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ ✓ Verified identity                                      │  │
│  │                                                          │  │
│  │ This profile is cryptographically signed.                │  │
│  │ DID: did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2Qt...       │  │
│  │                                                          │  │
│  │ Member since: January 2026                               │  │
│  │ Verified by: 3 people                                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│               ┌─────────────────────────┐                      │
│               │   Join Web of Trust     │                      │
│               └─────────────────────────┘                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Technical architecture

### Components

```text
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND                                 │
│                   (web-of-trust.de)                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │  Join flow  │  │   Profile   │  │   Invite    │            │
│  │             │  │   editor    │  │   manager   │            │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
│         │                │                │                    │
│         └────────────────┼────────────────┘                    │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   WotIdentity                            │   │
│  │  • generateMnemonic()     (BIP39, German wordlist)       │   │
│  │  • unlock(mnemonic)       (HKDF master key)              │   │
│  │  • signJws(payload)       (Ed25519)                      │   │
│  │  • getDid()               (did:key:z6Mk...)              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                      │
│         ┌────────────────┼──────────────────┐                  │
│         ▼                ▼                  ▼                  │
│  ┌───────────┐    ┌───────────┐    ┌─────────────┐            │
│  │ IndexedDB │    │  Web      │    │  PersonalDoc│            │
│  │ (keys)    │    │  Crypto   │    │  CRDT (Yjs) │            │
│  └───────────┘    └───────────┘    └─────────────┘            │
│                                          │                      │
└──────────────────────────────────────────┼──────────────────────┘
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              RELAY + VAULT + PROFILES                           │
├─────────────────────────────────────────────────────────────────┤
│  • Relay (wss://relay.utopia-lab.org) — real-time sync          │
│  • Vault — encrypted PersonalDoc backup (recovery)             │
│  • wot-profiles (https://profiles.utopia-lab.org) — discovery  │
│  No plaintext data, no private keys ever leave the device       │
└─────────────────────────────────────────────────────────────────┘
```

### Onboarding data flow

```text
1. User opens invite link
   ↓
2. Frontend checks: invite code valid?
   ↓
3. User clicks "Join"
   ↓
4. Browser generates:
   - 128-bit entropy → 12-word mnemonic (BIP39, German wordlist)
   - Mnemonic → seed (BIP39 standard)
   - Seed → HKDF master key (Web Crypto API, non-extractable)
   - HKDF → Ed25519 signing key → did:key:z6Mk...
   ↓
5. User sees mnemonic, writes it down, passes quiz
   ↓
6. User fills in profile
   ↓
7. Profile signed with JWS (WotIdentity.signJws())
   ↓
8. Master key → IndexedDB (non-extractable CryptoKey)
   Profile → PersonalDoc CRDT (Y.Map)
   Signed profile → wot-profiles server (public discovery)
   ↓
9. Invite code marked as redeemed
   Connection to inviter created (pending verification)
   ↓
10. User has profile + can invite others
```

### URL routing

| URL | Function |
|-----|----------|
| `/join/{did-fragment}/{code}` | Accept invitation |
| `/p/{did}` | Public profile (full DID) |
| `/p/{did-fragment}` | Public profile (short form, redirect) |
| `/invite` | Manage invitations (logged in) |
| `/profile` | Edit own profile (logged in) |
| `/recover` | Restore identity |

---

## Security aspects

### Private key / master key

- **Never** extractable (`extractable: false`)
- **Never** sent to any server
- **Only** in IndexedDB as a non-extractable CryptoKey object
- **Only** recoverable via the recovery phrase

### Recovery phrase

- **Shown once**, never again
- **Never** stored (neither locally nor remotely)
- **User** is responsible for safe storage
- **Loss** = loss of identity

### Profile signature

- Every profile is signed with JWS (Ed25519)
- Signature verifiable with public key (derivable from DID)
- Tampering is detectable

### Invite codes

- Single-use
- Optional: expiry date
- Prevent spam joins
- Enable tracing (who invited whom)

---

## Open decisions

1. **Invite limit:** How many invitations can a user create?
2. **Required profile fields:** Name only, or more?
3. **Short links:** Own domain or subdomain?

---

## Implementation order

### Phase 1: Core identity (Priority: High)

1. MnemonicService (BIP39, German wordlist)
2. WotIdentity.unlock() (HKDF master key)
3. Non-extractable key storage (IndexedDB)
4. DID generation — already exists
5. Profile signing (JWS) — already exists

### Phase 2: Onboarding UI (Priority: High)

1. Join flow landing page
2. Mnemonic display + quiz
3. Profile editor
4. Welcome screen

### Phase 3: Profile & invitations (Priority: High)

1. Public profile page
2. Invite link generation
3. Invitation management UI

### Phase 4: Sync & recovery (Priority: Medium)

1. Vault backup on profile creation
2. Recovery flow (WotIdentity.unlock() + Vault restore)
3. Multi-device support

### Phase 5: Shop integration (OUT OF SCOPE)

> The Zeitgutschein shop, QR codes on vouchers, and affiliate tracking are out of scope for the current implementation phase. These will be revisited separately if and when a shop integration is planned.

---

*Document created: January 2026*
*Version: 1.1 — Updated to English, HKDF, PersonalDoc CRDT, Relay + Vault architecture*
