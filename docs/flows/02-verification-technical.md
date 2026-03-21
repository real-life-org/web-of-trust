# Verification Flow (Technical Perspective)

> What the devices and the system do

## Data Model

```mermaid
erDiagram
    USER {
        string did PK "Decentralized Identifier (did:key:z6Mk...)"
        string publicKey "Ed25519 public key"
        string privateKey "Local only, never shared"
        string name "Self-chosen"
        string photo "Optional"
        string bio "Optional"
    }

    CONTACT {
        string did PK "DID of the contact"
        string publicKey "Contact's public key"
        string status "pending or active"
        datetime verifiedAt
    }

    VERIFICATION {
        string id PK "URN"
        string from "Signed by"
        string to "Stored at"
        datetime timestamp
        string proof "Ed25519 signature"
    }

    AUTO_GROUP {
        string groupKey "Symmetric key (AES-256-GCM)"
        array activeMembers "DIDs"
        array excludedMembers "Hidden DIDs"
        datetime lastRotation
    }

    USER ||--o{ CONTACT : "has"
    USER ||--o{ VERIFICATION : "receives (to)"
    USER ||--|| AUTO_GROUP : "has exactly one"
    AUTO_GROUP ||--o{ CONTACT : "contains active"
```

> **Recipient principle:** Verifications are stored at the recipient (`to`). Ben verifies Anna → the Verification is stored at **Anna**.

## QR Code Structure

```mermaid
flowchart LR
    subgraph QR["QR Code content"]
        DID["did:key:z6MkpTHz..."]
        PK["publicKey: z6MkpTHz..."]
    end

    subgraph Optional["Optional — if size allows"]
        NAME["name: Anna"]
        SIG["signature: ..."]
    end

    QR -.-> Optional
```

**Minimal (print-friendly):**

```json
{
  "did": "did:key:z6MkpTHz8SrJgQi3oWFG7Ahs7pFHCmzCyMFVMdBr9ZFm",
  "pk": "z6MkpTHz8SrJgQi3oWFG7Ahs7pFHCmzCyMFVMdBr9ZFm"
}
```

**Extended (digital QR):**

```json
{
  "did": "did:key:z6MkpTHz8SrJgQi3oWFG7Ahs7pFHCmzCyMFVMdBr9ZFm",
  "pk": "z6MkpTHz8SrJgQi3oWFG7Ahs7pFHCmzCyMFVMdBr9ZFm",
  "name": "Anna Müller",
  "sig": "signature_of_payload"
}
```

## Main Flow: Mutual Verification

```mermaid
sequenceDiagram
    participant A_UI as Anna UI
    participant A_App as Anna App
    participant Relay as Relay (WebSocket)
    participant B_App as Ben App
    participant B_UI as Ben UI

    Note over A_UI,B_UI: Phase 1 — Ben verifies Anna

    A_UI->>A_App: showQRCode()
    A_App->>A_App: generateQR(did, publicKey)
    A_App->>A_UI: Display QR

    B_UI->>B_App: scanQR()
    B_App->>B_App: parseQR() → did, publicKey

    alt Online
        B_App->>Relay: fetchProfile(did)
        Relay->>B_App: name, photo, bio, JWS signature
        B_App->>B_App: verifyJws(profile, publicKey)
        B_App->>B_UI: Show profile
    else Offline
        B_App->>B_App: computeIDHash(did)
        B_App->>B_UI: Show ID check value
    end

    B_UI->>B_App: confirmIdentity()

    B_App->>B_App: createVerification(from=ben, to=anna)
    Note over B_App: Verification for Anna created
    B_App->>B_App: saveContact(anna, pending)

    Note over A_UI,B_UI: Phase 2 — Anna verifies Ben

    B_UI->>B_App: showQRCode()
    B_App->>B_UI: Display QR

    A_UI->>A_App: scanQR()
    A_App->>A_App: parseQR() → did, publicKey
    A_App->>A_UI: Show profile + X contacts know Ben

    A_UI->>A_App: confirmIdentity()
    A_App->>A_App: createVerification(from=anna, to=ben)
    A_App->>A_App: saveContact(ben, pending)

    Note over A_UI,B_UI: Phase 3 — Sync and finalisation

    A_App->>Relay: pushVerification(to=ben)
    Note over A_App: Verification is stored at Ben
    B_App->>Relay: pushVerification(to=anna)
    Note over B_App: Verification is stored at Anna

    Relay->>A_App: pullUpdates()
    A_App->>A_App: receiveVerification(from=ben)
    A_App->>A_App: updateContact(ben, active)
    A_App->>A_App: addToAutoGroup(ben)
    A_App->>A_App: reencryptItemKeysForNewContact(ben)

    Relay->>B_App: pullUpdates()
    B_App->>B_App: receiveVerification(from=anna)
    B_App->>B_App: updateContact(anna, active)
    B_App->>B_App: addToAutoGroup(anna)
    B_App->>B_App: reencryptItemKeysForNewContact(anna)
```

> **Note:** The Verification is sent to the recipient (`to`) and stored there. Ben's Verification for Anna lands at Anna; Anna's Verification for Ben lands at Ben.

## Detail Flow: Creating a Verification

```mermaid
flowchart TD
    Start(["User taps Confirm identity"]) --> CreateVerif["createVerification()"]

    CreateVerif --> BuildPayload["Build payload: type, from=self, to=contact, timestamp"]

    BuildPayload --> Sign["Sign with private key (Ed25519)"]

    Sign --> StoreContact["Store contact locally (public key)"]

    StoreContact --> Queue["Queue Verification for recipient via Relay"]

    Queue --> End(["Done — waiting for counter-verification"])
```

```mermaid
flowchart TD
    Start(["Verification received"]) --> Verify["Verify signature with from-publicKey"]

    Verify --> Store["Store Verification in PersonalDoc CRDT (Y.Map)"]

    Store --> CheckMutual{"Mutual verification?"}

    CheckMutual -->|Yes| Activate["Status = active"]
    Activate --> AddGroup["Add to auto-group"]
    AddGroup --> Reencrypt["Re-encrypt item keys"]
    Reencrypt --> End(["Done"])

    CheckMutual -->|No| Pending["Status = pending"]
    Pending --> End
```

**Prerequisite:** User already has an identity (see Flow 01: Onboarding).

> **Two phases:** (1) Create and send the Verification to the recipient; (2) Receive and process the counter-verification.

## Detail Flow: Re-encrypting Item Keys

```mermaid
flowchart TD
    Start(["New contact added to auto-group"]) --> Fetch["Load all items with target: allContacts"]

    Fetch --> Loop{"For each item"}

    Loop --> Decrypt["Decrypt item key with own private key"]
    Decrypt --> Encrypt["Encrypt item key with contact's public key"]
    Encrypt --> Store["Store encrypted item key in PersonalDoc CRDT"]
    Store --> Loop

    Loop -->|All done| Queue["Queue all new item keys for sync via Relay"]
    Queue --> End(["Done"])
```

## Detail Flow: Offline Verification

```mermaid
sequenceDiagram
    participant A as Anna's device
    participant B as Ben's device

    Note over A,B: No internet available

    A->>A: generateQR(did, publicKey)
    A->>B: Physical QR scan

    B->>B: parseQR()
    B->>B: computeIDHash(did)
    B->>B: display a7f3-82b1-...

    Note over A,B: Verbal comparison
    A->>A: display own ID hash
    A->>B: Mine shows a7f3-82b1
    B->>B: verify match

    B->>B: createVerification(anna.did)
    B->>B: saveContact(anna, pending)
    Note over B: Stored locally — waiting for sync

    Note over A,B: Swap roles

    B->>B: generateQR(did, publicKey)
    B->>A: Physical QR scan
    A->>A: parseQR()
    A->>A: computeIDHash(did)

    Note over A,B: Verbal comparison
    A->>A: verify match

    A->>A: createVerification(ben.did)
    A->>A: saveContact(ben, active)
    A->>A: addToAutoGroup(ben)
    A->>A: reencryptItemKeysForNewContact(ben)
    Note over A: All local — waiting for sync

    Note over A,B: Later — both online

    A->>A: syncPush()
    B->>B: syncPush()
    B->>B: syncPull()
    B->>B: updateContact(anna, active)
    B->>B: addToAutoGroup(anna)
```

## State Diagram: Contact Status

```mermaid
stateDiagram-v2
    [*] --> Pending: One-sided verification

    Pending --> Active: Other side verifies back
    Pending --> [*]: Timeout or cancellation

    state Active {
        [*] --> InAutoGroup
        InAutoGroup: In auto-group
        InAutoGroup --> Excluded: Added to excludedMembers
        Excluded --> InAutoGroup: Removed from excludedMembers
        Excluded: Hidden (not in auto-group)
    }

    state Pending {
        [*] --> WaitingForMutual
        WaitingForMutual: Waiting for counter-verification
    }
```

### Contact status details

| Status | In auto-group | Sees content | Receives item keys |
| ------ | ------------- | ------------ | ------------------ |
| Pending | No | No | No |
| Active | Yes | Yes (new) | Yes |
| Active + excluded | No | No (new) | No — old still readable |

> **Note:** Hiding a contact is done via `excludedMembers` in the auto-group, not by changing the contact status. A hidden contact remains `active`.

## Data Structures

### Verification Document

Stored at the **recipient** (`to`):

```json
{
  "type": "IdentityVerification",
  "id": "urn:uuid:123e4567-e89b-12d3-a456-426614174000",
  "from": "did:key:z6MkpTHz8SrJgQi3oWFG7Ahs7pFHCmzCyMFVMdBr9ZFm",
  "to": "did:key:z6MknGc3xNCLjFrSnBMBsNXZtE2jHicoAcBpN4CXTPPA",
  "timestamp": "2025-01-08T14:30:00Z",
  "proof": {
    "type": "Ed25519Signature2020",
    "verificationMethod": "did:key:z6MkpTHz8SrJgQi3oWFG7Ahs7pFHCmzCyMFVMdBr9ZFm#z6MkpTHz...",
    "proofValue": "z58DAdFfa9SkqZMVPxAQpic7ndTEcnUn..."
  }
}
```

| Field | Description |
| ----- | ----------- |
| `from` | Who verified (signer) |
| `to` | Who was verified (storage location) |

### Contact Record (local — PersonalDoc CRDT)

The sender stores only the **public key** of the contact (for E2E encryption):

```json
{
  "did": "did:key:z6MknGc3xNCLjFrSnBMBsNXZtE2jHicoAcBpN4CXTPPA",
  "publicKey": "z6MknGc3xNCLjFrSnBMBsNXZtE2jHicoAcBpN4CXTPPA",
  "name": "Ben Schmidt",
  "status": "active",
  "verifiedAt": "2025-01-08T14:30:00Z"
}
```

All contact records live inside the user's PersonalDoc CRDT (`Y.Map` keyed by DID).

> **Note:** Verification IDs (`myVerification`, `theirVerification`) are no longer needed, since Verifications reside at the respective recipient.

### Auto-Group (local — PersonalDoc CRDT)

```json
{
  "id": "urn:uuid:autogroup-anna",
  "type": "AutoContactGroup",
  "groupKey": "aes256:encrypted_with_own_pubkey...",
  "activeMembers": [
    "did:key:z6MknGc3xNCLjFrSnBMBsNXZtE2jHicoAcBpN4CXTPPA",
    "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEefRe"
  ],
  "excludedMembers": [
    "did:key:z6MksRvQSGBMDjS5E6rK9GXNt6qdQxLRgmUq5PKTPgvN"
  ],
  "lastKeyRotation": "2025-01-08T14:30:00Z"
}
```
