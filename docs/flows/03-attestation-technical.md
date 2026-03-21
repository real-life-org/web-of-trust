# Attestation Flow (Technical Perspective)

> How attestations are created, signed, and delivered

## Data Model

```mermaid
erDiagram
    USER {
        string did PK
        string publicKey
        string name
    }

    ATTESTATION {
        string id PK "UUID"
        string fromDid FK "Signed by"
        string toDid FK "Stored at"
        string claim "Free text"
        string contextGroupId FK "Optional"
        datetime createdAt
        string proof "Ed25519 signature"
    }

    ATTESTATION_METADATA {
        string attestationId FK
        boolean accepted "Opt-out by recipient (default: true)"
        string deliveryStatus "pending, delivered, failed"
    }

    TAG {
        string id PK
        string name
    }

    GROUP {
        string did PK
        string name
    }

    USER ||--o{ ATTESTATION : "receives (to)"
    ATTESTATION ||--|| ATTESTATION_METADATA : "has"
    ATTESTATION }o--o{ TAG : "has"
    ATTESTATION }o--o| GROUP : "in context of"
```

> **Recipient principle:** Attestations are stored at the recipient (`to`). Anna attests Ben → attestation lives in **Ben's** PersonalDoc CRDT (Y.Map).

> **`attestationMetadata.accepted`** replaces the old `hidden` field. Ben can set `accepted = false` to hide an attestation from his public profile.

## Attestation Document Structure

Stored in the **recipient's** PersonalDoc CRDT (`attestations` Y.Map):

```json
{
  "@context": "https://w3id.org/weboftrust/v1",
  "type": "Attestation",
  "id": "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
  "from": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "to": "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuias8sisDArDJF6K2",
  "claim": "Helped for 3 hours in the community garden",
  "tags": ["garden", "helping"],
  "context": "did:key:z6MkGroup...",
  "createdAt": "2025-01-08T14:32:00Z",
  "proof": {
    "type": "Ed25519Signature2020",
    "verificationMethod": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#key-1",
    "proofPurpose": "assertionMethod",
    "proofValue": "z58DAdFfa9SkqZMVPxAQpic7ndTEcnUn..."
  }
}
```

Stored separately in `attestationMetadata` Y.Map (mutable by recipient only):

```json
{
  "attestationId": "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
  "accepted": true,
  "deliveryStatus": "delivered"
}
```

| Field | Description |
| --- | --- |
| `from` | Who attested (signer) |
| `to` | Who receives the attestation (storage location) |
| `attestationMetadata.accepted` | Recipient can hide (default: `true`) |

## Main Flow: Creating an Attestation

```mermaid
flowchart TD
    Start(["User taps Create Attestation"]) --> CheckContact{"Contact verified?"}

    CheckContact -->|No| Error["Error: Only for verified contacts"]
    CheckContact -->|Yes| ShowForm["Show form"]

    ShowForm --> Input["User enters: claim, tags, group"]

    Input --> Validate{"Input valid?"}

    Validate -->|No| ShowForm
    Validate -->|Yes| BuildDoc["Build attestation document (from=me, to=contact)"]

    BuildDoc --> Sign["Sign with private key"]

    Sign --> Encrypt["Encrypt with recipient's public key"]

    Encrypt --> Outbox["Queue in Outbox (OutboxMessagingAdapter)"]

    Outbox --> Deliver["AttestationDeliveryService sends via Relay"]

    Deliver --> Notify["Recipient receives and stores in PersonalDoc CRDT"]

    Notify --> Done(["Done"])

    style Start stroke:#888,fill:none,color:inherit
    style Done stroke:#888,fill:none,color:inherit
    style Error stroke:#e55,fill:none,color:inherit
    style CheckContact stroke:#888,fill:none,color:inherit
    style Validate stroke:#888,fill:none,color:inherit
```

> **Note:** The attestation is encrypted for the recipient and sent via the Relay (WebSocket). The sender does not retain a local copy. Delivery is tracked via `attestationMetadata.deliveryStatus`.

## Sequence Diagram: Create and Deliver Attestation

```mermaid
sequenceDiagram
    participant A_UI as Anna UI
    participant A_App as Anna App
    participant Outbox as Outbox
    participant Relay as Relay (WebSocket)
    participant B_App as Ben App
    participant B_Doc as Ben PersonalDoc CRDT

    A_UI->>A_App: openAttestationForm(ben.did)
    A_App->>A_App: checkContactStatus(ben.did)
    A_App->>A_UI: showForm()

    A_UI->>A_App: submitAttestation(claim, tags, group)

    A_App->>A_App: validateInput()
    A_App->>A_App: buildAttestationDoc(from=anna, to=ben)
    Note over A_App: id, from, to, claim, tags, context, createdAt

    A_App->>A_App: signAttestation(privateKey)
    Note over A_App: Adds proof object

    A_App->>A_App: encryptAttestation(ben.publicKey)
    Note over A_App: X25519 ECIES + AES-256-GCM

    A_App->>Outbox: enqueue(encryptedAttestation, to=ben)
    Note over Outbox: Persisted in Anna's PersonalDoc outbox Y.Map

    A_App->>A_UI: showSuccess()

    Outbox->>Relay: send(envelope) via WebSocketMessagingAdapter
    Note over Relay: Persists until Ben ACKs

    Relay->>B_App: deliver(envelope) on reconnect or immediately

    B_App->>B_App: decryptAttestation(ben.privateKey)
    B_App->>B_App: verifySignature(anna.publicKey)
    B_App->>B_Doc: attestations.set(id, attestation)
    B_App->>B_Doc: attestationMetadata.set(id, {accepted: true, deliveryStatus: "delivered"})
    Note over B_Doc: Stored in Ben's PersonalDoc CRDT (Y.Map)

    B_App->>Relay: ACK(messageId)
    B_App->>B_App: showNotification()
```

> **Recipient principle:** Anna sends the attestation to Ben. Ben stores it in his PersonalDoc CRDT (Y.Map) and controls visibility via `attestationMetadata.accepted`.

## Storage: PersonalDoc CRDT

Attestations are stored in the recipient's **PersonalDoc CRDT** using Yjs (default) or Automerge (option), not in a SQL/Dexie database.

```typescript
// PersonalDoc structure (simplified)
PersonalDoc {
  attestations:        Y.Map<string, AttestationDoc>
  attestationMetadata: Y.Map<string, { accepted: boolean, deliveryStatus: string }>
  outbox:              Y.Map<string, OutboxEntryDoc>
}
```

Access pattern:

```typescript
// Store received attestation (Ben's PersonalDoc)
doc.attestations[attestation.id] = attestation;
doc.attestationMetadata[attestation.id] = {
  accepted: true,
  deliveryStatus: "delivered",
};

// Hide an attestation (Ben opts out)
doc.attestationMetadata[attestation.id] = {
  ...doc.attestationMetadata[attestation.id],
  accepted: false,
};

// Query all accepted attestations for a DID
const received = Object.values(doc.attestations)
  .filter(a => a.to === ben.did)
  .filter(a => doc.attestationMetadata[a.id]?.accepted !== false);
```

The PersonalDoc is persisted via **CompactStore (IDB)**, synced in real-time via **Relay (WebSocket)**, and backed up via **Vault (HTTP)**.

## Detail Flow: Creating the Signature

```mermaid
flowchart TD
    Doc["Attestation document without proof"] --> Canonical["Canonicalize JSON"]

    Canonical --> Hash["SHA-256 hash"]

    Hash --> Sign["Ed25519 sign with private key"]

    Sign --> Encode["Base58 encode"]

    Encode --> Proof["Create proof object"]

    Proof --> Final["Append proof to document"]

    style Doc stroke:#888,fill:none,color:inherit
    style Canonical stroke:#888,fill:none,color:inherit
    style Hash stroke:#888,fill:none,color:inherit
    style Sign stroke:#888,fill:none,color:inherit
    style Encode stroke:#888,fill:none,color:inherit
    style Proof stroke:#888,fill:none,color:inherit
    style Final stroke:#5a5,fill:none,color:inherit
```

### Canonicalization

Before signing, the JSON must be canonicalized:

1. Sort keys alphabetically
2. No whitespace except within strings
3. UTF-8 encoding

```javascript
const canonical = JSON.stringify(doc, Object.keys(doc).sort());
const hash = sha256(canonical);
const signature = ed25519.sign(hash, privateKey);
const proofValue = base58.encode(signature);
```

## Detail Flow: Verifying the Signature

```mermaid
flowchart TD
    Receive["Receive attestation"] --> Extract["Extract proof object"]

    Extract --> GetDoc["Document without proof"]

    GetDoc --> Canonical["Canonicalize JSON"]

    Canonical --> Hash["SHA-256 hash"]

    Hash --> Decode["Base58 decode proofValue"]

    Decode --> GetKey["Resolve public key from from-DID"]

    GetKey --> Verify{"Ed25519 verify"}

    Verify -->|Valid| Accept["Accept attestation"]
    Verify -->|Invalid| Reject["Reject attestation"]

    style Receive stroke:#888,fill:none,color:inherit
    style Extract stroke:#888,fill:none,color:inherit
    style GetDoc stroke:#888,fill:none,color:inherit
    style Canonical stroke:#888,fill:none,color:inherit
    style Hash stroke:#888,fill:none,color:inherit
    style Decode stroke:#888,fill:none,color:inherit
    style GetKey stroke:#888,fill:none,color:inherit
    style Verify stroke:#888,fill:none,color:inherit
    style Accept stroke:#5a5,fill:none,color:inherit
    style Reject stroke:#e55,fill:none,color:inherit
```

## Delivery: AttestationDeliveryService + Outbox

The **AttestationDeliveryService** handles the full delivery lifecycle:

```mermaid
flowchart TD
    Create["Attestation created + signed"] --> Encrypt["Encrypt with recipient public key"]

    Encrypt --> Enqueue["Enqueue in Outbox (PersonalDoc outbox Y.Map)"]

    Enqueue --> Online{"Relay reachable?"}

    Online -->|Yes| Send["Send immediately via WebSocketMessagingAdapter"]
    Online -->|No| Wait["Wait in outbox — persist across restarts"]

    Wait -->|Relay reconnects| Send

    Send --> RelayPersist["Relay persists until ACK"]

    RelayPersist --> Redeliver["Redelivery on recipient reconnect"]

    Redeliver --> RecipientACK["Recipient ACKs → Relay removes message"]

    RecipientACK --> UpdateStatus["Update deliveryStatus in attestationMetadata"]

    style Create stroke:#888,fill:none,color:inherit
    style Encrypt stroke:#888,fill:none,color:inherit
    style Enqueue stroke:#888,fill:none,color:inherit
    style Online stroke:#888,fill:none,color:inherit
    style Send stroke:#5a5,fill:none,color:inherit
    style Wait stroke:#a80,fill:none,color:inherit
    style RelayPersist stroke:#888,fill:none,color:inherit
    style Redeliver stroke:#888,fill:none,color:inherit
    style RecipientACK stroke:#5a5,fill:none,color:inherit
    style UpdateStatus stroke:#5a5,fill:none,color:inherit
```

> **Offline-first:** If the sender is offline when creating an attestation, it is queued in the Outbox (stored in the PersonalDoc CRDT). On reconnect, the OutboxMessagingAdapter flushes the queue automatically.

## Encryption and Distribution

### Who receives the attestation?

```mermaid
flowchart TD
    A["Anna creates attestation for Ben"] --> Sign["Sign with Anna's private key"]

    Sign --> Encrypt["Encrypt with Ben's public key (X25519 ECIES)"]

    Encrypt --> Send["Send via Relay (WebSocket)"]

    Send --> BenReceives["Ben receives, decrypts, stores in PersonalDoc CRDT"]

    BenReceives --> BenShares["Ben controls visibility via attestationMetadata.accepted"]

    style A stroke:#888,fill:none,color:inherit
    style Sign stroke:#888,fill:none,color:inherit
    style Encrypt stroke:#888,fill:none,color:inherit
    style Send stroke:#888,fill:none,color:inherit
    style BenReceives stroke:#5a5,fill:none,color:inherit
    style BenShares stroke:#5a5,fill:none,color:inherit
```

### Visibility after receipt

Ben controls who sees the attestation:

```mermaid
flowchart TD
    Receive["Ben receives attestation"] --> Store["Store in PersonalDoc CRDT"]

    Store --> Default["attestationMetadata.accepted = true (default)"]

    Default --> Visible["Visible in Ben's profile"]

    Store --> Hide["Ben sets accepted = false"]

    Hide --> Private["Only Ben sees the attestation"]

    style Receive stroke:#888,fill:none,color:inherit
    style Store stroke:#888,fill:none,color:inherit
    style Default stroke:#5a5,fill:none,color:inherit
    style Visible stroke:#5a5,fill:none,color:inherit
    style Hide stroke:#a55,fill:none,color:inherit
    style Private stroke:#888,fill:none,color:inherit
```

## Tags and Search

### Tag Management

```mermaid
flowchart TD
    Input["User enters tags"] --> Check{"Tag exists?"}

    Check -->|Yes| Use["Use existing tag"]
    Check -->|No| Create["Create new tag locally"]

    Use --> Attach["Add tag to attestation"]
    Create --> Attach

    Attach --> Index["Update local search index"]

    style Input stroke:#888,fill:none,color:inherit
    style Check stroke:#888,fill:none,color:inherit
    style Use stroke:#888,fill:none,color:inherit
    style Create stroke:#888,fill:none,color:inherit
    style Attach stroke:#888,fill:none,color:inherit
    style Index stroke:#888,fill:none,color:inherit
```

### Predefined Tags

```json
{
  "predefinedTags": [
    {"id": "helping",      "emoji": "🤝", "label": "Helping"},
    {"id": "garden",       "emoji": "🌱", "label": "Garden"},
    {"id": "crafts",       "emoji": "🔧", "label": "Crafts"},
    {"id": "transport",    "emoji": "🚗", "label": "Transport"},
    {"id": "advice",       "emoji": "💬", "label": "Advice"},
    {"id": "cooking",      "emoji": "🍳", "label": "Cooking"},
    {"id": "childcare",    "emoji": "👶", "label": "Childcare"},
    {"id": "tech",         "emoji": "💻", "label": "Tech"}
  ]
}
```

## Group Context

### Attestation with Group Context

```mermaid
sequenceDiagram
    participant A as Anna
    participant App as App
    participant G as Group Community Garden

    A->>App: Create attestation for Ben
    A->>App: Select group Community Garden

    App->>App: Check: Is Anna a member of the group?
    App->>App: Check: Is Ben a member of the group?

    alt Both members
        App->>App: Add context field
        Note over App: context: did:key:z6MkGroup...
    else Not both members
        App->>A: Warning: group context not possible
    end
```

### Group Context Meaning

| With context | Without context |
| --- | --- |
| Attestation arose within the group | General attestation |
| Visible to all group members | Only to direct contacts |
| Can appear in group statistics | Only in personal profile |

## Notifications

### Notification for Recipient

```json
{
  "type": "attestation_received",
  "from": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "fromName": "Anna Mueller",
  "attestationId": "urn:uuid:550e8400...",
  "preview": "Helped for 3 hours in the community garden",
  "createdAt": "2025-01-08T14:32:00Z"
}
```

### Notification Flow

```mermaid
flowchart TD
    Create["Attestation created"] --> Notify["Create notification payload"]

    Notify --> Encrypt["Encrypt for recipient only"]

    Encrypt --> Outbox["Queue in Outbox"]

    Outbox --> Relay["Send via Relay (WebSocket)"]

    Relay --> Deliver["Recipient app delivers"]

    Deliver --> Decrypt["Decrypt"]

    Decrypt --> Show["Show notification"]

    style Create stroke:#888,fill:none,color:inherit
    style Notify stroke:#888,fill:none,color:inherit
    style Encrypt stroke:#888,fill:none,color:inherit
    style Outbox stroke:#888,fill:none,color:inherit
    style Relay stroke:#888,fill:none,color:inherit
    style Deliver stroke:#888,fill:none,color:inherit
    style Decrypt stroke:#888,fill:none,color:inherit
    style Show stroke:#5a5,fill:none,color:inherit
```

## Validation

### Input Validation

| Field | Validation |
| --- | --- |
| claim | Min 5 chars, max 500 chars |
| tags | Min 0, max 5 tags |
| context | Must be an existing group or empty |

### Signature Validation on Receipt

```mermaid
flowchart TD
    Receive["Attestation received"] --> V1{"from-DID known?"}

    V1 -->|No| Reject1["Reject: Unknown creator"]
    V1 -->|Yes| V2{"to-DID is own DID?"}

    V2 -->|No| Reject2["Reject: Not addressed to me"]
    V2 -->|Yes| V3{"Signature valid?"}

    V3 -->|No| Reject3["Reject: Invalid signature"]
    V3 -->|Yes| V4{"Timestamp plausible?"}

    V4 -->|No| Reject4["Reject: Timestamp in future or too old"]
    V4 -->|Yes| Accept["Accept and store in PersonalDoc CRDT"]

    style Receive stroke:#888,fill:none,color:inherit
    style V1 stroke:#888,fill:none,color:inherit
    style V2 stroke:#888,fill:none,color:inherit
    style V3 stroke:#888,fill:none,color:inherit
    style V4 stroke:#888,fill:none,color:inherit
    style Accept stroke:#5a5,fill:none,color:inherit
    style Reject1 stroke:#e55,fill:none,color:inherit
    style Reject2 stroke:#e55,fill:none,color:inherit
    style Reject3 stroke:#e55,fill:none,color:inherit
    style Reject4 stroke:#e55,fill:none,color:inherit
```

## Security Considerations

### Spam Protection

| Measure | Description |
| --- | --- |
| Verified contacts only | Attestations only for verified contacts |
| Rate limiting | Max 10 attestations per hour (client-side) |
| Social control | Spammers lose credibility |

### Manipulation

| Attack | Protection |
| --- | --- |
| Forge attestation | Signature with creator's private key |
| Alter attestation | Any change invalidates signature |
| Delete attestation | Recipient has own copy in PersonalDoc CRDT |
| False claim | Only social consequences possible |

### Immutability

Attestations are deliberately **immutable**:

1. **Signature:** Any change breaks the signature
2. **Distributed:** Stored in recipient's CRDT, replicated across devices
3. **Design:** A statement about the past cannot be undone

On errors: create a new correcting attestation.
