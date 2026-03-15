# Architektur

> Framework-agnostische Architektur des Web of Trust
>
> Aktualisiert: 2026-02-15 (v2: 7-Adapter-Architektur + Offline-First + Outbox)

## Überblick

Das Web of Trust ist **framework-agnostisch** aufgebaut. Die Kernlogik ist unabhängig von der konkreten Implementierung der Datenhaltung, Kryptografie, Messaging und Synchronisation.

### Schichtenmodell (v2)

```
┌──────────────────────────────────────────────────────────────────┐
│                      WoT Application                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │               WoT Domain Layer                            │   │
│  │  • Identity, Contact, Verification, Attestation          │   │
│  │  • Item, Group, AutoGroup                                │   │
│  │  • Business Logic (Empfänger-Prinzip)                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│                            ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │            7 Adapter Interfaces                           │   │
│  │                                                           │   │
│  │  Lokal (v1, implementiert):                               │   │
│  │  • StorageAdapter        (lokale Persistenz)              │   │
│  │  • ReactiveStorageAdapter (Live Queries)                  │   │
│  │  • CryptoAdapter         (Signing/Encryption/DID)         │   │
│  │                                                           │   │
│  │  Netzwerk (v2, implementiert):                             │   │
│  │  • DiscoveryAdapter      (Öffentliche Profile/Discovery)  │   │
│  │  • MessagingAdapter      (Cross-User Delivery)            │   │
│  │  • ReplicationAdapter    (CRDT Sync + Spaces)             │   │
│  │                                                           │   │
│  │  Querschnitt (v2, geplant):                                │   │
│  │  • AuthorizationAdapter  (UCAN-like Capabilities)         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│     ┌────────┬─────────┬───┼────┬─────────┬─────────┐           │
│     ▼        ▼         ▼   ▼    ▼         ▼         ▼           │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐        │
│  │Evolu │ │wot-  │ │wot-  │ │Auto- │ │Matrix│ │Custom│        │
│  │Store │ │profi.│ │relay │ │merge │ │Client│ │UCAN  │        │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Drei orthogonale Achsen

```
Discovery-Achse                  Messaging-Achse               CRDT/Sync-Achse
(Öffentliche Sichtbarkeit)       (Zustellung zwischen DIDs)    (Zustandskonvergenz)

"Wie finde ich Infos              "Wie erreicht eine Nachricht  "Wie konvergiert der Zustand
 über eine DID?"                   den Empfänger?"               über Geräte und Nutzer?"

→ DiscoveryAdapter               → MessagingAdapter            → ReplicationAdapter
→ wot-profiles (POC)             → Custom WS (POC)             → Evolu (POC)
→ Automerge/DHT (Ziel)           → Matrix (Ziel)               → Automerge (Ziel)

  VOR dem Kontakt                  ZWISCHEN bekannten DIDs        INNERHALB einer Gruppe
  (öffentlich, anonym)             (privat, E2EE)                 (Group Key, CRDT)
```

## Adapter-Pattern

Die Adapter-Interfaces ermöglichen es, verschiedene Frameworks auszuprobieren, ohne die Kernlogik zu ändern.

### Warum Framework-agnostisch?

1. **Kein Framework passt zu 100%** — WoT-spezifische Anforderungen erfordern eigene Implementierung
2. **Zwei verschiedene Achsen** — CRDT/Sync und Messaging sind orthogonale Probleme
3. **Technologie-Landschaft bewegt sich** — NextGraph, p2panda, Willow könnten in 12 Monaten reif sein
4. **Phased Migration** — Custom WS → Matrix, Evolu → Automerge ohne Business-Logik-Änderung
5. **Testing** — Einfaches Mocking für Unit-Tests (NoOp-Implementierungen)

## Kernkonzepte

### Empfänger-Prinzip

Das zentrale Designprinzip: **Daten werden beim Empfänger gespeichert.**

```
Anna → Verification → Ben
       └─────────────────┘
       Gespeichert bei Ben

Anna → Attestation → Ben
       └────────────────┘
       Gespeichert bei Ben
```

**Warum?**
- Jeder kontrolliert seine eigenen Daten
- Keine Konflikte beim Schreiben (jeder schreibt nur in seinen eigenen Speicher)
- Einfachere CRDT-Konfliktauflösung
- Privacy: Ich entscheide, was über mich sichtbar ist

### Drei Sharing-Patterns

Die Architektur unterstützt drei fundamental verschiedene Sharing-Patterns:

```
1. GROUP SPACES (Kanban, Kalender, Karte)
   Mechanismus: ReplicationAdapter (CRDT Sync)
   Verschlüsselung: Group Key
   → Alle Members sehen alle Daten im Space

2. SELECTIVE SHARING (Event für 3 von 10 Kontakten)
   Mechanismus: MessagingAdapter (Item-Key Delivery)
   Verschlüsselung: Item-Key pro Item, encrypted per Recipient
   → Nur ausgewählte Empfänger können entschlüsseln

3. 1:1 DELIVERY (Attestation, Verification)
   Mechanismus: MessagingAdapter (Fire-and-forget)
   Verschlüsselung: E2EE mit Empfänger-PublicKey
   → Empfänger-Prinzip: gespeichert beim Empfänger
```

### Verification = Gegenseitige Bestätigung

Eine Verification ist eine signierte Aussage: "Ich habe diese Person verifiziert."

```
Anna verifiziert Ben:
┌────────────────────────────────────┐
│ Verification                       │
│ from: did:key:anna                 │
│ to: did:key:ben    ← Speicherort   │
│ proof: anna_signature              │
└────────────────────────────────────┘
→ Gespeichert bei Ben

Ben verifiziert Anna:
┌────────────────────────────────────┐
│ Verification                       │
│ from: did:key:ben                  │
│ to: did:key:anna   ← Speicherort   │
│ proof: ben_signature               │
└────────────────────────────────────┘
→ Gespeichert bei Anna
```

Jede Richtung ist ein **separates Dokument** mit **einer Signatur**.

### Attestation = Geschenk

Eine Attestation ist eine signierte Aussage über jemanden - wie ein Geschenk.

```
┌────────────────────────────────────┐
│ Attestation (signiert von Anna)    │
│ from: did:key:anna                 │
│ to: did:key:ben    ← Speicherort   │
│ claim: "Kann gut kochen"           │
│ proof: anna_signature              │
└────────────────────────────────────┘
→ Gespeichert bei Ben
→ Ben entscheidet: accepted = true/false
```

**Wichtig:** Das `accepted`-Flag ist **nicht** Teil des signierten Dokuments. Es ist lokale Metadaten, die nur der Empfänger kontrolliert.

### Contact = Lokaler Cache

Ein Contact speichert den Public Key einer verifizierten Person für E2E-Verschlüsselung.

```
Contact {
  did: "did:key:ben"
  publicKey: "..."        // Für Verschlüsselung
  status: "active"        // pending | active
}
```

## Adapter Interfaces

Die konkreten Interface-Definitionen befinden sich in `packages/wot-core/src/adapters/interfaces/`.

### Bestehend (v1, implementiert)

#### StorageAdapter

Verantwortlich für:
- Persistierung aller Daten (Identity, Contacts, Verifications, Attestations)
- Lokale Metadaten (AttestationMetadata mit `accepted`)

**Implementierungen:**
- `EvoluStorageAdapter` (Demo-App) - aktiv genutzt
- `LocalStorageAdapter` (IndexedDB) - in wot-core

#### ReactiveStorageAdapter

Verantwortlich für:
- Live Queries die auf Datenänderungen reagieren
- `Subscribable<T>` Pattern mit `useState`+`useEffect` (nicht `useSyncExternalStore` — Evolu's `loadQuery().then()` in `subscribe()` verletzt dessen Contract)
- `watchIdentity()` — Reaktive Identity-Änderungen beobachten

**Implementierungen:**
- `EvoluStorageAdapter` (implementiert beide Interfaces)

#### CryptoAdapter

Verantwortlich für:
- Key-Generierung (Ed25519)
- Mnemonic / Recovery Phrase (BIP39, deutsche Wortliste)
- Signieren und Verifizieren
- Verschlüsselung (X25519 + AES-256-GCM)
- DID-Konvertierung (did:key)

**Implementierungen:**
- `WebCryptoAdapter` (noble/ed25519 + Web Crypto API)

### Neu (v2)

#### DiscoveryAdapter

Verantwortlich für:

- Öffentliche Profile publizieren und abrufen
- Verifikationen und Attestationen öffentlich sichtbar machen
- DID-basierte Suche (wer ist diese DID?)

**Designprinzip:** Alles signiert (JWS), nichts verschlüsselt. Anonym lesbar, Inhaber kontrolliert Sichtbarkeit.

**Implementierungen:**

- `HttpDiscoveryAdapter` (wot-profiles) — HTTP REST + SQLite, aktiv genutzt
- `OfflineFirstDiscoveryAdapter` (Wrapper) — Offline-Cache + Dirty-Flag-Tracking, delegiert an HttpDiscoveryAdapter

#### MessagingAdapter

Verantwortlich für:
- Cross-User Delivery zwischen DIDs
- Attestation/Verification Zustellung (Empfänger-Prinzip)
- Item-Key Delivery (selektive Sichtbarkeit)
- DID-Auflösung (wie findet man den Empfänger?)

**Implementierungen:**

- `InMemoryMessagingAdapter` (Tests) — Shared-Bus Pattern für Unit-Tests
- `WebSocketMessagingAdapter` (POC) — Browser-nativer WebSocket Client + wot-relay Server, Ping/Pong Heartbeat (15s/5s)
- `OutboxMessagingAdapter` (POC) — Decorator mit persistenter Outbox-Queue für Offline-Zuverlässigkeit
- Matrix Client (Produktion, geplant)

**Offline-Zuverlässigkeit (Decorator Pattern):**

```text
OutboxMessagingAdapter (Wrapper)
  └── WebSocketMessagingAdapter (Inner)
       └── wot-relay (Server)

send() → connected? → inner.send() mit Timeout
                    → Fehler/Timeout → outbox.enqueue()
       → disconnected? → outbox.enqueue() + synthetic receipt
       → reconnect → flushOutbox() (FIFO)
```

Der `OutboxMessagingAdapter` stellt sicher, dass kritische Nachrichten (Attestationen, Verifikationen) nie verloren gehen. Konfigurierbare `skipTypes` (z.B. `profile-update`) überspringen die Outbox für Fire-and-Forget-Nachrichten.

#### ReplicationAdapter

Verantwortlich für:
- Multi-Device Sync (Personal Space)
- Multi-User Sync (Shared Spaces: Kanban, Kalender, Karte)
- Membership Management (wer ist in welchem Space?)

**Implementierungen:**

- `AutomergeReplicationAdapter` (POC) — Automerge CRDT + EncryptedSyncService + GroupKeyService + MessagingAdapter
- Evolu (Personal Space, Multi-Device — geplant)
- Matrix-backed (Produktion, geplant)

#### AuthorizationAdapter

Verantwortlich für:
- UCAN-ähnliche Capabilities (signiert, delegierbar)
- Read/Write/Delete/Delegate Granularität
- Proof Chains (offline-verifizierbar)

**Geplante Implementierungen:**
- NoOp (POC: Creator = Admin)
- Custom UCAN-like (Produktion)

> Vollständige Interface-Spezifikationen: [Adapter-Architektur v2](../protocols/adapter-architektur-v2.md)

## Referenz: wot-core

Die TypeScript-Definitionen aller Typen und Interfaces befinden sich im `packages/wot-core` Package:

```
packages/wot-core/src/
├── types/
│   ├── identity.ts        # Identity, Profile, PublicProfile, KeyPair
│   ├── contact.ts         # Contact, ContactStatus
│   ├── verification.ts    # Verification, GeoLocation
│   ├── attestation.ts     # Attestation, AttestationMetadata
│   ├── proof.ts           # Proof (W3C Data Integrity)
│   ├── messaging.ts       # MessageEnvelope, DeliveryReceipt, MessagingState
│   ├── resource-ref.ts    # ResourceRef branded type (wot:<type>:<id>)
│   └── space.ts           # SpaceInfo, SpaceMemberChange, ReplicationState
├── adapters/
│   ├── interfaces/
│   │   ├── StorageAdapter.ts
│   │   ├── ReactiveStorageAdapter.ts    # + watchIdentity()
│   │   ├── Subscribable.ts
│   │   ├── CryptoAdapter.ts            # + Symmetric + EncryptedPayload
│   │   ├── MessagingAdapter.ts         # Cross-User Messaging
│   │   ├── DiscoveryAdapter.ts         # Public Profile Discovery
│   │   ├── DiscoverySyncStore.ts       # Offline-Cache Interface
│   │   ├── OutboxStore.ts             # Messaging Outbox Interface
│   │   └── ReplicationAdapter.ts       # CRDT Spaces + SpaceHandle<T>
│   ├── crypto/
│   │   └── WebCryptoAdapter.ts         # Ed25519 + X25519 + AES-256-GCM
│   ├── messaging/
│   │   ├── InMemoryMessagingAdapter.ts  # Shared-Bus für Tests
│   │   ├── InMemoryOutboxStore.ts       # In-Memory Outbox für Tests
│   │   ├── OutboxMessagingAdapter.ts    # Offline-Queue Decorator
│   │   └── WebSocketMessagingAdapter.ts # Browser WebSocket Client + Heartbeat
│   ├── discovery/
│   │   ├── HttpDiscoveryAdapter.ts     # HTTP-based (wot-profiles)
│   │   ├── OfflineFirstDiscoveryAdapter.ts  # Offline-Cache Wrapper
│   │   └── InMemoryDiscoverySyncStore.ts    # In-Memory Cache für Tests
│   ├── replication/
│   │   └── AutomergeReplicationAdapter.ts   # Automerge + E2EE + GroupKeys
│   └── storage/
│       └── LocalStorageAdapter.ts
├── services/
│   ├── ProfileService.ts             # signProfile, verifyProfile (JWS)
│   ├── EncryptedSyncService.ts       # Encrypt/Decrypt CRDT Changes
│   └── GroupKeyService.ts            # Group Key Management (Generations)
├── crypto/
│   ├── did.ts             # did:key Implementierung
│   ├── jws.ts             # JSON Web Signature
│   └── encoding.ts        # Base58, Base64Url
├── identity/
│   ├── WotIdentity.ts     # Ed25519 + X25519 + JWS + HKDF
│   └── SeedStorage.ts     # Encrypted Seed in IndexedDB
├── contact/
│   └── ContactStorage.ts  # Contact CRUD in IndexedDB
├── verification/
│   └── VerificationHelper.ts  # Challenge-Response-Protokoll
└── wordlists/
    └── german-positive.ts # 2048 deutsche BIP39-Wörter
```

## Framework-Evaluation

Für eine detaillierte Analyse aller evaluierten CRDT/E2EE/Messaging Frameworks siehe:
→ [Framework-Evaluation v2](../protocols/framework-evaluation.md)

## Weiterführend

- [Adapter-Architektur v2](../protocols/adapter-architektur-v2.md) - 7-Adapter-Spezifikation
- [Entitäten](entitaeten.md) - Datenmodell im Detail
- [Sync-Protokoll](../protocols/sync-protokoll.md) - Wie Daten synchronisiert werden
- [Verschlüsselung](../protocols/verschluesselung.md) - E2E-Verschlüsselung
