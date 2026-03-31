# WoT × Human Money Core — Integrationskonzept

**Status:** Entwurf (2026-03-30)
**Autoren:** Anton Tranelis, Sebastian Galek, Eli
**Kontext:** Kooperation zwischen Web of Trust und Human Money Core

---

## Kontext

Dieses Dokument beschreibt die geplante Integration dreier unabhaengiger Open-Source-Projekte:

- **Web of Trust** (Anton Tranelis) — Dezentrales Vertrauensnetzwerk auf Basis echter Begegnungen. Persoenliche Verifikation per QR-Code, verschluesselte Spaces, Sybil-Resistenz ohne Blockchain.
- **Human Money Core** (Sebastian Galek) — Rust-Library fuer dezentrale Gutscheine ([Minuto-Konzept](https://minuto.org)). Jeder Gutschein traegt seine eigene Micro-Chain, offline-faehig, automatische Double-Spend-Erkennung via Gossip-Protokoll.
- **Real Life Stack** (Anton Tranelis, Sebastian Stein) — Backend-agnostischer App-Baukasten fuer Gemeinschaften. Module (Karte, Kalender, Marktplatz, u.a.) lassen sich frei kombinieren.

**Ziele:**
- Gutscheine als eigenstaendiges RLS-Modul bereitstellen, nutzbar fuer jede Community
- Eine eigene Gutschein-App auf Basis des Real Life Stack bauen

WoT liefert die Vertrauensinfrastruktur, HMC das Wertschoepfungssystem, RLS die App-Plattform. Dieses Dokument dient als Diskussionsgrundlage fuer die bestmoegliche Integration.

---

## Vision (6-Monats-Ziel)

Echte Menschen und Communities nutzen Apps auf Basis von WoT + Real Life Stack. Persoenliche Gutscheine (Human Money Core) sind ein Zahlungsmittel unter vielen Modulen.

**Zwei Richtungen:**
- Sebastian Galeks Community nutzt eine RLS-App mit Gutscheinen, Marktplatz, Karte
- Andere RLS-Communities nutzen Gutscheine auf Basis des HMC

**Mobile Apps** (Android + iOS) sind schnell und bieten:
- Sichere Schluesselverwaltung (Secure Enclave / Keystore)
- Verifikation / Handshake (QR, NFC)
- Push-Notifikationen
- Offline-Unterstuetzung

---

## Gemeinsame Grundlagen

| | WoT | Human Money Core |
|---|---|---|
| **Kryptografie** | Ed25519 | Ed25519 |
| **Identitaet** | did:key | did:key |
| **Seed** | BIP39 (German) | BIP39 |
| **Architektur** | Dezentral, kein Single Point of Trust | Dezentral, kein Server, keine Blockchain |
| **Sprache** | TypeScript | Rust |
| **Offline** | Designziel | Kernfeature |

---

## Schichtenmodell

Das System besteht aus drei klar getrennten Schichten:

```
┌─────────────────────────────────────────────────┐
│                RLS App (UI)                      │
│  React / Mobile WebView                         │
│  Module: Marktplatz, Karte, Chat, Gutscheine... │
├─────────────────────────────────────────────────┤
│           Extension Layer (optional)             │
│  ┌─────────────────┐  ┌──────────────────────┐  │
│  │ Finanzielles    │  │ Buergschafts-Modul   │  │
│  │ Vertrauen       │  │ (Haftung, Score)     │  │
│  │ (prozentual)    │  │                      │  │
│  └─────────────────┘  └──────────────────────┘  │
│  ┌─────────────────┐  ┌──────────────────────┐  │
│  │ Human Money     │  │ Reputations-         │  │
│  │ Core            │  │ Anpassung            │  │
│  │ (Gutscheine)    │  │ (Double-Spend →      │  │
│  │                 │  │  Trust-Konsequenzen)  │  │
│  └─────────────────┘  └──────────────────────┘  │
├─────────────────────────────────────────────────┤
│              WoT Core (Basis)                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Identity │ │ Attestat.│ │ Trust Graph      │ │
│  │ did:key  │ │ Signed   │ │ Pfade, Decay,    │ │
│  │ BIP39    │ │ Claims   │ │ Multipath        │ │
│  │ HKDF     │ │          │ │                  │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Crypto   │ │ Privacy  │ │ Revocation       │ │
│  │ Sign,    │ │ Blinded  │ │ Tombstones,      │ │
│  │ Verify,  │ │ Keys,    │ │ Sofort-Widerruf  │ │
│  │ Encrypt  │ │ Salting  │ │                  │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
└─────────────────────────────────────────────────┘
```

### WoT Core (Basis-Protokoll)

Was JEDE App braucht, unabhaengig vom Anwendungsfall:

- **Identity** — did:key, BIP39, HKDF Master Key, Ed25519
- **Attestations** — SignedClaim: "Ich bestaetige, dass ID X einem echten Menschen gehoert" (Proof of Personhood / Sybil-Resistenz)
- **Trust Graph** — Unidirektionale Vertrauensbeziehungen mit Pfadberechnung
  - Trust Decay ueber Hops (z.B. 90% × 90% = 81%)
  - Multipath-Kombination (mehrere unabhaengige Pfade erhoehen Vertrauen)
  - Schwellenwerte (konfigurierbar pro Client/Anwendung)
- **Privacy** — Blinded Keys / Salting fuer Privatpersonen, offene PubKeys fuer Gewerbetreibende
- **Revocation** — Tombstone-Nachrichten fuer sofortigen Widerruf bei Vertrauensbruch oder Schluesselverlust
- **Crypto** — Sign, Verify, Encrypt, Decrypt (Web Crypto API / native)

### Extension Layer (anwendungsspezifisch)

Module, die auf dem Core aufbauen, aber nicht jede App braucht:

- **Human Money Core** — Persoenliche Gutscheine, Micro-Chain pro Gutschein, Double-Spend-Detection
- **Finanzielles Vertrauen** — Prozentuale Bewertung ("Ich vertraue Gutscheinen von X zu 90%"), UX-Kategorien ("Bekannter" → 30%, "Enger Vertrauter" → 90%)
- **Buergschafts-Modul** — Vertrauen als Willenserklaerung mit Haftung ("Ich hafte fuer X% des Ausfalls")
- **Automatische Reputationsanpassung** — Double-Spend in HMC → kryptographischer Beweis → Trust-Score sinkt (Betrueger + leichtfertige Buergen)

---

## Architektur: Web und Native

WoT + HMC sollen auf zwei Plattformen laufen. Beide muessen unterstuetzt werden, und die Zielarchitektur sollte moeglichst beiden gerecht werden.

### Ausgangslage

- WoT Core: TypeScript, Web Crypto API
- Human Money Core: Rust, Ed25519 (dalek)
- Erfahrung: WASM (Automerge/Rust) hatte auf Mobile-Browsern (Vanadium) Performance-Probleme — Hauptgrund fuer Migration zu Yjs

### Plattform-Vergleich

| | Web (Browser) | Native App (iOS/Android) |
| --- | --- | --- |
| **UI** | React | React (im WebView) |
| **CRDT** | Yjs (JavaScript) | Yjs (JavaScript im WebView) |
| **WoT Core** | TypeScript + Web Crypto | TypeScript oder Rust Portierung |
| **HMC** | Rust via WASM oder TS Portierung | Rust nativ |
| **Schluesselverwaltung** | Web Crypto API (Browser-Sandbox) | Keychain (iOS) / Keystore (Android) |
| **Push** | Service Worker | Native Push APIs |
| **Offline** | Service Worker + IndexedDB | Filesystem + SQLite |

**Herausforderung WASM im Browser:** HMC (Rust) muss im Browser als WASM laufen. HMC-Operationen (Gutschein erstellen, uebertragen, verifizieren) sind deutlich seltener als CRDT-Sync, das WASM-Performance-Risiko ist daher geringer als bei Automerge. Trotzdem muss die WASM-Performance frueh getestet werden.

### Optionen fuer die native App

Fuer die Web-Version gibt es keine Architektur-Entscheidung — der Stack (React + TS + WASM) steht. Fuer die native Mobile App gibt es drei Optionen:

**Option A: Tauri 2.0** — React-UI im WebView, Rust-Core (WoT + HMC) laeuft nativ ueber Tauri Bridge.
- Pro: HMC direkt als Rust-Crate, native APIs (Keychain, Push, NFC), eine Codebasis
- Contra: Tauri Mobile noch jung, WebView-Qualitaet variiert auf Android

**Option B: Capacitor** — React-UI im WebView, alles in TypeScript, native APIs ueber Capacitor-Plugins.
- Pro: Erprobtes Oekosystem, gleicher Code fuer Web und Mobile
- Contra: HMC muesste nach TS portiert oder als WASM eingebunden werden

**Option C: Hybrid** — TypeScript-first, Rust nur wo noetig (Graph-Berechnung, HMC).
- Pro: Geringste Komplexitaet, schnellster Prototyp
- Contra: Zwei Implementierungen (Rust + TS) auf Dauer schwer wartbar

### Bewertungsmatrix

| Kriterium | A: Tauri | B: Capacitor | C: Hybrid |
| --- | --- | --- | --- |
| HMC-Integration | Direkt (Rust-Crate) | Port noetig | Port noetig |
| Performance (Mobile) | Nativ, schnell | JS, ausreichend? | JS + Opt-in Rust |
| Schluesselverwaltung | Nativ (Keychain) | Plugin (Capacitor) | Abhaengig von Shell |
| Web-Version | WebView | Identisch | Identisch |
| Team-Kompetenz (Rust) | Anton, Sebastian | Nicht noetig | Minimal |
| Reife des Frameworks | Jung (Tauri Mobile) | Erprobt | Kein Framework-Lock |
| Wartbarkeit | Ein Core (Rust) | Ein Core (TS) | Zwei Cores moeglich |
| Time-to-Market | Mittel | Schnell | Am schnellsten |

Die Frage ob der WoT Core langfristig nach Rust migriert werden sollte, wird separat behandelt: siehe [wot-rust-migration.md](wot-rust-migration.md).

### Ergebnisse aus dem Gespraech mit Sebastian Galek (30.03.2026)

**Rust & Tauri:** Sebastian entwickelt HMC in Rust und baut seine App mit Tauri. In einer gemeinsamen Tauri-App wuerde WoT als TypeScript im WebView laufen, waehrend HMC nativ ueber die Tauri Bridge laeuft — der Standard-Tauri-Ansatz. Langfristig waere eine gemeinsame Rust-Codebasis fuer beide Projekte die elegantere Loesung (siehe [wot-rust-migration.md](wot-rust-migration.md)).

**Lizenz: Entschieden — MIT.** Sebastian argumentierte ueberzeugend fuer eine permissive Lizenz (siehe [Die Open Source Falle](https://www.sebastiangalek.de/posts/2026/die_open_source_falle/)). Maximale Adoption ist in der aktuellen Phase wichtiger als Copyleft-Schutz. Der Wert liegt im Netzwerkeffekt, nicht im Code allein.

**Prioritaeten aus Sebastians Sicht:**
- **Adoption durch Gewerbetreibende** — Sebastians klare Prioritaet: Das System muss so weit kommen, dass echte Firmen und Dienstleister HMC-Gutscheine als Zahlungsmittel akzeptieren. Solange es nur unter Entwicklern laeuft, ist es eine Spielerei. Alles was gebaut wird, muss auf dieses Ziel einzahlen.
- Batch-Signaturen (Trust Manifests) — wichtig fuer Performance bei vielen Vertrauensbeweisen
- Quantitativer Trust Graph — prozentuale Darstellung pro Kontakt, Decay ueber Hops, Multipath-Aggregation

### Zu klaeren

- ~~**Lizenz:**~~ Entschieden: MIT.
- **Tauri Mobile Reife:** Wie stabil ist Tauri 2.0 auf iOS/Android fuer Produktions-Apps?
- **Multipath-Aggregation:** Wie werden mehrere Trust-Pfade kombiniert? Einfache Addition, probabilistisch, oder gewichtet?

---

## Neue Konzepte fuer den WoT Core

### Blinded Keys / Salting (Privacy)

Zwei Modi, je nach Nutzerwunsch:

- **Offener Modus:** PubKey ist oeffentlich sichtbar. Fuer Gewerbetreibende, NGOs, Vereine — sie *wollen* eine oeffentliche Reputation.
- **Privater Modus:** Statt den PubKey zu signieren, signiert A einen Hash von B's Key + Salt. B kann die Signatur bei Bedarf Peer-to-Peer gegenueber C beweisen (durch Offenlegung des Salts). Fuer das restliche Netzwerk bleibt die Verbindung unsichtbar.

### Trust Graph Erweiterungen

- **Decay:** Jeder Hop reduziert Vertrauen prozentual (konfigurierbar). Beispiel: Ich vertraue A zu 70%, A vertraut B zu 50% → abgeleitetes Vertrauen zu B = 35%.
- **Multipath:** Mehrere unabhaengige Pfade erhoehen das Gesamtvertrauen. Wenn B auch ueber C erreichbar ist (60% × 80% = 48%), steigt das aggregierte Vertrauen ueber 35%.
- **Schwellenwerte:** Pro Anwendung konfigurierbar ("Gutscheine unter 50 Einheiten ab 60% Trust automatisch akzeptieren")
- **UX:** Nutzer soll fuer jeden Kontakt den aggregierten Trust-Score sehen koennen — auch fuer Personen die er nicht direkt kennt, aber ueber das Netzwerk erreicht.

### Revocation / Tombstones

- Priorisierte Nachricht ins Netzwerk bei Vertrauensbruch oder Schluesselverlust
- Annulliert alle bisherigen Buergschaften
- Muss ueber Relay und Gossip verbreitet werden

---

## Offene Fragen

1. **Trust Manifests:** Batching von Vertrauensbeweisen spart Resourcen — aber wie bleibt die einzelne Verifizierbarkeit erhalten? Merkle Tree?
2. **Multipath-Aggregation:** Wie werden mehrere Trust-Pfade zu einem Score kombiniert? Einfache Multiplikation, probabilistisch, oder gewichtet?
3. **TTL / Ablaufdatum:** Erzwingt aktive Erneuerung, bereinigt tote Beziehungen — aber ist der UX-Aufwand gerechtfertigt?
4. **Gossip-Kanal:** Fingerprint-Verbreitung ueber den bestehenden WoT Relay (`wss://relay.utopia-lab.org`) oder eigenes Protokoll?
5. ~~**Lizenz:**~~ Entschieden: MIT.

---

## Verwandte Dokumente

- `web-of-trust/docs/concepts/identity-and-keys.md` — Identity-Architektur
- `web-of-trust/docs/security/threat-model.md` — Security Audit + Threat Model
- `web-of-trust/docs/architecture/encryption.md` — Verschluesselungs-Architektur
- `real-life-stack/docs/spec/architektur2.md` — Data Interface Architektur
- [human-money-core](https://github.com/minutogit/human-money-core) — Sebastians Repository
