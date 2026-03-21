# Verification Flow (User Perspective)

> What Anna and Ben experience

## Main Flow: Mutual Verification

```mermaid
sequenceDiagram
    participant A as Anna
    participant B as Ben

    Note over A,B: Meet at a street festival

    A->>B: Are you on Web of Trust?
    B->>A: Yes! Let's connect.

    rect rgb(230, 245, 255)
        Note over A,B: Phase 1 — Ben verifies Anna
        A->>A: Shows QR code
        B->>A: Scans, sees profile
        B->>B: Sees: 8 of your contacts have verified Anna
        B->>B: Taps Confirm identity
    end

    rect rgb(255, 245, 230)
        Note over A,B: Phase 2 — Anna verifies Ben
        B->>B: Shows QR code
        A->>B: Scans, sees profile
        A->>A: Sees: 12 of your contacts have verified Ben
        A->>A: Taps Confirm identity
    end

    rect rgb(230, 255, 230)
        Note over A,B: Connection established
        Note over A: Ben is now in My contacts
        Note over A: Ben's verification appears on Anna's profile
        Note over B: Anna is now in My contacts
        Note over B: Anna's verification appears on Ben's profile
    end
```

> **Note:** Verifications are stored at the recipient's side. Anna's profile reads "Verified by: Ben". Ben's profile reads "Verified by: Anna".

## Variant: One-Sided Verification — Pending

```mermaid
sequenceDiagram
    participant A as Anna
    participant B as Ben

    Note over A,B: Brief encounter — Ben has to catch a train

    A->>A: Shows QR code
    B->>A: Scans QR code
    B->>B: Verifies Anna

    Note over B: Ben has to go!

    rect rgb(255, 250, 230)
        Note over A,B: Pending status
        Note over B: Anna is verified in Ben's contacts
        Note over A: Ben appears as pending request
    end

    Note over A,B: Later at the next meeting

    B->>B: Shows QR code
    A->>B: Scans Ben's QR code
    A->>A: Verifies Ben

    rect rgb(230, 255, 230)
        Note over A,B: Now fully connected
    end
```

## What the User Sees

### When scanning (online)

```
┌─────────────────────────────────┐
│                                 │
│         📷 [Profile photo]      │
│                                 │
│          Anna Müller            │
│                                 │
│   "Active in the Sonnenberg     │
│    community garden"            │
│                                 │
├─────────────────────────────────┤
│ ✅ 12 of your contacts have     │
│    verified this person         │
├─────────────────────────────────┤
│                                 │
│   [ Confirm identity ]          │
│                                 │
│   [ Cancel ]                    │
│                                 │
└─────────────────────────────────┘
```

### When scanning (offline)

```
┌─────────────────────────────────┐
│                                 │
│         ⚠️ Offline              │
│                                 │
│   Profile cannot be loaded.     │
│                                 │
│                                 │
├─────────────────────────────────┤
│                                 │
│   ID check value:               │
│   ┌─────────────────────────┐   │
│   │  a7f3-82b1-c9d4-e5f6    │   │
│   └─────────────────────────┘   │
│                                 │
│   Ask the other person:         │
│   "What does your app show      │
│    as the ID check value?"      │
│                                 │
├─────────────────────────────────┤
│                                 │
│   [ Confirm identity ]          │
│                                 │
│   [ Cancel ]                    │
│                                 │
└─────────────────────────────────┘
```

### Contact list afterwards

```
┌─────────────────────────────────┐
│  My contacts                    │
├─────────────────────────────────┤
│                                 │
│  👩 Anna Müller          ✅     │
│     Verified on 08.01.25        │
│                                 │
│  👨 Ben Schmidt          ✅     │
│     Verified on 08.01.25        │
│                                 │
│  👴 Tom Wagner           ✅     │
│     Verified on 03.01.25        │
│                                 │
├─────────────────────────────────┤
│  Pending                        │
├─────────────────────────────────┤
│                                 │
│  👩 Carla Braun          ⏳     │
│     Waiting for confirmation    │
│                                 │
└─────────────────────────────────┘
```
