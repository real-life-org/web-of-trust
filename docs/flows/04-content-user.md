# Content Flow (User Perspective)

> How users create and share content

> **Status: Planned — not yet implemented in the demo app.**
> The content types described here (Calendar, Map, Offers, Requests, Projects) are part of the planned feature set. The current demo app implements Attestations and Group Spaces. Content types will be built on the same infrastructure (PersonalDoc CRDT, Relay, Vault).

## Content Types

The Web of Trust supports several content types:

| Type | Description | Example |
| --- | --- | --- |
| Calendar | Events and appointments | "Garden meetup on Saturday" |
| Map | Locations and markers | "Tool lending at Anna's" |
| Project | Collaborative initiatives | "Community Garden 2025" |
| Offer | What I can offer | "Can repair bikes" |
| Request | What I'm looking for | "Need help moving" |

---

## Main Flow: Creating Content

```mermaid
sequenceDiagram
    participant A as Anna
    participant App as Anna's App

    A->>App: Taps + button
    App->>A: Shows content types

    A->>App: Selects Calendar

    App->>A: Shows form

    A->>App: Enters: title, date, location, description

    A->>App: Selects visibility
    Note over App: All contacts / Selected / Group

    A->>App: Taps Create

    App->>App: Encrypts for chosen recipients
    App->>App: Stores in PersonalDoc CRDT
    App->>App: Syncs via Relay

    App->>A: Event created!
```

---

## Controlling Visibility

### Options When Creating

```mermaid
flowchart TD
    Create(["Create content"]) --> Visibility{"Who should see it?"}

    Visibility --> All["All my contacts"]
    Visibility --> Selected["Selected people"]
    Visibility --> Groups["One or more groups"]

    All --> AutoGroup["Encrypted with auto-group key"]
    Selected --> Individual["Encrypted individually per recipient"]
    Groups --> GroupKeys["Encrypted with group key(s)"]

    AutoGroup --> Sync["Sync via Relay"]
    Individual --> Sync
    GroupKeys --> Sync

    style Create stroke:#888,fill:none,color:inherit
    style Visibility stroke:#888,fill:none,color:inherit
    style All stroke:#888,fill:none,color:inherit
    style Selected stroke:#888,fill:none,color:inherit
    style Groups stroke:#888,fill:none,color:inherit
    style AutoGroup stroke:#888,fill:none,color:inherit
    style Individual stroke:#888,fill:none,color:inherit
    style GroupKeys stroke:#888,fill:none,color:inherit
    style Sync stroke:#5a5,fill:none,color:inherit
```

### Changing Visibility Later

Content visibility can be expanded after creation (add more recipients), but not restricted (copies already shared cannot be recalled).

---

## What the User Sees

### Create New Content

```
┌─────────────────────────────────┐
│                                 │
│   + New Content                 │
│                                 │
├─────────────────────────────────┤
│                                 │
│   ┌─────────────────────────┐   │
│   │  📅 Calendar Entry      │   │
│   │     Event or appointment│   │
│   └─────────────────────────┘   │
│                                 │
│   ┌─────────────────────────┐   │
│   │  📍 Map Marker          │   │
│   │     Location or address │   │
│   └─────────────────────────┘   │
│                                 │
│   ┌─────────────────────────┐   │
│   │  📋 Project             │   │
│   │     Collaborative       │   │
│   │     initiative          │   │
│   └─────────────────────────┘   │
│                                 │
│   ┌─────────────────────────┐   │
│   │  🤝 Offer               │   │
│   │     What I can offer    │   │
│   └─────────────────────────┘   │
│                                 │
│   ┌─────────────────────────┐   │
│   │  🔍 Request             │   │
│   │     What I'm looking for│   │
│   └─────────────────────────┘   │
│                                 │
└─────────────────────────────────┘
```

### Create Calendar Entry

```
┌─────────────────────────────────┐
│                                 │
│   📅 New Event                  │
│                                 │
├─────────────────────────────────┤
│                                 │
│   Title *                       │
│   ┌─────────────────────────┐   │
│   │ Garden meetup           │   │
│   └─────────────────────────┘   │
│                                 │
│   Date *                        │
│   ┌─────────────────────────┐   │
│   │ Sat, 15.01.2025  14:00  │   │
│   └─────────────────────────┘   │
│                                 │
│   Location                      │
│   ┌─────────────────────────┐   │
│   │ Community Garden        │   │
│   │ Sonnenberg              │   │
│   └─────────────────────────┘   │
│                                 │
│   Description                   │
│   ┌─────────────────────────┐   │
│   │ We'll be preparing the  │   │
│   │ beds for spring.        │   │
│   │ Please bring gloves!    │   │
│   └─────────────────────────┘   │
│                                 │
│   ━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                 │
│   Who should see this?          │
│                                 │
│   (•) All my contacts           │
│   ( ) Selected people           │
│   ( ) Groups:                   │
│       [ ] Community Garden      │
│       [ ] Neighborhood Help     │
│       [ ] Repair Café           │
│                                 │
│   [ Create Event ]              │
│                                 │
└─────────────────────────────────┘
```

### Create Map Marker

```
┌─────────────────────────────────┐
│                                 │
│   📍 New Marker                 │
│                                 │
├─────────────────────────────────┤
│                                 │
│   ┌─────────────────────────┐   │
│   │                         │   │
│   │      [Map with pin]     │   │
│   │           📍            │   │
│   │                         │   │
│   └─────────────────────────┘   │
│                                 │
│   Title *                       │
│   ┌─────────────────────────┐   │
│   │ Tool lending            │   │
│   └─────────────────────────┘   │
│                                 │
│   Category                      │
│   ┌─────────────────────────┐   │
│   │ Lending              ▼  │   │
│   └─────────────────────────┘   │
│                                 │
│   Description                   │
│   ┌─────────────────────────┐   │
│   │ Tools available to      │   │
│   │ borrow here. Just ring! │   │
│   └─────────────────────────┘   │
│                                 │
│   [ Create Marker ]             │
│                                 │
└─────────────────────────────────┘
```

### Content Overview (Feed)

```
┌─────────────────────────────────┐
│  News                           │
├─────────────────────────────────┤
│                                 │
│  ┌─────────────────────────┐    │
│  │ 📅 Garden meetup        │    │
│  │    Sat, 15.01. 14:00    │    │
│  │                         │    │
│  │    👩 Anna · 2h ago      │    │
│  │    📍 Community Garden   │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 🤝 Offer                │    │
│  │    Can help with moving │    │
│  │                         │    │
│  │    👨 Ben · 1 day ago    │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 🔍 Request              │    │
│  │    Looking for a drill  │    │
│  │    to borrow            │    │
│  │                         │    │
│  │    👴 Tom · 3 days ago   │    │
│  └─────────────────────────┘    │
│                                 │
│  [ Load more ]                  │
│                                 │
└─────────────────────────────────┘
```

---

## Personas

### Anna shares an event

```mermaid
sequenceDiagram
    participant A as Anna
    participant App as App
    participant Contacts as Anna's Contacts

    Note over A: Planning a garden meetup

    A->>App: New calendar entry
    A->>App: Garden meetup, Sat 14:00
    A->>App: Visibility: All contacts
    A->>App: Create

    App->>App: Encrypt for auto-group
    App->>App: Sync via Relay

    Note over Contacts: Ben, Tom, Carla see the event
```

### Kemal creates offers after Repair Café

```mermaid
sequenceDiagram
    participant K as Kemal
    participant App as App

    Note over K: After the Repair Café

    loop For each helper
        K->>App: New offer
        K->>App: "Max can repair bikes"
        K->>App: Visibility: All contacts
        K->>App: Create
    end

    Note over K: 5 offers documented in 3 minutes
```

### The Yilmaz family needs help

```mermaid
sequenceDiagram
    participant Y as Yilmaz family
    participant App as App
    participant N as Neighbors

    Note over Y: New to the area, need help moving

    Y->>App: New request
    Y->>App: "Looking for help moving on Saturday"
    Y->>App: Visibility: All contacts
    Y->>App: Create

    App->>App: Sync via Relay

    Note over N: Neighbors see the request

    N->>App: Reply or get in touch
```

---

## Editing and Deleting Content

### Editing

```mermaid
flowchart TD
    Edit(["Edit content"]) --> Change["Make changes"]

    Change --> NewVersion["Create new version"]

    NewVersion --> Encrypt["Re-encrypt for all recipients"]

    Encrypt --> Sync["Sync via Relay — replaces old version"]

    style Edit stroke:#888,fill:none,color:inherit
    style Change stroke:#888,fill:none,color:inherit
    style NewVersion stroke:#888,fill:none,color:inherit
    style Encrypt stroke:#888,fill:none,color:inherit
    style Sync stroke:#5a5,fill:none,color:inherit
```

**Note:** Recipients who already have the old version retain it locally. The new version overwrites on the next sync.

### Deleting

```mermaid
flowchart TD
    Delete(["Delete content"]) --> Confirm{"Really delete?"}

    Confirm -->|Yes| MarkDeleted["Mark as deleted"]
    Confirm -->|No| Cancel["Cancel"]

    MarkDeleted --> Sync["Sync deletion marker via Relay"]

    Sync --> Note["Recipients are notified"]

    style Delete stroke:#888,fill:none,color:inherit
    style Confirm stroke:#888,fill:none,color:inherit
    style MarkDeleted stroke:#a55,fill:none,color:inherit
    style Cancel stroke:#888,fill:none,color:inherit
    style Sync stroke:#888,fill:none,color:inherit
    style Note stroke:#888,fill:none,color:inherit
```

**Note:** Deleted content is shown to recipients as "no longer available". Encrypted data cannot be remotely deleted.

---

## Calendar View

```
┌─────────────────────────────────┐
│  📅 January 2025                │
│  ◄                          ►   │
├─────────────────────────────────┤
│  Mo Tu We Th Fr Sa Su           │
│                    1  2  3  4   │
│   5  6  7  8  9 10 11           │
│  12 13 14[15]16 17 18           │
│  19 20 21 22 23 24 25           │
│  26 27 28 29 30 31              │
├─────────────────────────────────┤
│                                 │
│  Sat, 15 January                │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 14:00 Garden meetup     │    │
│  │       👩 Anna            │    │
│  │       📍 Community       │    │
│  │          Garden          │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 18:00 Repair Café       │    │
│  │       👨 Kemal           │    │
│  │       📍 Community       │    │
│  │          Center          │    │
│  └─────────────────────────┘    │
│                                 │
└─────────────────────────────────┘
```

---

## Map View

```
┌─────────────────────────────────┐
│  🗺️ Map                         │
│  Filter: [All ▼]                │
├─────────────────────────────────┤
│                                 │
│   ┌─────────────────────────┐   │
│   │                         │   │
│   │     📍 Tools            │   │
│   │          📍 Garden      │   │
│   │                    📍   │   │
│   │        📍               │   │
│   │     Repair              │   │
│   │                         │   │
│   └─────────────────────────┘   │
│                                 │
├─────────────────────────────────┤
│  Nearby:                        │
│                                 │
│  📍 Tool lending (200m)         │
│     Lending · Anna              │
│                                 │
│  📍 Community Garden (350m)     │
│     Garden · Group              │
│                                 │
│  📍 Repair Café (500m)          │
│     Repair · Kemal              │
│                                 │
└─────────────────────────────────┘
```

---

## Notifications

Users are notified when:

| Event | Notification |
| --- | --- |
| New content from contact | "Anna shared an event" |
| Content was updated | "Event was changed" |
| Content was deleted | "Event is no longer available" |
| Upcoming event | "Garden meetup in 1 hour" |

---

## Constraints

| What | Constraint |
| --- | --- |
| Restrict visibility | Not possible after sharing |
| Expand visibility | Possible at any time |
| Delete content | Marked as deleted, not physically removed |
| Create offline | Possible, synced on reconnect via Relay |
