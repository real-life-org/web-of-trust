# Content Flow (Technical Perspective)

> How content is created, encrypted, and distributed

> **Status: Planned — not yet implemented in the demo app.**
> The content types described here (Calendar, Map, Offers, Requests, Projects) are part of the planned feature set. The current demo app implements Attestations and Group Spaces. Content types will be built on the same infrastructure (PersonalDoc CRDT, Relay, Vault).

## Data Model

```mermaid
erDiagram
    USER {
        string did PK
        string publicKey
        string name
    }

    ITEM {
        string id PK "UUID"
        string type "calendar, map, project, offer, request"
        string ownerDid FK
        string title
        string content "JSON, encrypted"
        string visibility "contacts, groups, selective"
        array groupDids "when visibility=groups"
        datetime createdAt
        datetime updatedAt
        boolean deleted
    }

    ITEM_KEY {
        string itemId FK
        string recipientDid FK
        string encryptedKey "Encrypted with recipient public key"
    }

    GROUP {
        string did PK
        string name
        string groupKey "Symmetric"
    }

    USER ||--o{ ITEM : "creates"
    ITEM ||--o{ ITEM_KEY : "has"
    USER ||--o{ ITEM_KEY : "receives"
    ITEM }o--o{ GROUP : "belongs to"
```

> **Storage:** When implemented, items will be stored in the owner's **PersonalDoc CRDT (Y.Map)**, not in a SQL/Dexie database. The PersonalDoc is persisted via CompactStore (IDB), synced via Relay (WebSocket), and backed up via Vault (HTTP).

## Item Document Structure

### Calendar Entry

```json
{
  "@context": "https://w3id.org/weboftrust/v1",
  "type": "CalendarItem",
  "id": "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
  "owner": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "title": "Garden meetup",
  "content": {
    "startDate": "2025-01-15T14:00:00Z",
    "endDate": "2025-01-15T17:00:00Z",
    "location": {
      "name": "Community Garden Sonnenberg",
      "coordinates": [51.0504, 13.7373]
    },
    "description": "We'll be preparing the beds for spring."
  },
  "visibility": {
    "type": "contacts"
  },
  "createdAt": "2025-01-08T10:00:00Z",
  "updatedAt": "2025-01-08T10:00:00Z",
  "proof": {
    "type": "Ed25519Signature2020",
    "verificationMethod": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#key-1",
    "proofValue": "z58DAdFfa9..."
  }
}
```

### Map Marker

```json
{
  "@context": "https://w3id.org/weboftrust/v1",
  "type": "MapItem",
  "id": "urn:uuid:660e8400-e29b-41d4-a716-446655440001",
  "owner": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "title": "Tool lending",
  "content": {
    "coordinates": [51.0504, 13.7373],
    "category": "lending",
    "description": "Tools available to borrow here."
  },
  "visibility": {
    "type": "contacts"
  },
  "createdAt": "2025-01-08T10:00:00Z",
  "proof": { }
}
```

### Offer / Request

```json
{
  "@context": "https://w3id.org/weboftrust/v1",
  "type": "OfferItem",
  "id": "urn:uuid:770e8400-e29b-41d4-a716-446655440002",
  "owner": "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuias8sisDArDJF6K2",
  "title": "Can help with moving",
  "content": {
    "category": "help",
    "description": "I have a car and can carry heavy things.",
    "availability": "Weekends"
  },
  "visibility": {
    "type": "contacts"
  },
  "createdAt": "2025-01-08T10:00:00Z",
  "proof": { }
}
```

---

## Main Flow: Creating Content

```mermaid
flowchart TD
    Start(["User creates content"]) --> Input["Input: type, title, content"]

    Input --> Validate{"Input valid?"}

    Validate -->|No| Error["Show error"]
    Error --> Input

    Validate -->|Yes| BuildDoc["Build item document"]

    BuildDoc --> Sign["Sign with private key"]

    Sign --> GenItemKey["Generate item key AES-256"]

    GenItemKey --> EncryptContent["Encrypt content with item key"]

    EncryptContent --> Visibility{"Visibility?"}

    Visibility -->|All contacts| EncryptAll["Encrypt item key for each active contact"]
    Visibility -->|Selected| EncryptSelected["Encrypt item key for selected recipients"]
    Visibility -->|Groups| EncryptGroups["Encrypt item key with group key(s)"]

    EncryptAll --> Store["Store in PersonalDoc CRDT (Y.Map)"]
    EncryptSelected --> Store
    EncryptGroups --> Store

    Store --> Relay["Sync via Relay (WebSocket)"]

    Relay --> Done(["Done"])

    style Start stroke:#888,fill:none,color:inherit
    style Done stroke:#5a5,fill:none,color:inherit
    style Error stroke:#e55,fill:none,color:inherit
    style Input stroke:#888,fill:none,color:inherit
    style Validate stroke:#888,fill:none,color:inherit
    style BuildDoc stroke:#888,fill:none,color:inherit
    style Sign stroke:#888,fill:none,color:inherit
    style GenItemKey stroke:#888,fill:none,color:inherit
    style EncryptContent stroke:#888,fill:none,color:inherit
    style Visibility stroke:#888,fill:none,color:inherit
    style EncryptAll stroke:#888,fill:none,color:inherit
    style EncryptSelected stroke:#888,fill:none,color:inherit
    style EncryptGroups stroke:#888,fill:none,color:inherit
    style Store stroke:#888,fill:none,color:inherit
    style Relay stroke:#888,fill:none,color:inherit
```

---

## Sequence Diagram: Create and Distribute Content

```mermaid
sequenceDiagram
    participant A_UI as Anna UI
    participant A_App as Anna App
    participant A_Doc as Anna PersonalDoc CRDT
    participant Relay as Relay (WebSocket)
    participant B_App as Ben App

    A_UI->>A_App: createContent(type, data, visibility)

    A_App->>A_App: validateInput()
    A_App->>A_App: buildItemDoc()
    A_App->>A_App: signItem(privateKey)

    A_App->>A_App: generateItemKey() AES-256
    A_App->>A_App: encryptContent(itemKey)

    alt Visibility: contacts
        A_App->>A_App: getActiveContacts()
        loop For each contact
            A_App->>A_App: encryptItemKey(contact.publicKey)
        end
    else Visibility: selective
        loop For each selected recipient
            A_App->>A_App: encryptItemKey(selected.publicKey)
        end
    else Visibility: groups
        loop For each selected group
            A_App->>A_App: encryptItemKey(group.groupKey)
        end
    end

    A_App->>A_Doc: items.set(id, encryptedItem)
    A_App->>A_Doc: itemKeys.set(id, itemKeys)

    A_App->>Relay: push(encryptedItem, itemKeys)

    A_App->>A_UI: showSuccess()

    Relay->>B_App: notifyNewItem()
    B_App->>Relay: pullItem()
    B_App->>B_App: findMyItemKey()
    B_App->>B_App: decryptItemKey(privateKey)
    B_App->>B_App: decryptContent(itemKey)
    B_App->>B_App: verifySignature(owner.publicKey)
    B_App->>B_App: storeItem() in PersonalDoc CRDT
```

---

## Encryption Schema

### Item Key Distribution

```mermaid
flowchart LR
    subgraph Creation["Item creation"]
        Item["Item plaintext"]
        ItemKey["Generate item key"]
    end

    subgraph Encryption["Encryption"]
        EncContent["Encrypt content"]
        EncKey1["Key for Anna"]
        EncKey2["Key for Ben"]
        EncKey3["Key for Carla"]
    end

    subgraph Storage["PersonalDoc CRDT (Y.Map)"]
        EncItem["Encrypted item"]
        Keys["Item key table"]
    end

    Item --> ItemKey
    ItemKey --> EncContent
    Item --> EncContent

    ItemKey --> EncKey1
    ItemKey --> EncKey2
    ItemKey --> EncKey3

    EncContent --> EncItem
    EncKey1 --> Keys
    EncKey2 --> Keys
    EncKey3 --> Keys
```

### Data Structure

```json
{
  "encryptedItem": {
    "id": "urn:uuid:550e8400...",
    "owner": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    "ciphertext": "base64...",
    "nonce": "base64...",
    "proof": { }
  },
  "itemKeys": [
    {
      "recipientDid": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      "encryptedKey": "base64..."
    },
    {
      "recipientDid": "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuias8sisDArDJF6K2",
      "encryptedKey": "base64..."
    }
  ]
}
```

---

## Detail Flow: Receiving Content

```mermaid
flowchart TD
    Receive(["Item received"]) --> FindKey{"Item key for me present?"}

    FindKey -->|No| Reject["Ignore — not addressed to me"]

    FindKey -->|Yes| DecryptKey["Decrypt item key with private key"]

    DecryptKey --> DecryptContent["Decrypt content with item key"]

    DecryptContent --> VerifySig{"Signature valid?"}

    VerifySig -->|No| RejectInvalid["Reject — invalid signature"]

    VerifySig -->|Yes| CheckOwner{"Owner known?"}

    CheckOwner -->|No| RejectUnknown["Reject — unknown owner"]

    CheckOwner -->|Yes| Store["Store in PersonalDoc CRDT and display"]

    style Receive stroke:#888,fill:none,color:inherit
    style FindKey stroke:#888,fill:none,color:inherit
    style Reject stroke:#e55,fill:none,color:inherit
    style DecryptKey stroke:#888,fill:none,color:inherit
    style DecryptContent stroke:#888,fill:none,color:inherit
    style VerifySig stroke:#888,fill:none,color:inherit
    style RejectInvalid stroke:#e55,fill:none,color:inherit
    style CheckOwner stroke:#888,fill:none,color:inherit
    style RejectUnknown stroke:#e55,fill:none,color:inherit
    style Store stroke:#5a5,fill:none,color:inherit
```

---

## Visibility Options

### Type: contacts (All Contacts)

```mermaid
flowchart TD
    All(["Visibility: contacts"]) --> GetContacts["Load all active contacts"]

    GetContacts --> Loop{"For each contact"}

    Loop --> Encrypt["Encrypt item key with contact public key"]

    Encrypt --> Next["Next contact"]
    Next --> Loop

    Loop -->|Done| Store["Store all encrypted keys in PersonalDoc CRDT"]

    style All stroke:#888,fill:none,color:inherit
    style GetContacts stroke:#888,fill:none,color:inherit
    style Loop stroke:#888,fill:none,color:inherit
    style Encrypt stroke:#888,fill:none,color:inherit
    style Next stroke:#888,fill:none,color:inherit
    style Store stroke:#5a5,fill:none,color:inherit
```

**On new contact:** When Anna later verifies a new contact, all items with `visibility: contacts` are automatically re-encrypted for that contact.

### Type: selective (Selected Recipients)

```mermaid
flowchart TD
    Selected(["Visibility: selective"]) --> Choose["User selects people"]

    Choose --> Loop{"For each selected"}

    Loop --> Encrypt["Encrypt item key"]

    Encrypt --> Next["Next"]
    Next --> Loop

    Loop -->|Done| Store["Store in PersonalDoc CRDT"]

    style Selected stroke:#888,fill:none,color:inherit
    style Choose stroke:#888,fill:none,color:inherit
    style Loop stroke:#888,fill:none,color:inherit
    style Encrypt stroke:#888,fill:none,color:inherit
    style Next stroke:#888,fill:none,color:inherit
    style Store stroke:#5a5,fill:none,color:inherit
```

**On new contact:** New contacts do NOT automatically see this content.

### Type: groups (One or More Groups)

```mermaid
flowchart TD
    Groups(["Visibility: groups"]) --> Select["User selects groups"]

    Select --> Loop{"For each group"}

    Loop --> GetKey["Load group key"]
    GetKey --> Encrypt["Encrypt item key with group key"]

    Encrypt --> Next["Next group"]
    Next --> Loop

    Loop -->|Done| Store["Store all encrypted keys in PersonalDoc CRDT"]

    style Groups stroke:#888,fill:none,color:inherit
    style Select stroke:#888,fill:none,color:inherit
    style Loop stroke:#888,fill:none,color:inherit
    style GetKey stroke:#888,fill:none,color:inherit
    style Encrypt stroke:#888,fill:none,color:inherit
    style Next stroke:#888,fill:none,color:inherit
    style Store stroke:#5a5,fill:none,color:inherit
```

**Multi-group:** An item can be shared with multiple groups simultaneously. Each group gets its own encrypted item key.

**Efficiency:** Only one encryption operation per group, regardless of how many members it has.

---

## Updating Content

```mermaid
sequenceDiagram
    participant A as Anna App
    participant Doc as PersonalDoc CRDT
    participant Relay as Relay (WebSocket)
    participant B as Ben App

    A->>A: loadItem(id)
    A->>A: decryptContent()
    A->>A: modifyContent()
    A->>A: incrementVersion()
    A->>A: updateTimestamp()
    A->>A: signItem(privateKey)
    A->>A: encryptContent(existingItemKey)

    A->>Doc: items.set(id, updatedItem)
    A->>Relay: pushUpdate()

    Relay->>B: notifyItemUpdate()
    B->>Relay: pullUpdate()
    B->>B: verifySignature()
    B->>B: checkVersion() — higher than local?
    B->>B: replaceItem() in PersonalDoc CRDT
```

### Versioning

```json
{
  "id": "urn:uuid:550e8400...",
  "version": 3,
  "previousVersion": "hash-of-version-2",
  "updatedAt": "2025-01-08T15:00:00Z"
}
```

---

## Deleting Content

```mermaid
flowchart TD
    Delete(["Delete requested"]) --> MarkDeleted["Set deleted: true"]

    MarkDeleted --> Sign["Sign deletion marker"]

    Sign --> Store["Store in PersonalDoc CRDT"]

    Store --> Relay["Sync deletion marker via Relay"]

    Relay --> Recipients["Recipients receive marker"]

    Recipients --> Hide["Content shown as deleted"]

    style Delete stroke:#888,fill:none,color:inherit
    style MarkDeleted stroke:#a55,fill:none,color:inherit
    style Sign stroke:#888,fill:none,color:inherit
    style Store stroke:#888,fill:none,color:inherit
    style Relay stroke:#888,fill:none,color:inherit
    style Recipients stroke:#888,fill:none,color:inherit
    style Hide stroke:#888,fill:none,color:inherit
```

### Deletion Marker

```json
{
  "type": "ItemDeletion",
  "itemId": "urn:uuid:550e8400...",
  "deletedAt": "2025-01-08T16:00:00Z",
  "proof": {
    "type": "Ed25519Signature2020",
    "verificationMethod": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#key-1",
    "proofValue": "z58DAdFfa9..."
  }
}
```

**Important:** The encrypted content is not physically deleted. Recipients who already decrypted it retain a local copy in their PersonalDoc CRDT.

---

## Storage: PersonalDoc CRDT

When implemented, content items will live in the owner's PersonalDoc CRDT alongside attestations, contacts, and other user data:

```typescript
// PersonalDoc structure (planned extension)
PersonalDoc {
  profile:             Y.Map  // profile data
  contacts:            Y.Map  // verified contacts
  attestations:        Y.Map  // received attestations
  attestationMetadata: Y.Map  // accepted, deliveryStatus
  outbox:              Y.Map  // pending deliveries
  spaces:              Y.Map  // group space metadata
  groupKeys:           Y.Map  // group encryption keys
  // planned:
  items:               Y.Map  // content items (calendar, map, offers, ...)
  itemKeys:            Y.Map  // per-recipient encrypted keys
}
```

Access pattern (planned):

```typescript
// Store a new item
doc.items[item.id] = encryptedItem;
doc.itemKeys[item.id] = itemKeys;

// Query calendar items
const calendarItems = Object.values(doc.items)
  .filter(item => item.type === "CalendarItem" && !item.deleted)
  .map(item => decryptContent(item, myPrivateKey));

// Query items near a location
const nearbyItems = Object.values(doc.items)
  .filter(item => item.type === "MapItem")
  .map(item => decryptContent(item, myPrivateKey))
  .filter(item => calculateDistance(myLocation, item.content.coordinates) < 1000);
```

---

## Notifications

### Notification Types

```json
{
  "type": "item_created",
  "itemId": "urn:uuid:550e8400...",
  "itemType": "CalendarItem",
  "ownerDid": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "ownerName": "Anna Mueller",
  "title": "Garden meetup",
  "createdAt": "2025-01-08T10:00:00Z"
}
```

```json
{
  "type": "item_updated",
  "itemId": "urn:uuid:550e8400...",
  "changes": ["title", "content.startDate"],
  "updatedAt": "2025-01-08T15:00:00Z"
}
```

```json
{
  "type": "item_deleted",
  "itemId": "urn:uuid:550e8400...",
  "deletedAt": "2025-01-08T16:00:00Z"
}
```

---

## Security Considerations

### Validation

| Check | Description |
| --- | --- |
| Signature | Item must be signed by the stated owner |
| Owner | Owner must be a known contact |
| Version | Update version must be higher than local |
| Delete permission | Only the owner can delete |

### Attack Vectors

| Attack | Protection |
| --- | --- |
| Forged item | Signature verification |
| Replay old version | Version check |
| Unauthorized deletion | Only accept signed deletion markers |
| Metadata leak | Metadata is also encrypted |
