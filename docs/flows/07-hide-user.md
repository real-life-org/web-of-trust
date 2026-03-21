# Hide Flow (User Perspective)

> How a contact is hidden

## What does "hide" mean?

Hiding is a **soft separation** from a contact. The verification remains intact, but the contact is removed from your active network.

| Hide | Block (does not exist) |
| ---- | ---------------------- |
| Soft, reversible | Hard, permanent |
| Verification stays | — |
| No new content | — |
| Can be undone | — |

---

## What happens when you hide someone?

```mermaid
flowchart TD
    Hide(["Hide contact"]) --> Effects["Effects"]

    Effects --> E1["You no longer see new content from this person"]
    Effects --> E2["This person no longer sees new content from you"]
    Effects --> E3["Existing verification remains valid"]
    Effects --> E4["Old attestations remain visible"]

    E1 --> Note["Can be undone at any time"]
    E2 --> Note
    E3 --> Note
    E4 --> Note
```

---

## Main flow: Hide a contact

```mermaid
sequenceDiagram
    participant A as Anna
    participant App as App

    A->>App: Opens Ben's profile
    A->>App: Taps three-dot menu
    A->>App: Selects "Hide"

    App->>A: Confirmation dialog

    A->>App: Confirms

    App->>App: Update PersonalDoc: contact status → hidden
    App->>App: Remove from auto-group in PersonalDoc
    App->>App: Sync via Relay

    App->>A: Ben has been hidden
```

---

## What the user sees

### Contact menu

```
┌─────────────────────────────────┐
│         [Profile photo]         │
│          Ben Schmidt            │
│                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ View profile            │    │
│  └─────────────────────────┘    │
│  ┌─────────────────────────┐    │
│  │ Attestations            │    │
│  └─────────────────────────┘    │
│  ┌─────────────────────────┐    │
│  │ Create attestation      │    │
│  └─────────────────────────┘    │
│                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ Hide                    │    │
│  └─────────────────────────┘    │
│                                 │
└─────────────────────────────────┘
```

### Confirmation dialog

```
┌─────────────────────────────────┐
│                                 │
│  Hide Ben?                      │
│                                 │
├─────────────────────────────────┤
│                                 │
│  What happens:                  │
│                                 │
│  • You will no longer see       │
│    new content from Ben         │
│                                 │
│  • Ben will no longer see       │
│    new content from you         │
│                                 │
│  • Your verification stays      │
│    intact                       │
│                                 │
│  • Old attestations remain      │
│    visible                      │
│                                 │
│  You can undo this at any time. │
│                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━    │
│                                 │
│  [ Cancel ]                     │
│                                 │
│  [ Hide ]                       │
│                                 │
└─────────────────────────────────┘
```

### Success message

```
┌─────────────────────────────────┐
│                                 │
│  ✅ Ben has been hidden         │
│                                 │
│  You will no longer see         │
│  new content from Ben.          │
│                                 │
│  [ Undo ]                       │
│                                 │
│  [ OK ]                         │
│                                 │
└─────────────────────────────────┘
```

---

## Manage hidden contacts

### Settings

```
┌─────────────────────────────────┐
│  Settings                       │
├─────────────────────────────────┤
│                                 │
│  Contacts                       │
│                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━    │
│                                 │
│  Hidden contacts (2)            │
│                                 │
│  ┌─────────────────────────┐    │
│  │ Ben Schmidt             │    │
│  │    Hidden on            │    │
│  │    08.01.2026           │    │
│  │                         │    │
│  │    [ Restore ]          │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ Carla Braun             │    │
│  │    Hidden on            │    │
│  │    05.01.2026           │    │
│  │                         │    │
│  │    [ Restore ]          │    │
│  └─────────────────────────┘    │
│                                 │
└─────────────────────────────────┘
```

---

## Restore a contact

```mermaid
sequenceDiagram
    participant A as Anna
    participant App as App

    A->>App: Opens Settings
    A->>App: Hidden contacts
    A->>App: Taps "Restore" next to Ben

    App->>A: Confirmation dialog

    A->>App: Confirms

    App->>App: Update PersonalDoc: contact status → active
    App->>App: Add back to auto-group in PersonalDoc
    App->>App: Re-encrypt item keys for Ben
    App->>App: Sync via Relay

    App->>A: Ben has been restored
```

### Restore confirmation dialog

```
┌─────────────────────────────────┐
│                                 │
│  Restore Ben?                   │
│                                 │
├─────────────────────────────────┤
│                                 │
│  What happens:                  │
│                                 │
│  • You will see new content     │
│    from Ben again               │
│                                 │
│  • Ben will see your new        │
│    content again                │
│                                 │
│  • New content will be shared   │
│    (content created during the  │
│    "hidden period" will not)    │
│                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━    │
│                                 │
│  [ Cancel ]                     │
│                                 │
│  [ Restore ]                    │
│                                 │
└─────────────────────────────────┘
```

---

## Visibility matrix

### What does who see after hiding?

| Content | Anna sees | Ben sees |
| ------- | --------- | -------- |
| Ben's old content (before hiding) | Yes (locally stored) | — |
| Ben's new content (after hiding) | No | — |
| Anna's old content | — | Yes (locally stored) |
| Anna's new content | — | No |
| Old attestations | Yes | Yes |
| New attestations | Yes (can be created) | Yes (receives them) |

### After restore

| Content | Anna sees | Ben sees |
| ------- | --------- | -------- |
| Content during "hidden period" | No | No |
| New content (after restore) | Yes | Yes |

---

## Personas

### Anna hides an annoying contact

```mermaid
sequenceDiagram
    participant A as Anna
    participant App as App

    Note over A: Max posts too much uninteresting content

    A->>App: Opens Max's profile
    A->>App: Taps "Hide"
    A->>App: Confirms

    Note over A: Max's new posts no longer appear

    Note over A: 3 months later

    Note over A: Max has changed

    A->>App: Settings → Hidden contacts
    A->>App: Restore Max

    Note over A: Max's new posts appear again
```

### Kemal after an argument

```mermaid
sequenceDiagram
    participant K as Kemal
    participant B as Ben

    Note over K,B: Argument at the repair café

    K->>K: Hides Ben
    B->>B: Hides Kemal

    Note over K,B: Both see nothing from each other

    Note over K,B: One year later, reconciled

    K->>K: Restores Ben
    B->>B: Restores Kemal

    Note over K,B: Connection restored
```

---

## Comparison with other systems

| System | "Unfriend" means |
| ------ | ---------------- |
| Facebook | Relationship deleted, must be re-added |
| WhatsApp | Block prevents all messages |
| Web of Trust | Hide is temporary, verification stays |

### Why this design?

```
┌─────────────────────────────────┐
│                                 │
│  Design decision                │
│                                 │
│  Verification is a statement    │
│  about the past:                │
│                                 │
│  "I met this person in person   │
│   on 08.01.2026"                │
│                                 │
│  That cannot be "undone".       │
│                                 │
│  Hide only means:               │
│  "I don't want to share         │
│   content with this person      │
│   right now."                   │
│                                 │
└─────────────────────────────────┘
```

---

## FAQ

**Can the other person see that I hid them?**
Not directly. But if they notice they no longer see your new content, they may suspect it.

**Can I still create attestations for hidden contacts?**
Yes. Attestations are independent of hide status. Ben receives the attestation even when hidden.

**What happens with groups when I hide someone?**
You both remain in shared groups. But your "for all contacts" content no longer reaches this person.

**Can I permanently remove someone?**
No. The verification stays. You can only hide.

**What if both sides hide each other?**
Then neither sees content from the other. Both can independently restore the connection.
