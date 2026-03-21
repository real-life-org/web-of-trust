# Hide Flow (Technical Perspective)

> How contacts are hidden and restored

## Data model

### Contact status state machine

```mermaid
stateDiagram-v2
    [*] --> Pending: One-sided verification

    Pending --> Active: Mutually verified

    Active --> Hidden: Hide

    Hidden --> Active: Restore

    state Active {
        [*] --> InAutoGroup
        InAutoGroup: In auto-group
        InAutoGroup: Receives new item keys
    }

    state Hidden {
        [*] --> NotInAutoGroup
        NotInAutoGroup: Not in auto-group
        NotInAutoGroup: Receives no new item keys
    }
```

### Contact record in PersonalDoc CRDT (Y.Map)

```json
{
  "did": "did:key:z6MkBen...",
  "publicKey": "ed25519:base64...",
  "name": "Ben Schmidt",
  "status": "hidden",
  "statusChangedAt": "2026-01-08T14:00:00Z",
  "statusReason": "user_initiated",
  "statusHistory": [
    {
      "status": "pending",
      "timestamp": "2026-01-05T10:00:00Z"
    },
    {
      "status": "active",
      "timestamp": "2026-01-05T10:05:00Z"
    },
    {
      "status": "hidden",
      "timestamp": "2026-01-08T14:00:00Z",
      "reason": "user_initiated"
    }
  ],
  "verifiedAt": "2026-01-05T10:05:00Z",
  "myVerification": "urn:uuid:123...",
  "theirVerification": "urn:uuid:456..."
}
```

All contact data lives in the **PersonalDoc CRDT (Y.Map)** — there is no separate SQL or Dexie table.

---

## Main flow: Hide a contact

```mermaid
flowchart TD
    Start(["User taps Hide"]) --> Confirm["Show confirmation dialog"]

    Confirm --> UserChoice{"Confirmed?"}

    UserChoice -->|No| Cancel["Cancel"]

    UserChoice -->|Yes| UpdateStatus["PersonalDoc: contact.status = hidden"]

    UpdateStatus --> RemoveFromGroup["PersonalDoc: remove from auto-group members"]

    RemoveFromGroup --> RotateKey["Group key rotation (optional)"]

    RotateKey --> Sync["Sync PersonalDoc via Relay"]

    Sync --> Done(["Done"])
```

---

## Sequence diagram: Hide

```mermaid
sequenceDiagram
    participant UI as Anna UI
    participant App as Anna App
    participant CRDT as PersonalDoc CRDT
    participant Relay as Relay + Vault

    UI->>App: hideContact(ben.did)

    App->>UI: showConfirmDialog()
    UI->>App: confirm()

    App->>CRDT: contacts[ben.did].status = 'hidden'
    App->>CRDT: contacts[ben.did].statusChangedAt = now()

    App->>CRDT: autoGroup.members.delete(ben.did)
    App->>CRDT: autoGroup.excludedMembers.add(ben.did)

    opt Group key rotation
        App->>App: generateNewGroupKey()
        App->>CRDT: autoGroup.groupKey = newKey (encrypted per member)
    end

    App->>Relay: push encrypted PersonalDoc update

    App->>UI: showSuccess()
```

---

## Auto-group management in PersonalDoc

### Structure (Y.Map entries)

```json
{
  "id": "autogroup-anna",
  "type": "AutoContactGroup",
  "owner": "did:key:z6MkAnna...",
  "members": [
    "did:key:z6MkCarla...",
    "did:key:z6MkTom..."
  ],
  "excludedMembers": [
    "did:key:z6MkBen..."
  ],
  "groupKey": {
    "current": {
      "key": "aes256:encrypted...",
      "version": 3,
      "createdAt": "2026-01-08T14:00:00Z"
    },
    "previous": [
      {
        "key": "aes256:encrypted...",
        "version": 2,
        "validUntil": "2026-01-08T14:00:00Z"
      }
    ]
  }
}
```

### Removing from auto-group

```mermaid
flowchart TD
    Hide(["Hide contact"]) --> GetGroup["Read auto-group from PersonalDoc"]

    GetGroup --> RemoveMember["Remove from members[]"]

    RemoveMember --> AddExcluded["Add to excludedMembers[]"]

    AddExcluded --> ShouldRotate{"Rotate key?"}

    ShouldRotate -->|Yes| Rotate["Generate new group key"]
    Rotate --> Distribute["Re-encrypt for remaining members"]

    ShouldRotate -->|No| Skip["Skip rotation"]

    Distribute --> Save["Write to PersonalDoc CRDT"]
    Skip --> Save
```

---

## Key rotation (optional)

### When to rotate?

| Scenario | Rotate key? |
| -------- | ----------- |
| Normal hide | Optional (recommended: No) |
| Security concern | Yes |
| User explicitly requests | Yes |

### Why optional?

```
┌─────────────────────────────────┐
│                                 │
│  Design decision                │
│                                 │
│  Key rotation on hide is NOT    │
│  the default, because:          │
│                                 │
│  1. The hidden contact already  │
│     has all old item keys       │
│                                 │
│  2. New items will not be       │
│     encrypted for them anyway   │
│                                 │
│  3. Rotation is expensive       │
│     (re-encrypt for all members)│
│                                 │
│  For genuine security concerns  │
│  rotation can be triggered      │
│  explicitly.                    │
│                                 │
└─────────────────────────────────┘
```

### Rotation flow

```mermaid
sequenceDiagram
    participant App as App
    participant CRDT as PersonalDoc CRDT
    participant Members as Remaining members

    App->>App: generateGroupKey()
    Note over App: AES-256 random key

    App->>App: incrementKeyVersion()

    loop For each remaining member
        App->>App: encryptGroupKey(member.publicKey)
        App->>CRDT: store encrypted key for member
    end

    App->>CRDT: archive previous key

    App->>Members: notifyKeyRotation() via Relay
```

---

## Restore a contact

```mermaid
flowchart TD
    Restore(["Restore"]) --> Confirm["Confirmation dialog"]

    Confirm --> UpdateStatus["PersonalDoc: contact.status = active"]

    UpdateStatus --> AddToGroup["PersonalDoc: add to auto-group members"]

    AddToGroup --> ReencryptItems["Encrypt item keys for new content"]

    ReencryptItems --> DistributeGroupKey["Share group key with contact via Relay"]

    DistributeGroupKey --> Sync["Sync PersonalDoc"]

    Sync --> Done(["Done"])
```

### Sequence diagram

```mermaid
sequenceDiagram
    participant UI as Anna UI
    participant App as Anna App
    participant CRDT as PersonalDoc CRDT
    participant Relay as Relay

    UI->>App: restoreContact(ben.did)
    App->>UI: showConfirmDialog()
    UI->>App: confirm()

    App->>CRDT: contacts[ben.did].status = 'active'
    App->>CRDT: contacts[ben.did].statusChangedAt = now()

    App->>CRDT: autoGroup.members.add(ben.did)
    App->>CRDT: autoGroup.excludedMembers.delete(ben.did)

    App->>CRDT: read items with visibility = 'all' (created after restore)

    loop For each new item
        App->>App: encryptItemKey(ben.publicKey)
        App->>CRDT: store item key for ben.did
    end

    App->>App: encryptGroupKey(ben.publicKey)
    App->>CRDT: store group key for ben.did

    App->>Relay: push encrypted PersonalDoc update

    App->>UI: showSuccess()
```

---

## What is NOT shared after restore?

```mermaid
flowchart TD
    Timeline["Timeline"]

    subgraph Before["BEFORE hiding"]
        B1["Item A — shared"]
        B2["Item B — shared"]
    end

    subgraph During["DURING hiding"]
        D1["Item C — NOT shared"]
        D2["Item D — NOT shared"]
    end

    subgraph After["AFTER restore"]
        A1["Item E — shared"]
        A2["Item F — shared"]
    end

    Timeline --> Before --> During --> After
```

**Rationale:** Items created during the "hidden period" were never encrypted for the contact. Sharing them retroactively would be inconsistent with the decision to hide that contact.

---

## API

### Hide

```typescript
async function hideContact(contactDid: string): Promise<void> {
  // 1. Validate
  const contact = personalDoc.contacts[contactDid];
  if (!contact || contact.status !== 'active') {
    throw new Error('Contact not active');
  }

  // 2. Update status in PersonalDoc CRDT
  personalDoc.contacts[contactDid] = {
    ...contact,
    status: 'hidden',
    statusChangedAt: new Date().toISOString(),
    statusReason: 'user_initiated',
    statusHistory: [
      ...(contact.statusHistory ?? []),
      { status: 'hidden', timestamp: new Date().toISOString(), reason: 'user_initiated' }
    ]
  };

  // 3. Remove from auto-group
  await removeFromAutoGroup(contactDid);

  // 4. Sync via Relay (immediate, no debounce)
  await relay.pushUpdate(encryptedPersonalDocUpdate());
}
```

### Restore

```typescript
async function restoreContact(contactDid: string): Promise<void> {
  // 1. Validate
  const contact = personalDoc.contacts[contactDid];
  if (!contact || contact.status !== 'hidden') {
    throw new Error('Contact not hidden');
  }

  // 2. Update status in PersonalDoc CRDT
  personalDoc.contacts[contactDid] = {
    ...contact,
    status: 'active',
    statusChangedAt: new Date().toISOString(),
    statusReason: 'user_restored',
    statusHistory: [
      ...(contact.statusHistory ?? []),
      { status: 'active', timestamp: new Date().toISOString(), reason: 'user_restored' }
    ]
  };

  // 3. Add back to auto-group
  await addToAutoGroup(contactDid);

  // 4. Re-encrypt recent items for contact
  await reencryptRecentItemsForContact(contactDid);

  // 5. Share group key
  await shareGroupKeyWithContact(contactDid);

  // 6. Sync via Relay
  await relay.pushUpdate(encryptedPersonalDocUpdate());
}
```

---

## Security considerations

### What the hidden contact still has access to

| Data | Access after hiding |
| ---- | ------------------- |
| Old item keys | Yes (already decrypted) |
| Old content | Yes (stored locally) |
| Old attestations | Yes (immutable) |
| Old group key | Yes (if not rotated) |
| **New content** | **No** |
| **New item keys** | **No** |

### Signalling to the contact

The Relay could signal to the contact that they have been hidden. **Recommendation:** Do not do this.

| Option | Pro | Con |
| ------ | --- | --- |
| Signal | Transparency | May cause conflict |
| No signal | Privacy | Contact may notice |

**Recommendation:** No explicit signalling. The contact will notice when they stop receiving new content.

---

## Edge cases

### Both sides hide each other

```mermaid
sequenceDiagram
    participant A as Anna
    participant B as Ben

    A->>A: Hides Ben
    B->>B: Hides Anna

    Note over A,B: Both status: hidden

    Note over A: Anna's view: Ben is hidden
    Note over B: Ben's view: Anna is hidden

    A->>A: Restores Ben
    Note over A: Anna's status for Ben: active
    Note over B: Ben's status for Anna: hidden

    Note over A: Anna does not see Ben's content (Ben hid her)
    Note over B: Ben does not see Anna's content (he hid her)
```

### Hiding while offline

```mermaid
flowchart TD
    Offline(["Offline"]) --> Hide["Hide locally in PersonalDoc"]

    Hide --> Queue["Queued in outbox"]

    Queue --> Later["Later online"]

    Later --> Sync["Sync PersonalDoc update via Relay"]

    Sync --> Note["Contact receives no new items"]
```

**Note:** Items created for "all contacts" while offline will not be distributed to the hidden contact when syncing.

### Contact cannot be deleted

Contacts cannot be deleted, only hidden. This is intentional: the verification record is immutable and remains as historical fact.
