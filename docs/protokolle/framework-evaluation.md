# Framework-Evaluation

> Analyse von Local-First, CRDT, P2P und Messaging Frameworks für das Web of Trust
>
> **Version 2** — Aktualisiert 2026-02-08 nach Erkenntnis, dass ein einzelnes Framework nicht ausreicht.

## Motivation

Das Web of Trust benötigt:
- **Offline-First**: Alle Operationen funktionieren ohne Verbindung
- **E2E-Verschlüsselung**: Server sieht nur verschlüsselte Daten
- **CRDTs**: Automatische, deterministische Konfliktauflösung
- **DID-Kompatibilität**: Interoperabilität mit W3C Standards (did:key, Ed25519)
- **Cross-User Messaging**: Attestations, Verifications und Items zwischen DIDs zustellen
- **Gruppen-Collaboration**: Gemeinsame Spaces (Kanban, Kalender, Karte) mit E2EE
- **Selektive Sichtbarkeit**: Items gezielt mit N von M Kontakten teilen (Item-Key-Modell)
- **Capability-basierte Autorisierung**: UCAN-ähnliche delegierbare Berechtigungen
- **React Native**: Mobile-First Entwicklung

### Zentrale Erkenntnis (v2)

> **Ein einzelnes Framework kann unsere Anforderungen nicht erfüllen.**
>
> Während der Evolu-Integration wurde offensichtlich: Evolu synchronisiert nur innerhalb
> desselben Owners (Single-User, Multi-Device). Es gibt kein Konzept für Cross-User-Messaging.
> SharedOwner-API existiert, ist aber nicht funktional (Stand Feb 2026, Discussion #558).
>
> **Die Lösung: Zwei orthogonale Achsen:**
>
> | Achse | Funktion | Beispiel-Implementierung |
> |-------|----------|-------------------------|
> | **CRDT/Sync** | Zustandskonvergenz, Multi-Device/Multi-User | Automerge, Evolu, Yjs |
> | **Messaging** | Zustellung zwischen DIDs, Delivery Receipts | Matrix, Nostr, WebSocket |
>
> Eine Nachricht enthält NICHT den Zustand, sondern nur den Trigger/Pointer.
> Der Zustand lebt im CRDT und konvergiert unabhängig.

Diese Evaluation untersucht Kandidaten für beide Achsen und definiert eine 6-Adapter-Architektur.

---

## Evaluierte Frameworks

### Übersicht

#### CRDT/Sync-Achse (Zustandskonvergenz)

| Framework | E2EE | CRDT | Cross-User | React/Web | Reife |
|-----------|------|------|------------|-----------|-------|
| [Evolu](#evolu) | ✅ Native | SQLite + LWW | ❌ Single-Owner | ✅ Erstklassig | Produktiv |
| [NextGraph](#nextgraph) | ✅ Native | Yjs + Automerge + Graph | ✅ Overlays | ⚠️ SDK kommt | Alpha |
| [Jazz](#jazz) | ✅ Native | CoJSON | ✅ Groups | ✅ Dokumentiert | Beta |
| [DXOS](#dxos) | ✅ Native | Automerge | ✅ Spaces | ❌ Web only | Produktiv |
| [p2panda](#p2panda) | ✅ Double Ratchet | Beliebig (BYOC) | ✅ Groups | ❌ Kein JS SDK | Pre-1.0 |
| [Automerge](#automerge) | ❌ Selbst | ✅ Eigenes | ❌ Selbst bauen | ⚠️ WASM | Produktiv |
| [Yjs](#yjs) | ❌ Selbst | ✅ Eigenes | ❌ Selbst bauen | ✅ | Produktiv |
| [Loro](#loro) | ❌ Selbst | ✅ Eigenes | ❌ Selbst bauen | ✅ WASM+Swift | Produktiv |

#### Messaging-Achse (Cross-User Delivery)

| Framework | E2EE | DID | Offline-Queue | Gruppen | Reife |
|-----------|------|-----|---------------|---------|-------|
| [Nostr](#nostr) | ⚠️ NIP-44 | ❌ secp256k1 | ✅ Relays | ⚠️ Channels | Produktiv |
| [Matrix](#matrix) | ✅ Megolm/Vodozemac | ❌ | ✅ Homeserver | ✅ Rooms | Produktiv |
| [DIDComm](#didcomm) | ✅ Native | ✅ did:key | ❌ Mediator nötig | ❌ | Spec fertig, Libs stale |
| [ActivityPub](#activitypub) | ❌ | ❌ | ✅ Inbox | ⚠️ | Produktiv |
| [Iroh](#iroh) | ✅ QUIC | ❌ | ❌ Direkt | ❌ | Beta |

#### Sonstige (nicht kategorisierbar)

| Framework | Rolle | Reife |
|-----------|-------|-------|
| [Willow/Earthstar](#willow--earthstar) | Protokoll + Capabilities (Meadowcap) | Beta/Stagnierend |
| [Secsync](#secsync) | Architektur-Referenz für E2EE CRDTs | Beta |
| [Keyhive](#keyhive) | Gruppen-Key-Management (BeeKEM) | Pre-Alpha |
| [Subduction](#subduction) | Verschlüsselter P2P-Sync (Sedimentree) | Pre-Alpha |

### Kategorisierung (aktualisiert v2)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              Local-First + E2EE + Messaging Landscape                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ACHSE 1: CRDT/SYNC (Zustandskonvergenz)                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Evolu         │ SQLite, LWW, React, Custom Keys, Single-Owner      │   │
│  │ Automerge     │ JSON-like, Ink & Switch, WASM                      │   │
│  │ Yjs           │ Größte Community, viele Bindings                    │   │
│  │ Loro          │ High-Performance, Rust + WASM + Swift               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ACHSE 2: MESSAGING (Cross-User Delivery)                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Matrix        │ E2EE Rooms, Homeserver, Federation, Bridges        │   │
│  │ Nostr         │ Relays, Pubkeys, NIPs, großes Ökosystem            │   │
│  │ DIDComm       │ DID-native, Spec fertig, JS-Libs veraltet          │   │
│  │ Custom WS     │ Minimaler WebSocket-Relay für POC                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  FULL-STACK (beide Achsen, aber Einschränkungen):                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ NextGraph     │ DID, RDF, 3 CRDTs, Broker — aber Alpha             │   │
│  │ Jazz          │ CoJSON, Groups — aber proprietär                    │   │
│  │ DXOS          │ Spaces, HALO — aber P-256 Keys, Web-only           │   │
│  │ p2panda       │ Echtes P2P, Double Ratchet — aber kein JS SDK      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  BAUSTEINE (ergänzend):                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Willow        │ Meadowcap Capabilities, Earthstar TS               │   │
│  │ Keyhive       │ BeeKEM Gruppen-Keys                                │   │
│  │ Secsync       │ E2EE CRDT Architektur-Referenz                     │   │
│  │ Iroh          │ QUIC Networking Layer (n0-computer)                 │   │
│  │ Subduction    │ Encrypted P2P Sync (Sedimentree), Ink & Switch      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Detailanalysen

### NextGraph

> Decentralized, encrypted and local-first platform

**Website:** https://nextgraph.org/
**Gitea:** https://git.nextgraph.org/NextGraph/nextgraph-rs
**GitHub Mirror:** https://github.com/nextgraph-org/nextgraph-rs (~73 ⭐)
**Status:** Alpha (v0.1.2-alpha.1)
**Maintainer:** ~3 (Niko Bonnieure primary)
**Funding:** EU NLnet/NGI Grants + Donations

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Identität** | `did:ng` für User und Dokumente, Multiple Personas pro Wallet |
| **E2EE** | Ja, capability-basiert (nicht Signal/Matrix) |
| **CRDTs** | 3 Modelle: Graph CRDT (RDF, custom) + Automerge + Yjs |
| **Datenmodell** | RDF Triples + SPARQL, JSON, Rich Text, Markdown |
| **Gruppen** | Cryptographic Capabilities (Editor/Reader/Signer Rollen) |
| **Sync** | 2-Tier Broker Network, P2P Pub/Sub, DAG von Commits |
| **Transport** | WebSocket + Noise Protocol (kein TLS/DNS nötig) |
| **Sprachen** | Rust (76%), TypeScript (14%), Svelte (6%) |
| **SDKs** | Rust (crates.io), JS/TS (WASM, noch Alpha), Node.js, Deno geplant |
| **Plattformen** | Linux, macOS, Windows, Android, iOS (TestFlight), Web |
| **Storage** | RocksDB (encrypted at rest) |

#### Architektur

```
┌─────────────────────────────────────────────────────┐
│                    NextGraph                         │
│                                                      │
│  Tier 1: Core Brokers (Server, 24/7, relay)         │
│     ↕ WebSocket + Noise Protocol                    │
│  Tier 2: Edge/Local Brokers (Client-side daemon)    │
│     ↕                                                │
│  Documents: DAG von Commits                          │
│     ├── Graph Part (RDF, mandatory)                  │
│     ├── Discrete Part (Yjs/Automerge, optional)      │
│     └── Binary Files (optional)                      │
│                                                      │
│  Overlays pro Repo:                                  │
│     ├── Inner Overlay (Write-Access, Peers kennen    │
│     │   einander)                                    │
│     └── Outer Overlay (Read-Only, anonymer)          │
└─────────────────────────────────────────────────────┘
```

#### Einzigartige Features

- **3 CRDTs vereint:** Graph CRDT (RDF) + Automerge + Yjs auf Branch-Ebene mischbar
- **SPARQL auf verschlüsselten Local-First Daten** - einzigartig
- **Social Queries:** Federated SPARQL über verschlüsselte P2P-Daten anderer User
- **Pazzle-Auth:** 9 Bilder als Passwort-Alternative (mental narrative)
- **Smart Contracts ohne Blockchain:** FSM + WASM Verifier
- **Nuri (NextGraph URI):** Permanente kryptografische Dokument-IDs mit eingebetteten Capabilities
- **ShEx → TypeScript:** RDF-Schemas werden zu getypten TS-Objekten mit Proxy-Reactivity

#### Bewertung für Web of Trust (aktualisiert 2026-02-07)

```
Vorteile:
✅ DID-Support eingebaut (einziges Framework mit did:ng!)
✅ RDF-Graph = natürliches Modell für Vertrauensnetzwerk
✅ Capability-basierte Crypto = passt zu WoT Permissions
✅ E2EE + Encryption at Rest mandatory
✅ Kein DNS, kein TLS, kein Single Point of Failure
✅ SPARQL ermöglicht mächtige Graph-Queries über Trust-Beziehungen
✅ Consumer App + Developer Framework (Social Network eingebaut)

Nachteile:
❌ Alpha - NICHT produktionsreif (v0.1.2-alpha)
❌ JS/React SDK noch nicht released (kommt Anfang 2026)
❌ Kein Custom Key Import - Wallet generiert eigene Keys
   → Integration mit bestehendem BIP39 Seed problematisch
❌ Sehr kleine Community (~73 Stars, ~3 Contributors)
❌ Grant-abhängige Finanzierung (Nachhaltigkeit?)
⚠️ Extrem komplex (3 CRDTs, RDF, SPARQL, Noise Protocol, Broker Network)
⚠️ Rust-basiert → WASM für Web, Integration aufwendiger
⚠️ Single-Point-of-Knowledge Risiko (Niko Bonnieure)
```

**Empfehlung:** Philosophisch am nächsten an unserer Vision. Beobachten und evaluieren sobald JS SDK verfügbar. Für POC nicht geeignet wegen fehlender Custom-Key-Integration und Alpha-Status. Langfristig der interessanteste Kandidat.

---

### Evolu

> Local-first platform with E2EE and SQLite

**Website:** <https://evolu.dev/>
**GitHub:** <https://github.com/evoluhq/evolu> (~1.8k ⭐)
**Status:** Produktiv (v7/v8, Major Rewrite laufend)
**Maintainer:** 1 primary (Daniel Steigerwald), wenige weitere
**Lizenz:** MIT

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Identität** | SLIP-21 Key Derivation aus 16 Bytes Entropy, BIP39 Mnemonic |
| **E2EE** | Ja, symmetric (quantum-safe) + PADME Padding |
| **CRDTs** | LWW (Last-Write-Wins) per Cell (Table/Row/Column) |
| **Datenmodell** | SQLite mit Branded TypeScript-Typen (Kysely Query Builder) |
| **Sync** | Range-Based Set Reconciliation, Hybrid Logical Clocks, binäres Protokoll |
| **Transport** | WebSocket zu Relay-Server (self-hostable) |
| **Sprachen** | TypeScript |
| **Plattformen** | Web (OPFS), React Native, Expo, Electron, Svelte, Vue |
| **Custom Keys** | ✅ Ja! `ownerId`, `writeKey`, `encryptionKey` direkt übergeben (seit Nov 2025, Issue #537) |

#### Architektur

```
Browser/App (SQLite lokal, OPFS)
    ↕ WebSocket (E2E encrypted, binary)
Relay Server (stateless, sieht nur encrypted blobs)
    ↕ WebSocket
Anderes Gerät (SQLite lokal)

Relay kann NICHT:
- Daten lesen (E2E encrypted)
- Muster erkennen (PADME Padding)
- User korrelieren

Relay ist:
- Self-hostable (Docker, Render, AWS Lambda)
- Free Relay verfügbar: free.evoluhq.com
- Empfohlen: 2 Relays (lokal + geo-distant backup)
```

#### Owner-Modelle

- **AppOwner** - Single-User (Standard, unser Usecase)
- **SharedOwner** - Collaborative Multi-User
- **SharedReadonlyOwner** - Nur-Lesen Collaboration
- **ShardOwner** - Logische Datenpartitionierung (Partial Sync)

#### Custom Key Integration (kritisch für uns!)

```typescript
// Evolu mit WotIdentity-Keys initialisieren:
const evolKey = await identity.deriveFrameworkKey('evolu-storage-v1')

const evolu = createEvolu(evoluReactWebDeps)(Schema, {
  ownerId: identity.getDid(),
  writeKey: deriveWriteKey(evolKey),
  encryptionKey: deriveEncryptionKey(evolKey),
  transports: [{ type: "WebSocket", url: "wss://our-relay.example.com" }],
})
```

Dieses Feature wurde vom Trezor-Team angefragt und in Issue #537 implementiert.

#### Bewertung für Web of Trust (aktualisiert 2026-02-07)

```
Vorteile:
✅ Custom Keys! → direkte Integration mit WotIdentity.deriveFrameworkKey()
✅ BIP39 Mnemonic als Basis (gleiche Philosophie wie wir)
✅ React/Svelte/Vue erstklassig unterstützt
✅ React Native + Expo voll unterstützt
✅ SQLite = vertraute Queries mit Kysely (type-safe)
✅ E2EE mandatory, Relay blind
✅ Produktionsnah, aktive Entwicklung
✅ Self-hostable Relay (Docker, ein Klick auf Render)
✅ Partial Sync (temporal + logical) für Skalierung
✅ PADME Padding gegen Traffic-Analyse

Nachteile:
⚠️ Single-Maintainer Risiko (steida = 99% der Commits)
⚠️ Major Rewrite laufend (Effect entfernt, neuer Sync)
⚠️ Kein DID-Support (muss selbst gebaut werden → haben wir schon)
⚠️ LWW-CRDT ist simpel (kein Rich-Text-Merging wie Yjs)
⚠️ Relay nötig für Sync (kein echtes P2P, aber auf Roadmap)
⚠️ SQL-Paradigma vs. Graph-Datenmodell
```

**Empfehlung:** Primärer Kandidat für POC. Pragmatisch, stabil, Custom-Key-Support ist der Gamechanger. DID-Layer haben wir bereits (WotIdentity).

---

### Jazz

> Primitives for building local-first apps

**Website:** https://jazz.tools/
**GitHub:** https://github.com/garden-co/jazz
**Status:** Beta

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Identität** | Account Keys (Passphrase-basiert) |
| **E2EE** | Ja, mit Signatures |
| **CRDTs** | CoJSON (eigenes Format) |
| **Datenmodell** | Collaborative JSON ("CoValues") |
| **Gruppen** | Eingebaut mit Permissions |
| **Sprachen** | TypeScript |
| **Plattformen** | Web, React Native (dokumentiert) |

#### Bewertung für Web of Trust

```
Vorteile:
✅ Elegantes API ("feels like reactive local JSON")
✅ Gruppen mit Permissions eingebaut
✅ React Native dokumentiert
✅ Passphrase Recovery (ähnlich Mnemonic)
✅ Aktive Entwicklung

Nachteile:
⚠️ Kein DID-Support
⚠️ Noch Beta
⚠️ CoJSON ist proprietär
⚠️ Weniger Kontrolle über Crypto
```

**Empfehlung:** Alternative zu Evolu. Eleganter, aber weniger ausgereift.

---

### Secsync

> Architecture for E2E encrypted CRDTs

**Website:** https://secsync.com/
**GitHub:** https://github.com/nikgraf/secsync (225 ⭐)
**Status:** Beta

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Identität** | Ed25519 Keys (extern verwaltet) |
| **E2EE** | XChaCha20-Poly1305-IETF |
| **CRDTs** | Agnostisch (Yjs, Automerge Beispiele) |
| **Konzept** | Snapshots + Updates + Ephemeral Messages |
| **Key Exchange** | Extern (Signal Protocol oder PKI) |
| **Sprachen** | TypeScript |

#### Bewertung für Web of Trust

```
Vorteile:
✅ Framework-agnostisch (Yjs oder Automerge)
✅ Saubere E2EE-Architektur dokumentiert
✅ Server sieht nur verschlüsselte Blobs
✅ Snapshot + Update Modell effizient

Nachteile:
⚠️ Key Exchange muss selbst gebaut werden
⚠️ React Native Support unklar
⚠️ Noch Beta
⚠️ Kleinere Community
```

**Empfehlung:** Gute Referenz-Architektur. Konzepte übernehmen, wenn wir selbst bauen.

---

### p2panda

> Modular toolkit for local-first P2P applications

**Website:** <https://p2panda.org/>
**GitHub:** <https://github.com/p2panda/p2panda> (~394 ⭐)
**Status:** Pre-1.0 (v0.5.0, Jan 2026) - aktive Entwicklung
**Maintainer:** 4 (adzialocha, sandreae, mycognosist, cafca)
**Funding:** EU NLnet/NGI Grants (POINTER, ASSURE, ENTRUST, Commons Fund)
**Lizenz:** Apache 2.0 / MIT

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Identität** | Ed25519 pro Device, KeyGroups für Multi-Device |
| **E2EE** | Data: XChaCha20-Poly1305 + PCS. Messages: Double Ratchet (Signal-like) |
| **CRDTs** | BYOC - Bring Your Own (Automerge, Yjs, Loro, custom) |
| **Datenmodell** | Append-Only Logs (Namakemono Spec), data-type-agnostic |
| **Sync** | Bidirectional Push + PlumTree/HyParView Gossip |
| **Transport** | QUIC (iroh), mDNS, Bootstrap Nodes |
| **Sprachen** | Rust (9 modulare Crates) |
| **Plattformen** | Desktop (GTK/Tauri), Mobile (Flutter FFI), IoT |
| **JS SDK** | Veraltet! `p2panda-js` v0.8.1 (~2 Jahre alt, pre-rewrite) |

#### Modulare Crates

| Crate | Funktion |
|-------|----------|
| **p2panda-core** | Erweiterbare Datentypen (Operations, Headers, Bodies) |
| **p2panda-net** | P2P Networking, Discovery, Gossip |
| **p2panda-discovery** | Confidential Peer/Topic Discovery |
| **p2panda-sync** | Append-Only Log Synchronization |
| **p2panda-blobs** | Large File Transfer |
| **p2panda-store** | SQLite, Memory, Filesystem Persistence |
| **p2panda-stream** | Stream Processing Middleware |
| **p2panda-encryption** | Group Encryption (2 Schemes) |
| **p2panda-auth** | Decentralized Access Control |

#### Verschlüsselung (2 Schemes)

**Data Encryption** (für persistente Gruppendaten):
- Symmetric Key für alle Gruppenmitglieder
- Post-Compromise Security (Key Rotation bei Member-Removal)
- XChaCha20-Poly1305

**Message Encryption** (für ephemere Nachrichten):
- Double Ratchet Algorithm (wie Signal)
- Jede Nachricht bekommt eigenen Key → starke Forward Secrecy
- AES-256-GCM

#### Real-World Apps

- **Reflection** - Collaborative local-first GTK Text Editor (224 ⭐)
- **Meli** - Android App für Bienenarten-Kategorisierung (Brasilien, Flutter)
- **Toolkitty** - Koordinations-App für Kollektive

#### Bewertung für Web of Trust (aktualisiert 2026-02-07)

```
Vorteile:
✅ Echtes P2P (kein Server/Relay nötig!)
✅ Funktioniert über LoRa, Bluetooth, Shortwave, USB-Stick (!!)
✅ Modularer Ansatz (pick what you need)
✅ Double Ratchet = Signal-Level Forward Secrecy
✅ Post-Compromise Security bei Gruppen
✅ Confidential Discovery (Peers finden sich ohne Interessen preiszugeben)
✅ EU-gefördert (NLnet), Security Audit geplant
✅ 4 aktive Contributors (besser als Single-Maintainer)
✅ Ed25519 Keys (wie wir), Custom Keys möglich

Nachteile:
❌ KEIN aktuelles JavaScript/Web SDK (Knockout für React-basierte App!)
❌ Pre-1.0 - nicht produktionsreif
⚠️ Rust-basiert → WASM oder FFI für Web nötig
⚠️ Kein DID-Support
⚠️ Kein BIP39/Mnemonic Support eingebaut
⚠️ Wiederholte Architectural Rewrites (Bamboo→Namakemono, aquadoggo→modular)
⚠️ Dokumentation verstreut (Blog Posts, altes Handbook, Rust Docs)
```

**Empfehlung:** Philosophisch sehr nahe (echtes P2P, Offline-First radikal). Für Web-App aktuell nicht nutzbar wegen fehlendem JS SDK. Beobachten für: (1) Langfrist-Vision mit LoRa/BLE für Offline-Gemeinschaften, (2) Einzelne Crates (p2panda-encryption, p2panda-auth) als Inspiration. FOSDEM 2026 Talk zeigt wachsendes GNOME/Linux-Desktop-Interest.

---

### DXOS

> Decentralized developer platform

**Website:** https://dxos.org/
**GitHub:** https://github.com/dxos/dxos (483 ⭐)
**Status:** Produktiv

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Identität** | HALO Protocol (ECDSA P-256 Keyring!) |
| **E2EE** | Ja, über ECHO Protocol |
| **CRDTs** | Yjs / Automerge via Adapter |
| **Datenmodell** | Graph-basiert (Spaces, Objects) |
| **Sync** | P2P via WebRTC |
| **Sprachen** | TypeScript |
| **Keys** | ECDSA P-256 (Web Crypto Standard) — NICHT Ed25519 |

#### Bewertung für Web of Trust (aktualisiert 2026-02-08)

```
Vorteile:
✅ Graph-Modell passt zu Web of Trust
✅ Spaces-Konzept ähnlich unseren Gruppen
✅ Produktionsreif
✅ Gute TypeScript-Typen
✅ Composer = vollständige App als Referenz

Nachteile:
❌ ECDSA P-256 Keyring — inkompatibel mit unserem Ed25519/did:key!
❌ Kein React Native Support (Web-only)
❌ Custom DID Format (DXOS-spezifisch, nicht W3C-kompatibel)
⚠️ Kein BIP39/Mnemonic-Support
⚠️ Komplexes eigenes Protokoll (HALO + ECHO)
⚠️ Großes Bundle (~2MB)
```

**Empfehlung:** ❌ Eliminiert. P-256 vs. Ed25519 ist ein fundamentaler Krypto-Mismatch. Kein React Native. Konzepte (Spaces, HALO) interessant als Inspiration.

---

### Keyhive

> Decentralized group key management

**Website:** https://www.inkandswitch.com/keyhive/
**GitHub:** https://github.com/inkandswitch/keyhive (177 ⭐)
**Status:** Pre-Alpha (Forschung)

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Fokus** | Gruppenkey-Management für Local-First |
| **Protokoll** | BeeKEM (basiert auf TreeKEM) |
| **Features** | Forward Secrecy, Post-Compromise Security |
| **Skalierung** | Logarithmisch (tausende Members) |
| **Sprachen** | Rust + WASM |

#### Bewertung für Web of Trust

```
Vorteile:
✅ Löst genau das Gruppenkey-Problem
✅ Von Ink & Switch (Automerge-Macher)
✅ Capability-basiertes Access Control
✅ Designed für CRDTs

Nachteile:
❌ Pre-Alpha, nicht auditiert
❌ Kein React Native
⚠️ Nur Key Management, kein vollständiges Framework
⚠️ API noch instabil
```

**Empfehlung:** Beobachten für Gruppen-Verschlüsselung. Könnte Evolu/Jazz ergänzen wenn stabil.

---

### Loro

> High-performance CRDT library

**Website:** https://loro.dev/
**GitHub:** https://github.com/loro-dev/loro
**Status:** Produktiv

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Fokus** | Performance-optimierte CRDTs |
| **Datentypen** | Map, List, Text, MovableTree |
| **Features** | Time Travel, Undo/Redo |
| **Sprachen** | Rust, WASM, Swift |
| **E2EE** | Nicht eingebaut |

#### Bewertung für Web of Trust

```
Vorteile:
✅ Beste Performance (Memory, CPU, Loading)
✅ MovableTree für hierarchische Daten
✅ Swift-Bindings für iOS
✅ Aktive Entwicklung

Nachteile:
❌ Kein E2EE (selbst bauen)
❌ Kein DID
⚠️ Nur CRDT-Engine, kein Sync
```

**Empfehlung:** Wenn wir CRDT-Engine selbst wählen, ist Loro der Performance-Champion.

---

### Yjs & Automerge

Klassische CRDT-Libraries, gut dokumentiert. Keine E2EE, kein DID.

| Aspekt | Yjs | Automerge |
|--------|-----|-----------|
| **Performance** | Sehr schnell | Gut |
| **Bundle Size** | ~50KB | ~200KB (WASM) |
| **Community** | Sehr groß | Groß |
| **Bindings** | Viele (Prosemirror, Monaco) | Weniger |
| **React Native** | Ja | WASM nötig |

**Empfehlung:** Gute Basis wenn wir E2EE selbst bauen wollen. Automerge wird in der externen Analyse als pragmatische Wahl für CRDT-Achse empfohlen.

---

### Nostr

> Notes and Other Stuff Transmitted by Relays

**Website:** https://nostr.com/
**GitHub:** https://github.com/nostr-protocol/nips (~2.8k ⭐)
**Status:** Produktiv (großes Ökosystem)
**Evaluiert:** 2026-02-08

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Identität** | secp256k1 Keypairs (wie Bitcoin), npub/nsec Encoding |
| **E2EE** | NIP-44: XChaCha20 + HMAC-SHA256 (DM-Verschlüsselung) |
| **Datenmodell** | Events (JSON): kind, content, tags, sig |
| **Relay** | Dumb relays speichern Events, Client hat die Logik |
| **Transport** | WebSocket zu Relays (kein P2P) |
| **Sprachen** | JS/TS (nostr-tools), Rust, Go, Python, Swift |
| **Ökosystem** | ~30+ Clients, ~100+ Relays, Zaps (Lightning), Marketplace |

#### Architektur

```
Client A ─── WebSocket ──→ Relay 1 ←── WebSocket ─── Client B
                           Relay 2
                           Relay 3

Events sind:
- Signiert (secp256k1)
- Öffentlich oder NIP-44 verschlüsselt (DMs)
- Gefiltert via Subscriptions (REQ/EVENT/CLOSE)
- Broadcast (nicht targeted delivery)
```

#### Bewertung für Web of Trust (2026-02-08)

```
Vorteile:
✅ Großes, aktives Ökosystem (Clients, Relays, Tools)
✅ Einfaches Protokoll (JSON Events + WebSocket)
✅ Self-hostable Relays (strfry, nostream)
✅ Offline-Queue via Relays (Events werden gespeichert)
✅ NIP-44 Verschlüsselung für DMs
✅ Community-getrieben, kein Single Point of Failure

Nachteile:
❌ secp256k1 — NICHT Ed25519! Fundamentaler Krypto-Mismatch
❌ Kein Item-Key-Konzept (pro-Empfänger Verschlüsselung fehlt)
❌ Empfänger-Prinzip nicht abbildbar (Events gehören dem Sender)
❌ Broadcast-Modell vs. selektive Sichtbarkeit (N von M)
❌ Kein DID-Support (eigenes npub-Format)
⚠️ Kein CRDT-Support (Events sind append-only, kein Merging)
⚠️ Gruppen (NIP-29) sind einfache Channels, kein cryptographic group key
⚠️ Relay-Trust problematisch (Relay kann Events zensieren/löschen)
```

**Empfehlung:** ❌ Eliminiert für WoT-Core. secp256k1 vs. Ed25519 ist unüberbrückbar ohne Key-Translation-Layer. Das Broadcast-Modell widerspricht unserem Empfänger-Prinzip fundamental. Nostr-Bridge als optionaler Export denkbar, aber nicht als Messaging-Backend.

---

### Matrix

> Open standard for decentralised, real-time communication

**Website:** https://matrix.org/
**Spec:** https://spec.matrix.org/
**Status:** Produktiv (Element, Beeper, Bundeswehr)
**Evaluiert:** 2026-02-08

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Identität** | @user:homeserver.org (föderiert) |
| **E2EE** | Megolm (Gruppen) + Olm/Vodozemac (1:1), Curve25519 + Ed25519 |
| **Datenmodell** | Rooms mit DAG von Events |
| **Sync** | Federation zwischen Homeservern |
| **Transport** | HTTPS + optional WebSocket |
| **Sprachen** | JS (matrix-js-sdk), Rust (matrix-rust-sdk/vodozemac) |
| **Plattformen** | Web, iOS, Android, Desktop |
| **Keys** | Curve25519 + Ed25519 (kompatibel!) |

#### Architektur

```
Client A ──→ Homeserver A ←──Federation──→ Homeserver B ←── Client B
                  │                              │
                  └──── Room (DAG of Events) ────┘

E2EE:
- Olm: 1:1 Double Ratchet (Signal-like)
- Megolm: Gruppen-Verschlüsselung (effizient für N Empfänger)
- Vodozemac: Rust-Implementierung von Olm/Megolm
- Key Verification: Emoji/QR-Code Cross-Signing
```

#### Bewertung für Web of Trust (2026-02-08)

```
Vorteile:
✅ Ed25519 + Curve25519 — kompatibel mit unserem Krypto-Stack!
✅ Bewährte E2EE (Megolm für Gruppen, auditiert)
✅ Rooms = natürliches Modell für Gruppen/Spaces
✅ Federation = kein Single Point of Failure
✅ Offline-Queue via Homeserver (Nachrichten warten auf Empfänger)
✅ Bridges zu anderen Protokollen (IRC, Slack, Signal, XMPP)
✅ Riesiges Ökosystem (Element, Beeper, 100M+ User)
✅ Self-hostable (Synapse, Conduit, Dendrite)
✅ matrix-rust-sdk + vodozemac = performant und auditiert

Nachteile:
⚠️ Homeserver nötig (kein echtes P2P, aber self-hostable)
⚠️ Kein DID-Support nativ (Matrix-IDs sind @user:server)
⚠️ Matrix-IDs sind server-gebunden (Migration aufwändig)
⚠️ Overhead für einfache Nachrichten (Room-Erstellung, Sync)
⚠️ Föderationsprotokoll komplex (Server-zu-Server)
⚠️ matrix-js-sdk ist groß (~500KB+)
```

**Empfehlung:** Stärkster Kandidat für Messaging-Achse. Ed25519-Kompatibilität, bewährte Gruppen-E2EE (Megolm), und Offline-Queue via Homeserver. Für POC möglicherweise Overkill — minimaler WebSocket-Relay als Vorstufe, mit Matrix als Ziel für Produktion. Empfohlen in externer Analyse als pragmatische Wahl.

---

### DIDComm

> DID-based secure messaging

**Spec:** https://identity.foundation/didcomm-messaging/spec/v2.1/
**Status:** Spec v2.1 fertig (DIF), JS-Libs veraltet
**Evaluiert:** 2026-02-08

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Identität** | did:key, did:web, did:peer (DID-native!) |
| **E2EE** | JWE (JSON Web Encryption), ECDH-ES+A256KW |
| **Datenmodell** | Structured Messages mit Protocols |
| **Transport** | Agnostisch (HTTP, WebSocket, Bluetooth, QR-Code) |
| **Mediator** | Optional: Message-Relay für Offline-Delivery |
| **Sprachen** | Rust (didcomm-rs), JS (didcomm-node), Kotlin, Swift |
| **JS SDK** | `didcomm` npm — letzte Updates 2023, TypeScript aber stale |

#### Bewertung für Web of Trust (2026-02-08)

```
Vorteile:
✅ DID-native! Genau unser Identity-Modell (did:key + Ed25519)
✅ Transport-agnostisch (HTTP, WS, BLE, QR — passt zu unserem Offline-Vision)
✅ Spec ist ausgereift (v2.1, DIF-Standard)
✅ Structured Protocols (Trust Ping, Issue Credential, Present Proof)
✅ Perfect fit für Verification/Attestation Delivery

Nachteile:
❌ JS-Libraries sind stale (npm didcomm: 2023, wenige Downloads)
❌ Mediator-Infrastruktur kaum vorhanden (müssten wir selbst bauen)
❌ Keine Gruppen-Konzepte in der Spec
❌ Kein Ökosystem für "einfache" Messaging-Use-Cases
⚠️ JWE-Overhead für simple Nachrichten
⚠️ DID-Resolver-Dependency (did:peer ist komplex)
```

**Empfehlung:** ❌ Eliminiert als Messaging-Backend wegen staler JS-Libs und fehlendem Mediator-Ökosystem. ABER: DIDComm Message-Format als Inspiration für unser eigenes Messaging-Protokoll — die Structured Protocols (Issue Credential, Present Proof) sind direkt relevant für Attestation-Delivery.

---

### ActivityPub

> W3C Standard for decentralized social networking

**Spec:** https://www.w3.org/TR/activitypub/
**Status:** W3C Recommendation (Mastodon, Pixelfed, Lemmy)
**Evaluiert:** 2026-02-08

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Identität** | @user@server.org (föderiert, WebFinger) |
| **E2EE** | ❌ Nicht eingebaut! |
| **Datenmodell** | ActivityStreams 2.0 (JSON-LD) |
| **Sync** | Server-to-Server Federation (Inbox/Outbox) |
| **Transport** | HTTPS (Server nötig!) |
| **Offline** | ❌ Server-abhängig |
| **Sprachen** | Diverse (Server-Implementierungen) |

#### Bewertung für Web of Trust (2026-02-08)

```
Vorteile:
✅ W3C Standard (stabil, weit verbreitet)
✅ Riesiges Ökosystem (Mastodon, 10M+ User)
✅ Inbox/Outbox Modell ähnlich unserem Empfänger-Prinzip
✅ ActivityStreams 2.0 = gut definiertes Vokabular

Nachteile:
❌ KEINE E2E-Verschlüsselung (Knockout-Kriterium!)
❌ Server-Pflicht (kein Offline-First, kein Local-First)
❌ Kein DID-Support (WebFinger + HTTP-Signaturen)
❌ Kein CRDT (Server-autoritativ)
❌ JSON-LD Overhead (Komplex, schwer zu debuggen)
```

**Empfehlung:** ❌ Eliminiert. Keine E2EE und Server-Pflicht widersprechen unseren Grundprinzipien. ActivityStreams 2.0 Vokabular als Inspiration für unser Datenmodell denkbar, aber nicht als Protokoll.

---

### Iroh

> Build on a more open internet (n0-computer)

**Website:** https://iroh.computer/
**GitHub:** https://github.com/n0-computer/iroh (~2.5k ⭐)
**Status:** Beta (aktive Entwicklung)
**Evaluiert:** 2026-02-08

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Fokus** | Networking Layer (Connections + Data Transfer) |
| **Transport** | QUIC + NAT Traversal (Hole Punching) |
| **Identität** | Ed25519 Node-IDs |
| **E2EE** | ✅ QUIC = mandatory TLS 1.3 |
| **Datenmodell** | Blobs + Hash-verified content (IPFS-inspiriert) |
| **CRDTs** | ❌ Nicht eingebaut |
| **Messaging** | ❌ Nicht eingebaut |
| **Sprachen** | Rust, mit FFI-Bindings (Python, Swift, Kotlin) |
| **JS SDK** | ❌ Kein nativer JS-Support (WASM theoretisch möglich) |

#### Bewertung für Web of Trust (2026-02-08)

```
Vorteile:
✅ Exzellentes NAT Traversal (Hole Punching funktioniert zuverlässig)
✅ Ed25519 Node-IDs (kompatibel)
✅ QUIC = performant und sicher
✅ Content-addressed Blobs (gut für File-Sharing)
✅ Aktive Entwicklung, gute Dokumentation

Nachteile:
❌ NUR Networking Layer — kein App-Framework!
❌ Kein JS/Web SDK
❌ Kein CRDT, kein Messaging, kein Storage
❌ Müssten alles darauf selbst bauen
⚠️ Rust-only (FFI für Mobile möglich, aber kein Web)
```

**Empfehlung:** ❌ Eliminiert als eigenständige Lösung — Iroh ist ein Networking-Layer, kein App-Framework. Könnte als Transport-Schicht unter einem CRDT-Framework dienen (p2panda nutzt Iroh intern), aber für unseren TypeScript-Stack nicht direkt nutzbar.

---

### Willow / Earthstar

> Willow: Data protocol for peer-to-peer data stores
> Earthstar: TypeScript implementation of Willow concepts

**Website:** https://willowprotocol.org/
**Earthstar GitHub:** https://github.com/earthstar-project/earthstar (~640 ⭐)
**Status:** Willow = Spec Beta, Earthstar = TypeScript (stagnierend)
**Evaluiert:** 2026-02-08

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Identität** | Ed25519 Keypairs (Willow Namespaces) |
| **E2EE** | ✅ Meadowcap (Capability-basiert!) |
| **Datenmodell** | 3D Entries: (Namespace, Subspace, Path) + Payload |
| **Sync** | WGPS (Willow General Purpose Sync) — Private Area Intersection |
| **Capabilities** | Meadowcap: Delegierbare, einschränkbare Capabilities (wie UCAN!) |
| **Sprachen** | Willow: Rust (Aljoscha Meyer). Earthstar: TypeScript (gwil) |
| **Plattformen** | Earthstar: Deno + Node + Browser |

#### Meadowcap Capabilities

```
Meadowcap ist das Capability-System von Willow:

- Capabilities = signierte Tokens die Zugriff auf einen 3D-Bereich gewähren
- Delegation: Alice gibt Bob ein eingeschränktes Token weiter
- Restriction: Jede Delegation kann den Bereich NUR einschränken, nie erweitern
- Read + Write Capabilities separat
- Ähnlich UCAN, aber in die Sync-Engine integriert

Beispiel:
Alice hat: write(namespace=group1, path=/*, subspace=*)
Alice delegiert: write(namespace=group1, path=/events/*, subspace=bob)
  → Bob kann nur Events in seinem Subspace schreiben
```

#### Bewertung für Web of Trust (2026-02-08)

```
Vorteile:
✅ Meadowcap = genau das Capability-Modell das wir brauchen!
✅ Ed25519 Keys (kompatibel)
✅ 3D-Datenmodell ideal für Spaces/Modules (Namespace=Group, Path=Module)
✅ Private Area Intersection = datenschutzfreundlicher Sync
✅ Architektonisch der eleganteste Ansatz
✅ Earthstar existiert als TypeScript-Implementierung

Nachteile:
❌ Earthstar stagniert (letzte Commits Monate alt, gwil einziger Dev)
❌ Willow Rust-Implementierung noch nicht feature-complete
❌ Winzige Community (~640 Stars Earthstar, kaum Nutzer)
⚠️ Kein React-Integration, keine UI-Bindings
⚠️ Kein E2EE für Payload-Content (nur Access Control via Meadowcap)
⚠️ Keine Gruppen-Verschlüsselung (Meadowcap ≠ Encryption)
⚠️ Sync-Protokoll komplex und noch nicht battle-tested
```

**Empfehlung:** Architektonisch am elegantesten (Meadowcap ≈ UCAN + Sync). Aber zu unreif und zu kleine Community für Produktion. Meadowcap als Inspiration für unseren AuthorizationAdapter. Langfristig beobachten — falls Willow Rust-Implementierung reift und WASM-Bindings bekommt, ist es der natürlichste Fit.

### Subduction

> P2P sync protocol for efficient synchronization of encrypted, partitioned data

**GitHub:** <https://github.com/inkandswitch/subduction> (~35 Stars)
**Entwickler:** Ink & Switch (die Macher von Automerge)
**Status:** Pre-Alpha — "DO NOT use for production use cases"
**Evaluiert:** 2026-03-07

#### Eigenschaften

| Aspekt | Details |
|--------|---------|
| **Kernkonzept** | Sedimentree: hierarchische Datenstruktur für verschlüsselte Partitionen |
| **Sync** | Hash-basiertes Diff auf verschlüsselten Daten (Server entschlüsselt nie) |
| **Automerge** | Direkte Integration via `automerge_sedimentree` Crate |
| **Transporte** | WebSocket, HTTP Long-Poll, Iroh (QUIC) |
| **Sprache** | Rust (93.6%) + WASM-Bindings für Browser/Node.js |
| **E2EE** | Native — Sync funktioniert auf Ciphertext-Ebene |
| **Crypto** | `subduction_crypto` Crate (signierte Payloads) |

#### Vergleich mit unserem Ansatz

| Aspekt | WoT (aktuell) | Subduction |
|--------|---------------|------------|
| Server sieht Klartext? | Nein (AES-256-GCM) | Nein (Sedimentree) |
| Verschlüsselung wo? | Client | Client |
| Merge wo? | Client (Automerge) | Client (Automerge) |
| Sync-Effizienz | Full-Doc-Snapshot bei requestSync | Hash-basiertes Diff auf Ciphertext |
| Sprache | TypeScript | Rust + WASM |

Der zentrale Unterschied: **Sedimentree** ermöglicht es, den Sync-Prozess selbst auf verschlüsselten Daten durchzuführen. Der Server kann effizient berechnen, welche Partitionen ein Peer braucht, ohne die Daten zu entschlüsseln. Bei unserem Ansatz muss der anfragende Client den ganzen Snapshot holen und lokal mergen.

#### Bewertung für Web of Trust (2026-03-07)

Vorteile:

- Von Ink & Switch (Automerge-Macher) — Tiefstes Verständnis von CRDTs + E2EE
- Sedimentree-Ansatz: Effizienterer Sync als Full-Doc-Snapshot
- Direkte Automerge-Integration
- Server bleibt ahnungslos (Zero-Knowledge Sync)

Nachteile:

- Sehr früh (v0.6.0, 35 Stars, "DO NOT use for production")
- Rust + WASM — Integration in unser TypeScript-Ökosystem aufwändig
- Instabile API
- Kleine Community, wenig Dokumentation

**Empfehlung:** Beobachten. Subduction löst das gleiche Problem wie unser EncryptedSyncService + requestSync, aber effizienter. Für unseren aktuellen Stand (kleine Docs, wenige User) ist unser DIY-Ansatz ausreichend. Wenn Subduction reift und stabile WASM-Bindings bietet, könnte es unseren Sync-Layer ersetzen — als Drop-in unter dem ReplicationAdapter.

---

## Warum haben diese Frameworks keinen DID-Support?

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  1. Unterschiedliche Design-Philosophien                    │
│     • Local-First: Geschlossenes Ökosystem                 │
│     • DIDs: Universelle Interoperabilität                  │
│                                                             │
│  2. DIDs sind "zu viel" für ihren Usecase                  │
│     • Sie brauchen nur Public Key für Crypto                │
│     • DID Document ist Overhead                             │
│                                                             │
│  3. Resolver-Problem                                        │
│     • did:web braucht HTTP (nicht offline-first!)          │
│     • did:key ist self-describing, aber warum DID-String?  │
│                                                             │
│  4. Historische Entwicklung                                 │
│     • CRDTs und DIDs entwickelten sich parallel            │
│     • Welten treffen sich erst jetzt                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Unsere Lösung: DID-Layer über Framework

```typescript
// Framework speichert Bytes, wir interpretieren als DID

class WotIdentity {
  private keyPair: KeyPair;

  // Für externe Systeme: DID
  get did(): string {
    return publicKeyToDid(this.keyPair.publicKey);
  }

  // Für Framework-interne Nutzung
  get publicKey(): Uint8Array {
    return this.keyPair.publicKey;
  }
}
```

---

## Framework-Agnostische Architektur (v2)

> Siehe [adapter-architektur-v2.md](adapter-architektur-v2.md) für die vollständige Adapter-Spezifikation.

### Schichten-Modell (aktualisiert 2026-02-08)

Die v1-Architektur hatte 2 Adapter (Storage + Crypto). Nach der Erkenntnis, dass Messaging
und CRDT-Replication zwei orthogonale Achsen sind, erweitern wir auf 6 Adapter:

```
┌─────────────────────────────────────────────────────────────┐
│                     WoT Application                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              WoT Domain Layer                        │   │
│  │  • Identity, Contact, Verification, Attestation     │   │
│  │  • Item, Group, AutoGroup                           │   │
│  │  • Business Logic (Empfänger-Prinzip)               │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           6 WoT Adapter Interfaces                  │   │
│  │                                                     │   │
│  │  Bestehend (v1, implementiert):                     │   │
│  │  • StorageAdapter       (lokale Persistenz)         │   │
│  │  • ReactiveStorageAdapter (Live Queries)            │   │
│  │  • CryptoAdapter        (Signing/Encryption/DID)    │   │
│  │                                                     │   │
│  │  Neu (v2):                                          │   │
│  │  • MessagingAdapter     (Cross-User Delivery)       │   │
│  │  • ReplicationAdapter   (CRDT Sync + Spaces)        │   │
│  │  • AuthorizationAdapter (UCAN-like Capabilities)    │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│     ┌─────────┬───────────┼───────────┬─────────┐         │
│     ▼         ▼           ▼           ▼         ▼         │
│  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐      │
│  │Evolu  │ │WebSock│ │Auto-  │ │Matrix │ │Custom │      │
│  │Storage│ │Relay  │ │merge  │ │Client │ │UCAN   │      │
│  └───────┘ └───────┘ └───────┘ └───────┘ └───────┘      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Drei Sharing-Patterns

Die Architektur muss drei fundamental verschiedene Sharing-Patterns unterstützen:

```
1. GROUP SPACES (Kanban, Kalender, Karte)
   ├── Mechanismus: ReplicationAdapter (CRDT Sync)
   ├── Verschlüsselung: Group Key (rotiert bei Member-Änderung)
   ├── Alle Members sehen alle Daten im Space
   └── Beispiel: Kanban-Board für WG → alle sehen alle Tasks

2. SELECTIVE SHARING (Event für 3 von 10 Kontakten)
   ├── Mechanismus: MessagingAdapter (Item-Key Delivery)
   ├── Verschlüsselung: Item-Key pro Item, encrypted per Recipient
   ├── Nur ausgewählte Empfänger können entschlüsseln
   └── Beispiel: Kalender-Event nur für Anna, Bob, Carl

3. 1:1 DELIVERY (Attestation, Verification)
   ├── Mechanismus: MessagingAdapter (Fire-and-forget)
   ├── Verschlüsselung: E2EE mit Empfänger-PublicKey
   ├── Empfänger-Prinzip: gespeichert beim Empfänger
   └── Beispiel: "Anton attestiert Bob: Zuverlässig"
```

### Adapter-Interfaces (Übersicht)

Die bestehenden v1-Interfaces (StorageAdapter, ReactiveStorageAdapter, CryptoAdapter)
bleiben unverändert. Die drei neuen v2-Interfaces werden in
[adapter-architektur-v2.md](adapter-architektur-v2.md) detailliert spezifiziert.

---

## Anforderungs-Matrix (v2)

Abgleich der WoT-Anforderungen mit allen evaluierten Kandidaten:

### CRDT/Sync-Achse

| Anforderung | Evolu | Automerge | Yjs | Jazz | p2panda |
|-------------|-------|-----------|-----|------|---------|
| Custom Keys (BIP39 → Ed25519) | ✅ | ❌ Selbst | ❌ Selbst | ❌ | ✅ |
| E2EE mandatory | ✅ | ❌ Selbst | ❌ Selbst | ✅ | ✅ |
| React/React Native | ✅ | ⚠️ WASM | ✅ | ✅ | ❌ |
| Multi-Device Sync | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cross-User Sync (Spaces) | ❌ | ✅ | ✅ | ✅ Groups | ✅ |
| Offline-First | ✅ | ✅ | ✅ | ✅ | ✅ |
| Produktionsreife | ✅ | ✅ | ✅ | ⚠️ Beta | ❌ |

### Messaging-Achse

| Anforderung | Matrix | Nostr | DIDComm | Custom WS |
|-------------|--------|-------|---------|-----------|
| Ed25519-kompatibel | ✅ | ❌ secp256k1 | ✅ did:key | ✅ |
| E2EE (1:1) | ✅ Olm | ✅ NIP-44 | ✅ JWE | ✅ Selbst |
| E2EE (Gruppen) | ✅ Megolm | ❌ | ❌ | ❌ Selbst |
| Offline-Queue | ✅ Homeserver | ✅ Relays | ⚠️ Mediator | ✅ Server |
| DID-Addressing | ❌ @user:server | ❌ npub | ✅ | ✅ |
| Item-Key Delivery | ❌ Selbst | ❌ | ❌ | ✅ |
| Empfänger-Prinzip | ⚠️ Room-Modell | ❌ Sender-Events | ✅ | ✅ |
| Self-hostable | ✅ | ✅ | ⚠️ | ✅ |
| JS SDK Qualität | ⚠️ Groß | ✅ nostr-tools | ❌ Stale | ✅ |

### WoT-spezifische Anforderungen

| Anforderung | Bester Kandidat | Anmerkung |
|-------------|----------------|-----------|
| Empfänger-Prinzip | Custom WS / DIDComm | Kein Framework bildet das nativ ab |
| Item-Key-Modell (AES per Item, encrypted per Recipient) | Eigene Implementierung | CryptoAdapter hat die Primitives |
| Selektive Sichtbarkeit (N von M) | Eigene Implementierung | Item-Key + MessagingAdapter |
| UCAN-like Capabilities | Willow/Meadowcap (Inspiration) | Eigene Implementierung, inspiriert von Meadowcap |
| Gruppen mit Admin + Quorum | Eigene Implementierung | Kein Framework hat demokratische Gruppen |
| Social Recovery (Shamir) | Eigene Implementierung | Bereits in WotIdentity geplant |

---

## Empfehlungen (aktualisiert 2026-02-08, v2)

### Zentrale Erkenntnis

> **Kein einzelnes Framework erfüllt unsere Anforderungen.**
>
> Die WoT-spezifischen Anforderungen (Empfänger-Prinzip, Item-Key-Modell, selektive
> Sichtbarkeit, UCAN Capabilities, demokratische Gruppen) sind einzigartig genug,
> dass sie immer eigene Implementierung erfordern — unabhängig vom gewählten Framework.
>
> **Die richtige Strategie: Adapter-Architektur mit austauschbaren Implementierungen.**

### Eliminierte Kandidaten

| Kandidat | Grund | Details |
|----------|-------|---------|
| **ActivityPub** | Kein E2EE, Server-Pflicht | Widerspricht Local-First und Privacy-Grundsätzen |
| **Nostr** | secp256k1 ≠ Ed25519 | Fundamentaler Krypto-Mismatch, kein Item-Key-Konzept |
| **DXOS** | ECDSA P-256 ≠ Ed25519 | Krypto-Mismatch, kein React Native |
| **DIDComm** | JS-Libs stale | Spec gut, aber Ökosystem nicht nutzbar (2023) |
| **Iroh** | Nur Networking-Layer | Kein JS SDK, kein App-Framework |
| **p2panda** | Kein JS SDK | Architektonisch ideal, aber nicht für Web nutzbar |

### Empfohlene Architektur

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  CRDT/SYNC-ACHSE:                                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  POC:  Evolu (lokale Persistenz + Multi-Device)     │   │
│  │  Ziel: Automerge (Cross-User Spaces, wenn nötig)    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  MESSAGING-ACHSE:                                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  POC:  Custom WebSocket Relay (minimal, DID-basiert)│   │
│  │  Ziel: Matrix (Gruppen-E2EE, Federation, auditiert) │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  AUTHORIZATION:                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Eigene Implementierung, inspiriert von Meadowcap    │   │
│  │  und UCAN (signierte, delegierbare Capabilities)     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Tier-Einteilung (v2)

**Tier 1: POC-Implementierung (jetzt)**

| Adapter | Implementierung | Begründung |
|---------|----------------|------------|
| StorageAdapter | Evolu | Custom Keys, React, BIP39, E2EE, bereits integriert |
| ReactiveStorageAdapter | Evolu | Live Queries via Subscribable |
| CryptoAdapter | WebCrypto + noble | Bereits implementiert und getestet |
| MessagingAdapter | Custom WebSocket Relay | Minimal, DID-basiert, volle Kontrolle |

**Tier 2: Mittelfrist (nach POC)**

| Adapter | Implementierung | Wann |
|---------|----------------|------|
| ReplicationAdapter | Automerge | Wenn Cross-User Spaces gebraucht werden |
| AuthorizationAdapter | Custom UCAN-like | Wenn selektive Sichtbarkeit implementiert wird |
| MessagingAdapter | Matrix | Wenn Federation und Gruppen-E2EE gebraucht werden |

**Tier 3: Langfrist (beobachten)**

| Framework | Wann relevant | Begründung |
|-----------|--------------|------------|
| **NextGraph** | Wenn JS SDK + Custom Keys | Philosophisch am nächsten, RDF-Graph ideal |
| **p2panda** | Wenn WASM-Bindings | Echtes P2P, LoRa/BLE für Offline-Gemeinschaften |
| **Willow/Earthstar** | Wenn Earthstar weiterentwickelt wird | Meadowcap = elegantestes Capability-Modell |
| **Keyhive** | Wenn stabil | BeeKEM für Gruppen-Key-Rotation |

**Tier 4: Bausteine & Inspiration**

| Quelle | Was wir nutzen |
|--------|---------------|
| **Meadowcap** (Willow) | Capability-Modell für AuthorizationAdapter |
| **DIDComm** (Spec) | Message-Format-Inspiration für MessagingAdapter |
| **Secsync** | Architektur-Referenz für E2EE über CRDTs |
| **p2panda-encryption** | Group Key Rotation Design |
| **Megolm** (Matrix) | Gruppen-Verschlüsselungs-Referenz |

### Strategie (v2)

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Phase 1: Fundament (jetzt)                                │
│  • 6 Adapter-Interfaces definieren (Anforderungen klären)  │
│  • Evolu für Storage (Custom Keys, bereits integriert)     │
│  • Custom WebSocket Relay für Messaging                    │
│  • Attestation/Verification Delivery funktionsfähig        │
│                                                             │
│  Phase 2: Selektives Teilen                                │
│  • Item-Key-Modell implementieren (CryptoAdapter)          │
│  • MessagingAdapter: Item-Key Delivery an N Empfänger      │
│  • AuthorizationAdapter: Grundlegende Capabilities         │
│                                                             │
│  Phase 3: Gruppen                                          │
│  • ReplicationAdapter: Automerge für shared Spaces         │
│  • Group Key Management (Keyhive-Inspiration)              │
│  • Kalender, Kanban, Karte Module                          │
│                                                             │
│  Phase 4: Skalierung                                       │
│  • MessagingAdapter: Migration zu Matrix                   │
│  • Federation für Cross-Server Messaging                   │
│  • UCAN Delegation Chains                                  │
│  • Ggf. p2panda/NextGraph wenn reif genug                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Warum die Adapter-Architektur kritisch ist

1. **Kein Framework passt zu 100%** — eigene Implementierung unvermeidbar
2. **Technologie-Landschaft bewegt sich schnell** — NextGraph, p2panda, Willow könnten in 12 Monaten reif sein
3. **Verschiedene Achsen, verschiedene Lösungen** — CRDT/Sync und Messaging sind orthogonale Probleme
4. **Interfaces sind billig, Implementierungen teuer** — Interfaces jetzt definieren erzwingt Anforderungsklarheit
5. **Phased Migration möglich** — Custom WS → Matrix, Evolu → Automerge ohne Business-Logik-Änderung

---

## Quellen

- [NextGraph](https://nextgraph.org/) - Decentralized, encrypted, local-first platform
- [Evolu](https://evolu.dev/) - Local-first platform with E2EE
- [Jazz](https://jazz.tools/) - Primitives for local-first apps
- [Secsync](https://github.com/nikgraf/secsync) - E2EE CRDT architecture
- [p2panda](https://p2panda.org/) - Modular P2P framework
- [DXOS](https://dxos.org/) - Decentralized developer platform
- [Keyhive](https://www.inkandswitch.com/keyhive/) - Group key management
- [Loro](https://loro.dev/) - High-performance CRDT library
- [Yjs](https://yjs.dev/) - Shared data types for collaboration
- [Automerge](https://automerge.org/) - JSON-like data structures that sync
- [Nostr](https://nostr.com/) - Notes and Other Stuff Transmitted by Relays
- [Matrix](https://matrix.org/) - Open standard for decentralised communication
- [DIDComm](https://identity.foundation/didcomm-messaging/spec/v2.1/) - DID-based secure messaging
- [ActivityPub](https://www.w3.org/TR/activitypub/) - W3C decentralized social networking
- [Iroh](https://iroh.computer/) - QUIC networking layer (n0-computer)
- [Willow Protocol](https://willowprotocol.org/) - Peer-to-peer data protocol
- [Earthstar](https://github.com/earthstar-project/earthstar) - TypeScript Willow implementation
- [UCAN](https://ucan.xyz/) - User Controlled Authorization Networks
- [Ossa Protocol](https://jamesparker.me/blog/post/2025/08/04/ossa-towards-the-next-generation-web) - Universal sync protocol
- [awesome-local-first](https://github.com/alexanderop/awesome-local-first) - Curated list

---

## Weiterführend

- [Adapter-Architektur v2](adapter-architektur-v2.md) - 6-Adapter-Spezifikation (NEU)
- [Sync-Protokoll](sync-protokoll.md) - Wie Offline-Änderungen synchronisiert werden
- [Verschlüsselung](verschluesselung.md) - E2E-Verschlüsselung im Detail
- [Datenmodell](../datenmodell/README.md) - Entitäten und ihre Beziehungen
