# Onboarding Flow (User Perspective)

> How a new user joins the network

## Overview: Two Paths into the Network

```mermaid
flowchart TD
    Start(["New person wants to join"]) --> How{"How?"}

    How -->|Invited| Invited["Scanned by an existing user"]
    How -->|Independent| Solo["Creates identity alone"]

    Invited --> Verify["Mutual verification"]
    Verify --> Connected["Immediately connected — sees content"]

    Solo --> Alone["Has identity but empty network"]
    Alone --> Later["Must meet people in person later"]
    Later --> Connected

    style Connected stroke:#22c55e,stroke-width:2px
    style Alone stroke:#f59e0b,stroke-width:2px
```

## Main Flow: Onboarding via Invitation

```mermaid
sequenceDiagram
    participant A as Anna — Inviting
    participant B as Ben — New

    Note over A,B: In-person meeting

    A->>B: Have you heard of Web of Trust? I can invite you.
    B->>A: No, what is it?
    A->>B: An app for our neighbourhood. Scan this.

    rect rgb(230, 245, 255)
        Note over A,B: Phase 1 — Install the app
        A->>A: Shows QR code
        B->>B: Scans with phone camera
        B->>B: Link opens app store
        B->>B: Installs app
        B->>B: Opens app
    end

    rect rgb(255, 245, 230)
        Note over A,B: Phase 2 — See Anna's profile
        B->>B: App shows: You were invited by…
        B->>B: Sees Anna's profile
        Note over B: Name, photo, bio, 23 attestations
    end

    rect rgb(245, 230, 255)
        Note over A,B: Phase 3 — Create own identity
        B->>B: To join, create your identity
        B->>B: Enters name
        B->>B: Optional: photo and bio
        B->>B: Taps Create identity
        Note over B: Keys are generated
    end

    rect rgb(255, 230, 230)
        Note over A,B: Phase 4 — Save recovery phrase (REQUIRED)
        B->>B: Sees 12-word recovery phrase
        Note over B: CRITICAL — shown ONLY NOW!
        B->>B: Writes words down
        B->>B: Taps Continue
        B->>B: Quiz: which is word 3?
        B->>B: Quiz: which is word 7?
        B->>B: Quiz: which is word 11?
        Note over B: Must answer all 3 correctly to proceed
    end

    rect rgb(230, 255, 230)
        Note over A,B: Phase 5 — Mutual verification
        B->>B: Taps Confirm Anna
        B->>B: Shows own QR code
        B->>A: Now you scan me
        A->>B: Scans Ben's QR
        A->>A: Sees Ben's new profile
        A->>A: Taps Confirm identity
    end

    Note over A,B: Ben is in the network!
    Note over B: Sees Anna's content — can share own content
```

## Variant: Independent Onboarding

```mermaid
sequenceDiagram
    participant B as Ben — alone

    Note over B: Finds app in store

    B->>B: Installs app
    B->>B: Opens app

    rect rgb(245, 230, 255)
        Note over B: Create own identity
        B->>B: Welcome to Web of Trust
        B->>B: Create your identity
        B->>B: Enters name
        B->>B: Optional: photo and bio
        B->>B: Taps Create identity
    end

    rect rgb(255, 230, 230)
        Note over B: Save recovery phrase (REQUIRED)
        B->>B: Sees recovery phrase
        B->>B: Writes it down
        B->>B: Passes 3-word quiz
    end

    rect rgb(255, 250, 230)
        Note over B: Empty network
        B->>B: Sees dashboard
        Note over B: You have no contacts yet
        B->>B: Can edit own profile
        B->>B: Can show QR code
        B->>B: Sees no content
    end

    Note over B: Waits for real-world encounters
```

## What the User Sees

### Welcome Screen (invited)

```
┌─────────────────────────────────┐
│                                 │
│      🌐 Web of Trust            │
│                                 │
│   You were invited by:          │
│                                 │
│         📷 [Profile photo]      │
│          Anna Müller            │
│                                 │
│   "Active in the Sonnenberg     │
│    community garden"            │
│                                 │
│   ✅ 23 attestations            │
│   ✅ 47 verifications           │
│                                 │
├─────────────────────────────────┤
│                                 │
│   [ Join now ]                  │
│                                 │
│   What is Web of Trust? ℹ️       │
│                                 │
└─────────────────────────────────┘
```

### Create profile

```
┌─────────────────────────────────┐
│                                 │
│   Create your profile           │
│                                 │
│   ┌─────────────────────────┐   │
│   │                         │   │
│   │     📷 Add photo        │   │
│   │       (optional)        │   │
│   │                         │   │
│   └─────────────────────────┘   │
│                                 │
│   Name *                        │
│   ┌─────────────────────────┐   │
│   │ Ben Schmidt             │   │
│   └─────────────────────────┘   │
│                                 │
│   About me (optional)           │
│   ┌─────────────────────────┐   │
│   │ New to the area,        │   │
│   │ interested in...        │   │
│   └─────────────────────────┘   │
│                                 │
│   [ Continue ]                  │
│                                 │
└─────────────────────────────────┘
```

### Recovery phrase (REQUIRED)

```
┌─────────────────────────────────┐
│                                 │
│   🔐 Your recovery phrase       │
│                                 │
│   ⚠️  IMPORTANT — READ THIS!    │
│                                 │
│   These 12 words are shown      │
│   to you ONLY NOW.              │
│   They CANNOT be retrieved      │
│   again!                        │
│                                 │
│   ┌─────────────────────────┐   │
│   │                         │   │
│   │  1. absurd   7. fenster │   │
│   │  2. banane   8. garten  │   │
│   │  3. chaos    9. haus    │   │
│   │  4. dichte  10. irrtum  │   │
│   │  5. eiche   11. jagd    │   │
│   │  6. fluss   12. kiefer  │   │
│   │                         │   │
│   └─────────────────────────┘   │
│                                 │
│   📝 Write them down NOW        │
│   🚫 Do not take a screenshot   │
│   🔒 Store them somewhere safe  │
│                                 │
│   [ Continue to quiz ]          │
│                                 │
└─────────────────────────────────┘
```

### Verify phrase (REQUIRED)

```
┌─────────────────────────────────┐
│                                 │
│   Confirm your backup           │
│                                 │
│   Which is word number 4?       │
│                                 │
│   ┌─────────┐ ┌─────────┐       │
│   │ dichte  │ │  eiche  │       │
│   └─────────┘ └─────────┘       │
│   ┌─────────┐ ┌─────────┐       │
│   │ fluss   │ │ absurd  │       │
│   └─────────┘ └─────────┘       │
│                                 │
│   ━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│   Question 1 of 3               │
│                                 │
└─────────────────────────────────┘
```

On wrong answer:

```
┌─────────────────────────────────┐
│                                 │
│   ❌ Incorrect                  │
│                                 │
│   Word 4 is "dichte"            │
│                                 │
│   Please check your notes       │
│   and try again.                │
│                                 │
│   [ Back to phrase ]            │
│                                 │
└─────────────────────────────────┘
```

### Confirm first contact

```
┌─────────────────────────────────┐
│                                 │
│   ✅ Your identity was created! │
│                                 │
│   Now confirm Anna:             │
│                                 │
│         📷 [Anna's photo]       │
│          Anna Müller            │
│                                 │
│   Is this the person standing   │
│   in front of you right now?    │
│                                 │
│   [ Yes, confirm identity ]     │
│                                 │
│   [ No, cancel ]                │
│                                 │
└─────────────────────────────────┘
```

### Show QR code

```
┌─────────────────────────────────┐
│                                 │
│   Almost done!                  │
│                                 │
│   Show Anna this code:          │
│                                 │
│   ┌─────────────────────────┐   │
│   │                         │   │
│   │      ▄▄▄▄▄▄▄▄▄▄▄       │   │
│   │      █ QR-CODE █       │   │
│   │      █         █       │   │
│   │      ▀▀▀▀▀▀▀▀▀▀▀       │   │
│   │                         │   │
│   └─────────────────────────┘   │
│                                 │
│   Ben Schmidt                   │
│   did:key:z6MkpTHz...          │
│                                 │
│   "Now you scan me"             │
│                                 │
└─────────────────────────────────┘
```

### Welcome to the network

```
┌─────────────────────────────────┐
│                                 │
│   🎉 Welcome to the network!    │
│                                 │
│   You are now connected with:   │
│                                 │
│   👩 Anna Müller                │
│                                 │
├─────────────────────────────────┤
│                                 │
│   Next steps:                   │
│                                 │
│   📅 See Anna's events          │
│                                 │
│   🗺️  Places nearby             │
│                                 │
│   👥 Meet more people           │
│                                 │
│   [ Let's go ]                  │
│                                 │
└─────────────────────────────────┘
```

## Personas During Onboarding

### Greta (62) — needs help

```mermaid
sequenceDiagram
    participant T as Tom — neighbour helping
    participant G as Greta — not tech-savvy

    T->>G: Greta, let me show you the neighbourhood app
    G->>T: I'm not very good with technology...
    T->>G: No problem, I'll guide you through it

    T->>T: Shows QR code
    T->>G: Hold your phone up here
    G->>G: Scans with help

    Note over G: App store opens
    T->>G: Now tap Install
    G->>G: Installs

    Note over G: App opens
    T->>G: Can you see my photo? Tap Join
    G->>G: Taps

    Note over G: Enter name
    T->>G: Type in your name
    G->>G: Types Greta

    Note over G: Recovery phrase — REQUIRED
    T->>G: Now comes the important part. Do you have pen and paper?
    G->>G: Gets notebook
    T->>G: These 12 words are only shown ONCE
    G->>G: Writes them down
    T->>G: Double-check that everything is correct
    T->>G: In a moment the app will ask for 3 words
    G->>G: Answers quiz with Tom's help
    T->>G: Keep that safe, separate from your phone

    Note over T,G: Rest follows normal flow
```

### The Yilmaz family — street festival

```mermaid
sequenceDiagram
    participant K as Kemal — organiser
    participant F as Yilmaz family

    Note over K,F: Street festival information stand

    K->>F: New to the area? Welcome!
    F->>K: Yes, we don't know anyone yet
    K->>F: We have an app for neighbourhood help

    K->>K: Shows QR code
    F->>F: One family member scans
    F->>F: Goes through onboarding

    K->>K: Verifies the family

    K->>F: Now you can see who offers what
    K->>F: If you need help or want to offer some...

    Note over F: Immediately sees the garden group and more
```

## Edge Cases

### Cancelling during onboarding

```mermaid
flowchart TD
    Start(["Onboarding starts"]) --> Step1["App installed"]
    Step1 --> Step2["Profile entered"]
    Step2 --> Step3["Identity generated"]
    Step3 --> Step4["Recovery phrase shown"]
    Step4 --> Step5["Quiz passed"]
    Step5 --> Step6["Verification"]

    Step1 -->|Cancel| Cancel1["No problem"]
    Step2 -->|Cancel| Cancel2["Profile discarded"]

    Step3 -->|Cancel| Cancel3["CRITICAL — identity exists but phrase not shown"]

    Step4 -->|Cancel| Cancel4["CRITICAL — phrase shown, quiz not completed"]

    Step5 -->|Cancel| Cancel5["Identity and backup confirmed — OK"]
    Step6 -->|Cancel| Cancel6["Status pending — OK"]

    style Cancel3 stroke:#ef4444,stroke-width:2px
    style Cancel4 stroke:#ef4444,stroke-width:2px
```

**Important:**

- After step 3 (identity generated) the app blocks navigation away
- The user MUST pass the quiz to continue
- If the app is closed during phrase display or quiz: on next launch the app shows the phrase again and requires quiz completion

### Quiz not passed

If the user gives a wrong answer:

1. Error message with correct answer
2. Back to phrase display
3. Quiz restarts with new random word positions

There is **no way** to skip the quiz.
