# Recovery Flow (User Perspective)

> How an identity is restored after losing access

## When do I need recovery?

| Situation | Recovery needed? |
| --------- | ---------------- |
| Device lost | Yes |
| Device stolen | Yes |
| App deleted | Yes |
| Browser data cleared (Web) | Yes |
| New device | Yes (or Multi-Device Setup) |
| App update | No |
| Password forgotten | There is no password |

---

## Prerequisite: Recovery Phrase

The recovery phrase is the **only way** to restore your identity.

```
┌─────────────────────────────────┐
│                                 │
│  ⚠️  IMPORTANT                  │
│                                 │
│  Your recovery phrase was       │
│  shown to you ONCE when you     │
│  created your identity.         │
│                                 │
│  It CANNOT be retrieved         │
│  again.                         │
│                                 │
│  Without it your identity       │
│  is LOST.                       │
│                                 │
└─────────────────────────────────┘
```

---

## Main flow: Restore identity

```mermaid
sequenceDiagram
    participant U as User
    participant App as New App
    participant Relay as Relay + Vault

    Note over U: New device / App freshly installed

    U->>App: Opens app
    App->>U: Welcome! New here or restore?

    U->>App: Taps "Restore"

    App->>U: Enter recovery phrase

    U->>App: Types 12 words

    App->>App: Validates words (BIP39)
    App->>App: Derives master key via HKDF
    App->>App: Computes DID

    App->>Relay: Fetch data for DID (Vault restore)
    Relay->>App: Encrypted PersonalDoc snapshot

    App->>App: Decrypts with derived key

    App->>U: Welcome back!
```

---

## What the user sees

### Start screen (fresh install)

```
┌─────────────────────────────────┐
│                                 │
│      🌐 Web of Trust            │
│                                 │
├─────────────────────────────────┤
│                                 │
│  ┌─────────────────────────┐    │
│  │                         │    │
│  │  New here?              │    │
│  │                         │    │
│  │  Create a new           │    │
│  │  identity               │    │
│  │                         │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │                         │    │
│  │  Restore                │    │
│  │                         │    │
│  │  I already have         │    │
│  │  an identity            │    │
│  │                         │    │
│  └─────────────────────────┘    │
│                                 │
└─────────────────────────────────┘
```

### Enter recovery phrase

```
┌─────────────────────────────────┐
│                                 │
│  Restore identity               │
│                                 │
├─────────────────────────────────┤
│                                 │
│  Enter your 12 words:           │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 1. absurd               │    │
│  └─────────────────────────┘    │
│  ┌─────────────────────────┐    │
│  │ 2. banane               │    │
│  └─────────────────────────┘    │
│  ┌─────────────────────────┐    │
│  │ 3. chaos                │    │
│  └─────────────────────────┘    │
│  ┌─────────────────────────┐    │
│  │ 4.                      │    │
│  └─────────────────────────┘    │
│        ...                      │
│  ┌─────────────────────────┐    │
│  │ 12.                     │    │
│  └─────────────────────────┘    │
│                                 │
│  [ Restore ]                    │
│                                 │
└─────────────────────────────────┘
```

### Restoration in progress

```
┌─────────────────────────────────┐
│                                 │
│  Restoring...                   │
│                                 │
├─────────────────────────────────┤
│                                 │
│  ████████████░░░░░░░ 60%        │
│                                 │
│  ✅ Keys derived                │
│  ✅ Identity found              │
│  ⏳ Loading data...             │
│  ⬜ Loading contacts            │
│  ⬜ Loading content             │
│                                 │
└─────────────────────────────────┘
```

### Restoration successful

```
┌─────────────────────────────────┐
│                                 │
│  ✅ Welcome back!               │
│                                 │
├─────────────────────────────────┤
│                                 │
│  Your identity has been         │
│  restored:                      │
│                                 │
│         [Profile photo]         │
│          Anna Müller            │
│                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━    │
│                                 │
│  Restored:                      │
│                                 │
│  👥 23 contacts                 │
│  📜 47 attestations             │
│  📅 12 calendar entries         │
│  📍 8 map markers               │
│                                 │
│  [ Let's go ]                   │
│                                 │
└─────────────────────────────────┘
```

---

## Error case: Wrong phrase

```
┌─────────────────────────────────┐
│                                 │
│  ❌ Invalid phrase              │
│                                 │
├─────────────────────────────────┤
│                                 │
│  The recovery phrase you        │
│  entered is not valid.          │
│                                 │
│  Possible reasons:              │
│                                 │
│  • Word misspelled              │
│  • Words in wrong order         │
│  • Wrong word used              │
│                                 │
│  Please check your notes        │
│  and try again.                 │
│                                 │
│  [ Try again ]                  │
│                                 │
└─────────────────────────────────┘
```

---

## Error case: No recovery phrase

```mermaid
flowchart TD
    Lost(["Device lost"]) --> HasPhrase{"Recovery phrase available?"}

    HasPhrase -->|Yes| Recover["Restore"]
    Recover --> Success["Everything restored"]

    HasPhrase -->|No| Gone["Identity lost"]
    Gone --> NewID["Create new identity"]
    NewID --> Reverify["All contacts must verify you again"]
    NewID --> LostAttestations["Old attestations lost"]

    style Gone stroke:#FF6B6B,color:#FF6B6B
    style LostAttestations stroke:#FF6B6B,color:#FF6B6B
```

### What is lost

```
┌─────────────────────────────────┐
│                                 │
│  Without recovery phrase        │
│                                 │
├─────────────────────────────────┤
│                                 │
│  Unfortunately we cannot        │
│  restore your identity.         │
│                                 │
│  What is lost:                  │
│                                 │
│  ❌ Your identity (DID)         │
│  ❌ All verifications           │
│  ❌ All received attestations   │
│  ❌ Your profile                │
│                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━    │
│                                 │
│  You can create a new identity, │
│  but you will need to:          │
│                                 │
│  • Meet all contacts again      │
│  • Collect new attestations     │
│                                 │
│  [ Create new identity ]        │
│                                 │
└─────────────────────────────────┘
```

---

## Personas

### Greta loses her phone

```mermaid
sequenceDiagram
    participant G as Greta
    participant T as Tom (neighbor)
    participant App as New App

    Note over G: Phone stolen

    Note over G,T: Tom helps Greta with backup

    G->>G: Gets notebook with phrase

    G->>App: Installs app on new phone

    G->>App: Taps "Restore"

    G->>App: Types 12 words (with reading glasses)

    App->>G: Welcome back, Greta!

    Note over G: All data is back
```

### Lena (skeptic) tests recovery

```mermaid
sequenceDiagram
    participant L as Lena
    participant Phone as Phone
    participant Web as Browser

    Note over L: Testing the system

    L->>Phone: Creates identity

    L->>L: Notes recovery phrase

    L->>Web: Opens web app
    L->>Web: Enters recovery phrase

    Web->>L: Identity restored

    Note over L: Same identity on both devices
    Note over L: System works as documented
```

### Familie Yilmaz without phrase

```mermaid
sequenceDiagram
    participant Y as Familie Yilmaz
    participant App as App

    Note over Y: Phone broken, phrase not written down

    Y->>App: Attempts restoration

    App->>Y: Enter recovery phrase

    Y->>Y: Phrase not written down...

    App->>Y: No restoration without phrase

    Note over Y: Must create new identity
    Note over Y: Must meet all contacts again
```

---

## Recovery on different platforms

### iOS / Android

```
┌─────────────────────────────────┐
│                                 │
│  After restoration:             │
│                                 │
│  ✅ Master key derived via HKDF │
│     stored in secure storage    │
│                                 │
│  ✅ All data loaded             │
│     from Vault                  │
│                                 │
│  ✅ Push notifications          │
│     activated                   │
│                                 │
└─────────────────────────────────┘
```

### Web (Browser)

```
┌─────────────────────────────────┐
│                                 │
│  ⚠️  Web note                   │
│                                 │
│  In the browser your key is     │
│  protected by the Web Crypto    │
│  API and cannot be extracted.   │
│                                 │
│  WARNING: If you use "Clear     │
│  browser data" you will need    │
│  to restore again using         │
│  your recovery phrase.          │
│                                 │
│  [ Understood ]                 │
│                                 │
└─────────────────────────────────┘
```

---

## What happens to ongoing processes?

### Pending verifications

```mermaid
flowchart TD
    Before(["Before the loss"]) --> Pending["Pending verification with Ben"]

    Pending --> Lost["Device lost"]

    Lost --> Recover["Recovery on new device"]

    Recover --> Status{"Pending status?"}

    Status --> StillPending["Still pending"]
    StillPending --> Continue["Ben can now verify you"]
```

**Result:** Pending verifications are preserved. The other person can still verify you.

### Unsynced changes

```mermaid
flowchart TD
    Before(["Before the loss"]) --> Unsaved["3 changes not yet synced"]

    Unsaved --> Lost["Device lost"]

    Lost --> Recover["Recovery"]

    Recover --> OnlyVault["Only Vault data available"]

    OnlyVault --> Missing["Unsynced changes lost"]

    style Missing stroke:#FFE4B5,color:#FFE4B5
```

**Result:** Changes that were not synced before the loss are gone.

---

## Security notes

### Store your phrase safely

```
┌─────────────────────────────────┐
│                                 │
│  Recommendations                │
│                                 │
├─────────────────────────────────┤
│                                 │
│  ✅ Write on paper              │
│                                 │
│  ✅ Store in a safe place       │
│     (not on your phone!)        │
│                                 │
│  ✅ Consider a second copy      │
│     at a different location     │
│                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━    │
│                                 │
│  ❌ Do not store digitally      │
│     (photos, note apps, cloud)  │
│                                 │
│  ❌ Do not send via email/chat  │
│                                 │
│  ❌ Do not take a screenshot    │
│                                 │
└─────────────────────────────────┘
```

### If you suspect compromise

```
┌─────────────────────────────────┐
│                                 │
│  ⚠️  Phrase compromised?        │
│                                 │
├─────────────────────────────────┤
│                                 │
│  If you believe someone         │
│  knows your phrase:             │
│                                 │
│  1. Create a NEW identity       │
│                                 │
│  2. Inform your contacts        │
│                                 │
│  3. Get re-verified             │
│                                 │
│  The old identity should        │
│  no longer be used.             │
│                                 │
└─────────────────────────────────┘
```

---

## FAQ

**Can I change my phrase?**
No. The phrase is permanently bound to your identity. A new phrase means a new identity.

**What if I wrote down a word incorrectly?**
The app checks whether all words are valid (BIP39 word list). If a word is wrong, the phrase is rejected.

**Can support help me?**
No. Nobody but you knows your phrase. That is intentional — so nobody can steal it.

**Can I view the phrase again later?**
No. The phrase is shown only once at identity creation and is not stored anywhere afterwards.
