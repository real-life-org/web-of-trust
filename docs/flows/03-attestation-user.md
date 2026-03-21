# Attestation Flow (User Perspective)

> How users create and view attestations

## What is an Attestation?

An attestation is a **signed statement** made by one person about another person.

| Verification | Attestation |
|--------------|-------------|
| "I have met this person" | "This person did X" |
| Identity confirmation | Building trust |
| Once per contact | Any number possible |
| Binary (yes/no) | Content-rich (what, when, where) |

## Main Flow: Creating an Attestation

```mermaid
sequenceDiagram
    participant A as Anna
    participant App as Anna's App
    participant B as Ben

    Note over A,B: Ben helped in the garden

    A->>App: Opens Ben's profile
    A->>App: Taps Create Attestation

    App->>A: Shows form

    A->>App: Enter description
    Note over App: "Ben helped for 3 hours in the community garden"

    A->>App: Select tags
    Note over App: Garden, Helping, Community

    A->>App: Optional: select group
    Note over App: Community Garden Sonnenberg

    A->>App: Taps Create Attestation

    App->>App: Signs with Anna's private key
    App->>App: Delivers to Ben via Relay (Outbox pattern)

    App->>A: Attestation created!

    Note over B: Ben sees the new attestation in his profile
```

> **Delivery:** Attestations are sent via the **AttestationDeliveryService** and the **Outbox pattern** — messages are queued locally and delivered reliably via the WebSocket Relay, with redelivery on reconnect.

## Variant: Quick Attestation (Thank-You Button)

```mermaid
sequenceDiagram
    participant A as Anna
    participant App as Anna's App

    Note over A: Ben just helped out

    A->>App: Opens Ben's profile
    A->>App: Taps Thank-You button

    App->>A: Quick attestation suggestions
    Note over App: Helped out, Was friendly, Good work

    A->>App: Selects a template
    A->>App: Optional: adjust text
    A->>App: Taps Send

    App->>App: Creates and signs attestation

    App->>A: Thanks sent!
```

## What the User Sees

### Ben's Profile with Attestation Button

```
┌─────────────────────────────────┐
│                                 │
│         📷 [Profile photo]      │
│                                 │
│          Ben Schmidt            │
│     "New to the neighborhood"   │
│                                 │
├─────────────────────────────────┤
│                                 │
│  Verified on 08.01.25 ✅        │
│                                 │
│  12 attestations received       │
│                                 │
├─────────────────────────────────┤
│                                 │
│  [ 👍 Thanks ] [ ✍️ Attest ]    │
│                                 │
├─────────────────────────────────┤
│                                 │
│  Recent attestations:           │
│                                 │
│  "Helped with moving"           │
│  by Tom · 3 days ago            │
│                                 │
│  "Knows bikes really well"      │
│  by Carla · 1 week ago          │
│                                 │
│  [ Show all ]                   │
│                                 │
└─────────────────────────────────┘
```

### Create Attestation — Form

```
┌─────────────────────────────────┐
│                                 │
│  ✍️ Attestation for Ben          │
│                                 │
├─────────────────────────────────┤
│                                 │
│  What do you want to attest?    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ Ben helped for 3 hours  │    │
│  │ in the community garden │    │
│  │ and watered the         │    │
│  │ tomatoes.               │    │
│  │                         │    │
│  └─────────────────────────┘    │
│                                 │
│  Tags (select relevant):        │
│                                 │
│  [Garden] [Helping] [Crafts]    │
│  [Advice] [Transport] [+New]    │
│                                 │
│  In context of a group?         │
│                                 │
│  ┌─────────────────────────┐    │
│  │ Community Garden     ▼  │    │
│  └─────────────────────────┘    │
│                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━    │
│                                 │
│  ℹ️ Attestations cannot be       │
│    taken back.                  │
│                                 │
│  [ Create Attestation ]         │
│                                 │
└─────────────────────────────────┘
```

### Quick Attestation (Thank You)

```
┌─────────────────────────────────┐
│                                 │
│  👍 Thanks to Ben               │
│                                 │
├─────────────────────────────────┤
│                                 │
│  What do you want to thank      │
│  them for?                      │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 🌱 Helped in the        │    │
│  │    garden               │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 🔧 Fixed something      │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 📦 Helped carry things  │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 💬 Had a great          │    │
│  │    conversation         │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ ✍️ Write custom text...  │    │
│  └─────────────────────────┘    │
│                                 │
└─────────────────────────────────┘
```

### Attestation Created — Confirmation

```
┌─────────────────────────────────┐
│                                 │
│         ✅ Attestation          │
│            created!             │
│                                 │
├─────────────────────────────────┤
│                                 │
│  "Ben helped for 3 hours in     │
│   the community garden"         │
│                                 │
│  Tags: Garden, Helping          │
│  Group: Community Garden        │
│                                 │
│  Signed: 08.01.25 14:32         │
│                                 │
├─────────────────────────────────┤
│                                 │
│  Ben will be notified.          │
│                                 │
│  [ Done ]                       │
│                                 │
└─────────────────────────────────┘
```

## Viewing Attestations

### My Received Attestations

```
┌─────────────────────────────────┐
│                                 │
│  📜 My Attestations             │
│                                 │
│  Filter: [All ▼] [Garden ▼]     │
│                                 │
├─────────────────────────────────┤
│                                 │
│  ┌─────────────────────────┐    │
│  │ "Helped for 3 hours     │    │
│  │  in the garden"         │    │
│  │                         │    │
│  │  👩 Anna · 08.01.25      │    │
│  │  🏷️ Garden, Helping      │    │
│  │  👥 Community Garden     │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ "Knows bikes really     │    │
│  │  well"                  │    │
│  │                         │    │
│  │  👴 Tom · 05.01.25       │    │
│  │  🏷️ Crafts, Bicycle      │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ "Helped with the move   │    │
│  │  — super reliable!"     │    │
│  │                         │    │
│  │  👩 Carla · 01.01.25     │    │
│  │  🏷️ Helping, Transport   │    │
│  └─────────────────────────┘    │
│                                 │
└─────────────────────────────────┘
```

### Viewing a Contact's Attestations

```
┌─────────────────────────────────┐
│                                 │
│  📜 Attestations for Ben        │
│                                 │
│  23 attestations from           │
│  8 different people             │
│                                 │
├─────────────────────────────────┤
│                                 │
│  Most common tags:              │
│                                 │
│  ████████████ Helping (12)      │
│  ████████     Garden (8)        │
│  █████        Crafts (5)        │
│  ███          Transport (3)     │
│                                 │
├─────────────────────────────────┤
│                                 │
│  From your contacts:            │
│                                 │
│  👩 Anna (3 attestations)       │
│  👴 Tom (2 attestations)        │
│  👩 Carla (1 attestation)       │
│                                 │
│  From others:                   │
│  👤 5 more people               │
│                                 │
├─────────────────────────────────┤
│                                 │
│  [ All attestations ]           │
│                                 │
└─────────────────────────────────┘
```

## Personas

### Kemal attests after a Repair Café

```mermaid
sequenceDiagram
    participant K as Kemal
    participant App as App

    Note over K: After the Repair Café

    K->>App: Opens participant list

    loop For each helper
        K->>App: Opens profile
        K->>App: Taps Thanks
        K->>App: Selects "Repaired something"
        K->>App: Adds detail
        Note over App: "Fixed 2 bicycles"
        K->>App: Send
    end

    Note over K: 5 attestations in 3 minutes
```

### Greta thanks Tom

```mermaid
sequenceDiagram
    participant G as Greta
    participant T as Tom
    participant App as App

    Note over G,T: Tom helped Greta with the app

    G->>App: Opens Tom's profile
    G->>App: Sees Thank-You button
    G->>App: Taps Thanks

    App->>G: Shows quick options

    G->>App: Selects "Had a great conversation"
    G->>App: Send

    App->>G: Thanks sent!

    Note over T: Tom sees notification
```

## Rules and Constraints

### What Attestations CANNOT Do

```mermaid
flowchart TD
    A["Attestation created"] --> B{"What happens?"}

    B --> C["CANNOT be deleted"]
    B --> D["CANNOT be edited"]
    B --> E["CANNOT be revoked"]

    C --> F["Attestation persists forever"]
    D --> F
    E --> F

    F --> G["But: recipient can hide it"]

    style A stroke:#888,fill:none,color:inherit
    style B stroke:#888,fill:none,color:inherit
    style C stroke:#e55,fill:none,color:inherit
    style D stroke:#e55,fill:none,color:inherit
    style E stroke:#e55,fill:none,color:inherit
    style F stroke:#888,fill:none,color:inherit
    style G stroke:#5a5,fill:none,color:inherit
```

> **Note:** The recipient can hide unwanted attestations by setting `attestationMetadata.accepted = false`. They remain stored but are not publicly visible.

### Why can't they be deleted?

| Reason | Explanation |
|--------|-------------|
| Integrity | Signed statements are immutable |
| Trust | Others rely on the statement |
| Abuse prevention | Otherwise one could collect positive attestations and then delete them |

### Handling incorrect attestations

If someone attested something incorrectly:

1. **New attestation:** Create a correcting attestation
2. **Hide contact:** If attestations are systematically wrong
3. **Social consequence:** Those who attest falsely lose credibility

## Visibility of Attestations

With the **recipient principle**, the attestation is stored at Ben's end — he controls visibility:

```mermaid
flowchart TD
    A["Anna creates attestation for Ben"] --> B["Attestation stored in Ben's PersonalDoc CRDT"]

    B --> C{"Ben can decide"}

    C --> D["Leave visible (default)"]
    C --> E["Hide (attestationMetadata.accepted = false)"]

    D --> F["Ben's contacts see it in his profile"]
    E --> G["Only Ben himself sees it"]

    style A stroke:#888,fill:none,color:inherit
    style B stroke:#888,fill:none,color:inherit
    style C stroke:#888,fill:none,color:inherit
    style D stroke:#5a5,fill:none,color:inherit
    style E stroke:#a55,fill:none,color:inherit
    style F stroke:#5a5,fill:none,color:inherit
    style G stroke:#888,fill:none,color:inherit
```

### Visibility Matrix

| Viewer | Sees attestation? | Why? |
|--------|-------------------|------|
| Ben (recipient) | ✅ Always | It's his profile, he controls visibility |
| Ben's contacts | ✅ Unless hidden | Part of Ben's profile |
| Anna (creator) | ✅ If Ben's contact | Sees Ben's profile |
| Strangers | ❌ No | Not in Ben's network |

> **Note:** Ben can hide unwanted attestations but not delete them. Anna's signature remains valid.
