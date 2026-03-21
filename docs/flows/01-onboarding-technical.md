# Onboarding Flow (Technical Perspective)

> How a new identity is created and integrated into the network

## Detail Flow: Identity Creation

```mermaid
flowchart TD
    Start(["User taps Create identity"]) --> Entropy["Collect entropy — CSPRNG"]

    Entropy --> GenMnemonic["Generate BIP39 mnemonic — 12 words, German wordlist"]

    GenMnemonic --> DeriveSeed["Derive master key from mnemonic — HKDF (non-extractable)"]

    DeriveSeed --> GenKeyPair["Derive Ed25519 key pair from master key"]

    GenKeyPair --> CreateDID["Create DID — did:key:z6Mk..."]

    CreateDID --> StorePrivate["Store key in Secure Storage (non-extractable CryptoKey)"]

    StorePrivate --> BlockNav["Block navigation"]

    BlockNav --> ShowMnemonic["Show mnemonic ONCE"]

    ShowMnemonic --> StartQuiz["Start quiz — 3 random word positions"]

    StartQuiz --> Question{"Question N of 3"}

    Question -->|Correct| NextQ{"All 3 correct?"}
    NextQ -->|No| Question
    NextQ -->|Yes| MarkSecured["Mark backup as verified"]

    Question -->|Wrong| ShowError["Show error and correct answer"]
    ShowError --> ShowMnemonic

    MarkSecured --> CreateProfile["Create PersonalDoc CRDT (Y.Map)"]

    CreateProfile --> SignProfile["Sign profile with private key (JWS)"]

    SignProfile --> Ready(["Identity ready"])

    style ShowMnemonic stroke:#f59e0b,stroke-width:2px
    style BlockNav stroke:#ef4444,stroke-width:2px
```

## Sequence Diagram: Full Onboarding

```mermaid
sequenceDiagram
    participant A_App as Anna App
    participant QR as QR Code
    participant B_Cam as Ben Camera
    participant Store as App Store
    participant B_App as Ben App
    participant B_Secure as Ben Secure Storage
    participant Relay as Relay (WebSocket)

    Note over A_App,Relay: Phase 1 — Invitation

    A_App->>QR: generateInviteQR()
    Note over QR: App store link + Anna DID + public key

    B_Cam->>QR: scan()
    B_Cam->>B_Cam: parseQR()

    alt App not installed
        B_Cam->>Store: openAppStore(link)
        Store->>B_App: install()
        B_App->>B_App: launch with deep link
    else App already installed
        B_Cam->>B_App: openApp with deep link
    end

    Note over A_App,Relay: Phase 2 — Load Anna's profile

    alt Online
        B_App->>Relay: fetchProfile(anna.did)
        Relay->>B_App: name, photo, bio, JWS signature
        B_App->>B_App: verifyJws(profile, anna.publicKey)
    else Offline
        B_App->>B_App: Show DID and public key info only
    end

    B_App->>B_App: displayInviter(anna)

    Note over A_App,Relay: Phase 3 — Create identity

    B_App->>B_App: collectUserInput() — name, photo, bio
    B_App->>B_App: generateEntropy(256 bit)
    B_App->>B_App: createMnemonic(entropy) — 12 words, German BIP39
    B_App->>B_App: deriveMasterKey(mnemonic) — HKDF, non-extractable
    B_App->>B_App: deriveKeyPair(masterKey) — Ed25519
    B_App->>B_App: createDid(publicKey) — did:key:z6Mk...

    B_App->>B_Secure: storeKey(non-extractable CryptoKey)
    B_Secure->>B_App: ok

    B_App->>B_App: displayMnemonic() — ONCE ONLY
    B_App->>B_App: startQuiz() — 3 random positions

    loop Quiz until 3 correct answers
        B_App->>B_App: showQuestion()
        alt Correct
            B_App->>B_App: nextQuestion()
        else Wrong
            B_App->>B_App: showError()
            B_App->>B_App: displayMnemonic() — again
            B_App->>B_App: startQuiz() — new positions
        end
    end

    B_App->>B_App: markBackupVerified()

    Note over A_App,Relay: Phase 4 — Create profile document

    B_App->>B_App: createPersonalDoc() — Y.Doc with Y.Maps
    B_App->>B_App: signProfile(privateKey) — JWS
    B_App->>B_App: persistToCompactStore(local IDB)

    Note over A_App,Relay: Phase 5 — Mutual verification

    B_App->>B_App: createVerification(anna.did)
    B_App->>B_App: storeContact(anna, pending)

    B_App->>B_App: generateQR(ben.did, ben.publicKey)
    B_App->>A_App: physical QR scan

    A_App->>A_App: parseQR() — ben.did, ben.publicKey
    A_App->>A_App: createVerification(ben.did)
    A_App->>A_App: storeContact(ben, active)
    A_App->>A_App: addToAutoGroup(ben)
    A_App->>A_App: reencryptItemKeysForNewContact(ben)

    Note over A_App,Relay: Phase 6 — Sync

    A_App->>Relay: push verification, profile, itemKeys
    B_App->>Relay: push verification, profile

    Relay->>B_App: pull anna verification
    B_App->>B_App: updateContact(anna, active)
    B_App->>B_App: addToAutoGroup(anna)

    Relay->>B_App: pull anna itemKeys for ben
    B_App->>B_App: Can now decrypt Anna's content
```

## Cryptographic Details

### Key Generation

```mermaid
flowchart LR
    subgraph Input
        CSPRNG["CSPRNG — 256 bit entropy"]
    end

    subgraph BIP39["BIP39 Process"]
        Checksum["Add checksum (8 bits)"]
        Split["Split into 11-bit chunks"]
        Words["Map to German wordlist"]
    end

    subgraph KeyDerivation["Key Derivation"]
        HKDF["HKDF (non-extractable CryptoKey)"]
        MasterKey["Master Key"]
        Ed25519["Ed25519 derive"]
        X25519["X25519 derive (separate path)"]
    end

    subgraph Output
        PrivKey["Private Key (32 bytes)"]
        PubKey["Public Key (32 bytes)"]
        DID["DID — did:key:z6Mk..."]
    end

    CSPRNG --> Checksum --> Split --> Words
    Words -->|12 words| HKDF
    HKDF --> MasterKey --> Ed25519
    MasterKey --> X25519
    Ed25519 --> PrivKey
    Ed25519 --> PubKey
    PubKey -->|multibase encode| DID
```

### DID Structure

```
did:key:z6MkpTHz8SrJgQi3oWFG7Ahs7pFHCmzCyMFVMdBr9ZFm
        └──────────────────────────────────────────── Multibase-encoded
                                                       Ed25519 public key
                                                       (W3C did:key spec)
```

The `z6Mk...` prefix indicates Ed25519 in the multicodec registry. No custom infrastructure required — any W3C DID resolver can verify it.

### Profile Signature

Profiles are published as JWS (JSON Web Signature):

```json
{
  "type": "Profile",
  "id": "did:key:z6MkpTHz8SrJgQi3oWFG7Ahs7pFHCmzCyMFVMdBr9ZFm",
  "name": "Ben Schmidt",
  "photo": "ipfs://Qm...",
  "bio": "New to the area",
  "publicKey": {
    "type": "Ed25519VerificationKey2020",
    "publicKeyMultibase": "z6MkpTHz8SrJgQi3oWFG7..."
  },
  "updated": "2025-01-08T14:30:00Z"
}
```

The JWS proof is a detached Ed25519 signature produced by `WotIdentity.signJws()`. The private key never leaves the device.

## Invite QR vs. Standard QR

### Standard QR (for existing users)

```json
{
  "type": "wot-identity",
  "did": "did:key:z6MkpTHz8SrJgQi3oWFG7...",
  "pk": "z6MkpTHz8SrJgQi3oWFG7..."
}
```

### Invite QR (for onboarding)

```json
{
  "type": "wot-invite",
  "app": "https://web-of-trust.de/download",
  "did": "did:key:z6MkpTHz8SrJgQi3oWFG7...",
  "pk": "z6MkpTHz8SrJgQi3oWFG7...",
  "token": "optional-invite-token"
}
```

The optional `token` can be used for analytics or special invite flows.

## Secure Storage

### Platform-specific

| Platform | Storage | Details |
| -------- | ------- | ------- |
| iOS | Keychain | `kSecClassKey`, hardware-backed when available |
| Android | Keystore | AndroidKeyStore, TEE/Strongbox when available |
| Web | Web Crypto API + IndexedDB | `extractable: false`, key never exportable as raw bytes |

### Web Crypto API Details

```typescript
// Derive non-extractable master key from mnemonic via HKDF
const masterKey = await crypto.subtle.importKey(
  "raw",
  mnemonicBytes,
  { name: "HKDF" },
  false,  // extractable = false
  ["deriveKey", "deriveBits"]
);

// Derive framework-specific sub-key (e.g. for signing)
const signingKey = await crypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA-256", salt, info },
  masterKey,
  { name: "Ed25519" },
  false,  // still non-extractable
  ["sign"]
);

// Store CryptoKey object directly in IndexedDB
const db = await openDB("wot-keys", 1);
await db.put("keys", signingKey, "signingKey");

// Key can only be used for signing — never exported
const signature = await crypto.subtle.sign(
  { name: "Ed25519" },
  signingKey,
  data
);
```

### Web-specific risks

| Risk | Mitigation |
| ---- | ---------- |
| Clearing browser data deletes keys | Recovery phrase is the ONLY way back |
| No cross-device sync via browser | User must restore on each new device |
| Browser update could break storage | Unlikely, but monitoring recommended |

**Consequence:** Recovery phrase backup is even more critical on the web than on native apps.

### What is stored

```mermaid
flowchart TD
    subgraph NeverStored["NEVER stored"]
        Mnemonic["Recovery phrase"]
    end

    subgraph PersonalDoc["PersonalDoc CRDT (Y.Map)"]
        Profile["Own profile"]
        Contacts["Contacts + public keys"]
        Items["Items + item keys"]
        Groups["Groups + group keys"]
    end

    subgraph SecureStorage["Secure Storage"]
        PrivKey["Private key (non-extractable CryptoKey)"]
    end

    style NeverStored stroke:#ef4444,stroke-width:2px
    style SecureStorage stroke:#22c55e,stroke-width:2px
```

**CRITICAL:** The recovery phrase is never stored anywhere. It is displayed **exactly once** during identity creation. The user MUST pass the quiz to continue — there are no unsecured accounts.

## Error Handling

### Onboarding cancellation

```mermaid
stateDiagram-v2
    [*] --> NotStarted

    NotStarted --> AppInstalled: Install app
    AppInstalled --> ProfileEntered: Enter profile
    ProfileEntered --> KeysGenerated: Generate keys
    KeysGenerated --> MnemonicShown: Show mnemonic
    MnemonicShown --> QuizPassed: Pass quiz
    QuizPassed --> VerificationDone: Verification
    VerificationDone --> [*]: Done

    NotStarted --> [*]: Cancel OK
    AppInstalled --> [*]: Cancel OK
    ProfileEntered --> [*]: Cancel OK

    KeysGenerated --> BLOCKED: Cancel blocked
    MnemonicShown --> BLOCKED: Cancel blocked

    state BLOCKED {
        [*] --> MustComplete
        MustComplete: Navigation blocked until quiz passed
    }

    QuizPassed --> PartialSetup: Cancel OK
    state PartialSetup {
        [*] --> HasID
        HasID: Identity and backup verified — no contacts yet
    }
```

### Quiz flow in detail

```mermaid
flowchart TD
    ShowPhrase(["Show 12 words"]) --> UserReady["User taps Continue"]

    UserReady --> Q1["Question 1: Which is word X?"]
    Q1 -->|Correct| Q2["Question 2: Which is word Y?"]
    Q1 -->|Wrong| Error1["Show error"]
    Error1 --> ShowPhrase

    Q2 -->|Correct| Q3["Question 3: Which is word Z?"]
    Q2 -->|Wrong| Error2["Show error"]
    Error2 --> ShowPhrase

    Q3 -->|Correct| Success(["Quiz passed — Continue"])
    Q3 -->|Wrong| Error3["Show error"]
    Error3 --> ShowPhrase
```

**Notes:**

- X, Y, Z are random positions (1–12)
- New positions are chosen on every restart
- Multiple choice with 4 options (1 correct, 3 wrong from the wordlist)
- No skipping possible

## Security Considerations

### Threat Model

| Threat | Mitigation |
| ------ | ---------- |
| Mnemonic photographed | Warning + OS screenshot protection on mnemonic screen |
| Shoulder surfing | Private environment recommended |
| Malware on device | Secure Storage / Web Crypto uses hardware isolation |
| Server compromise | Private key never leaves the device |
| QR code forgery | Profile is JWS-signed — forgery is detectable |
| Browser data cleared (web) | Recovery via mnemonic — only way back |

### Best Practices

1. **Mnemonic shown ONLY ONCE** — never stored anywhere
2. **Quiz is MANDATORY** — no continuing without 3 correct answers
3. **Block navigation** — between key generation and quiz completion
4. **No cloud key backup** — only mnemonic on paper
5. **Biometrics optional** — for app unlock, not for key access

### Recovery Scenario

```mermaid
flowchart TD
    Loss(["Device lost or data cleared"]) --> HasPhrase{"Recovery phrase saved?"}

    HasPhrase -->|Yes| Recover["Install new app and restore"]
    Recover --> Restored["Identity restored"]

    HasPhrase -->|No| Lost["Identity LOST"]
    Lost --> NewID["Only option: create new identity"]
    NewID --> Reverify["All contacts must verify again"]
    NewID --> LostAttestations["Old attestations lost"]

    style Lost stroke:#ef4444,stroke-width:2px
    style LostAttestations stroke:#ef4444,stroke-width:2px
```
