# WoT × Human Money Core — Integrationskonzept

**Stand:** 2026-03-24
**Autoren:** Anton Tranelis, Sebastian Galek, Eli
**Status:** Entwurf — Grundlagenarbeit

---

## 1. Ausgangslage

Zwei Projekte mit identischem kryptografischen Fundament, aber unterschiedlichem Fokus:

| | Web of Trust | Human Money Core |
|---|---|---|
| **Fokus** | Soziales Vertrauen, Identität | Dezentrales Geld, Voucher |
| **Sprache** | TypeScript | Rust |
| **Identity** | did:key (Ed25519) | did:key (Ed25519) |
| **Krypto** | Web Crypto API (+Noble für Key-Derivation) | ed25519-dalek, SHA3, ChaCha20 |
| **Mnemonics** | BIP39 (Deutsch) | BIP39 |
| **Netzwerk** | WebSocket Relay (Yjs) | Kein Netzwerk im Core (Library) |
| **Storage** | CompactStore + Vault + Profiles | Verschlüsselte Dateien, Storage-Trait |
| **Architektur** | 7 Adapter, Vier-Wege-Sync | Micro-Chain pro Gutschein |

**Ziel:** Ein gemeinsames Ökosystem, in dem WoT das Vertrauensfundament liefert und Human Money Core darauf aufbauend dezentrales Geld ermöglicht.

---

## 2. Architektur-Entscheidung: Hybrid-Ansatz

Weder vollständige Rust-Migration noch reine WASM-Einbettung. Stattdessen ein Hybrid:

```
┌──────────────────────────────────┐
│  Application Layer (TypeScript)  │
│  RLS Module, UI, Yjs, Adapter   │
│  Relay, Vault, Reaktivität      │
├──────────────────────────────────┤
│  Extension Layer                 │
│  Finanzielles Vertrauen          │
│  Bürgschaften, Reputations-Score │
│  Schwellenwerte, Regeln          │
├──────────────────────────────────┤
│  Shared Core (Rust → WASM)       │
│  Identity, Crypto, Trust Graph   │
│  Voucher, Double-Spend Detection │
│  Blinded Keys, Attestations      │
└──────────────────────────────────┘
```

**Prinzip:** Alles Kryptografische und Mathematische in Rust. Alles was Netzwerk, Storage-Adapter, UI-Reaktivität und CRDTs betrifft, bleibt TypeScript.

### Begründung

- **Ein Krypto-Stack:** Zwei Ed25519-Implementierungen in zwei Sprachen sind ein Sicherheitsrisiko. Ein Rust-Core eliminiert das.
- **Sebastians Code existiert:** Identity, Crypto, Micro-Chain, Double-Spend Detection — getestet und durchdacht.
- **Schrittweise migrierbar:** Crypto-Utils zuerst, dann Attestations, dann Trust Graph.
- **Yjs bleibt unberührt:** CRDTs und Sync leben weiter in der TypeScript-Schicht.
- **Performance:** Rust/WASM ist besser für Graphenberechnung (Trustpfade, Multipath, Decay).

---

## 3. Drei Schichten im Detail

### 3.1 WoT Core — was hinein gehört

Der Core bleibt ein generisches Vertrauensprotokoll, nicht an Finanzen gekoppelt:

**Bereits vorhanden:**
- Identity (did:key, BIP39, HKDF Master Key)
- SignedClaim / Attestations (binär: verifiziert oder nicht)
- Verschlüsselung + Signatur aller Daten

**Neu — aus Sebastians Canvas:**

#### Blinded Keys / Salting
Hybrides Datenschutz-Modell:
- **Offene Public Keys** für Akteure, die öffentliche Reputation aufbauen wollen (Gewerbetreibende, Vereine, NGOs)
- **Blinded Keys** (Hash mit Salt) für Privatpersonen — verhindert Deanonymisierung durch Netzwerkanalyse
- Beweis per Peer-to-Peer: B offenbart Salt gegenüber C, um die Signatur von A zu beweisen. Für den Rest des Netzwerks bleibt die Verbindung unsichtbar.

#### Trustpfade (Trust Graph)
- **Transitive Vertrauensdämpfung (Decay):** Jeder Hop reduziert Vertrauen prozentual (z.B. 90% × 90% = 81%)
- **Multipath-Kombination:** Mehrere unabhängige Pfade erhöhen Gesamtvertrauen
- **Proof of Personhood:** Sybil-Resistenz als eigene Ebene — "Ich bestätige, dass dies ein echter Mensch ist"

#### Revocation / Tombstones
- Sofortige, priorisierte Widerrufsnachricht bei Vertrauensbruch oder Schlüsselverlust
- Annulliert alle bisherigen Attestations/Bürgschaften

### 3.2 Extension Layer — Finanzielles Vertrauen

Aufbauend auf dem Core, aber nicht Teil davon:

#### Finanzielles Vertrauen (Ebene 1)
- Graduelle Vertrauenswerte statt binär: "Ich vertraue Gutscheinen von X zu Y%"
- UX-Pragmatismus: Einfache Kategorien ("Bekannter" → 30%, "Enger Vertrauter" → 90%)
- Systemintern gemappt auf Prozentwerte

#### Bürgschaft als Willenserklärung
- Vertrauen aussprechen = vertragsähnlicher Akt mit Haftung
- "Sollte B seinen Verpflichtungen nicht nachkommen, hafte ich für X% des Ausfalls"
- Vertrauen wird zur knappen, wertvollen Ressource — Spam-Vertrauen eliminiert

#### Automatische Reputationsanpassung
- Ausgelöst durch `ProofOfDoubleSpend` aus Human Money Core
- Bei Betrug: Trust-Score des Betrügers → Null
- Kaskade: Bürgen erleiden Reputationsschaden (proportional zu ihrer Bürgschaft)
- Möglich weil Double Spending kryptographisch beweisbar ist — kein Dispute nötig

#### Schwellenwerte (Client-Regeln)
- Konfigurierbar pro Client: "Gutscheine unter 50 Einheiten ab 60% Trust automatisch akzeptieren"

### 3.3 Human Money Core — Voucher-Schicht

Sebastians Rust-Library, konsumiert als WASM-Modul:

#### Micro-Chain pro Gutschein
- Jeder Voucher = eigene verkettete Transaktionsliste (JSON)
- Init → Transfer → Split — jede Transaktion signiert, jeder Hash verkettet
- Kein globales Ledger nötig

#### Double-Spend Detection (Schlüsselkonzept)
Betrug wird nicht verhindert, sondern **garantiert erkannt und kryptographisch bewiesen:**

1. **Prävention (lokal):** Wallet blockiert doppelte Transaktionen vom gleichen Zustand
2. **Erkennung (Gossip):** TransactionFingerprints werden epidemisch verbreitet — zwei verschiedene t_ids für denselben Fingerprint = Double Spend
3. **Beweis:** `ProofOfDoubleSpend` — deterministisch, portabel, unwiderlegbar

#### Konfliktlösung
- **Offline:** "Earliest Wins" via verschlüsseltem Zeitstempel
- **Layer 2:** Notar/Schlichtungsstelle (optional)
- **Sozial:** `ResolutionEndorsement` — Opfer signiert Beilegung

---

## 4. Technische Brücke: Rust ↔ TypeScript

### WASM als Integrationspfad

Human Money Core ist als reine Library ohne Netzwerk-/Filesystem-Zugriff im Kern designed. Alle Crypto-Dependencies sind WASM-kompatibel.

```
TypeScript (RLS/WoT App)
    ↕ wasm-bindgen
Rust Core (WASM)
    ├── wot-crypto (Identity, Ed25519, HKDF, Blinded Keys)
    ├── wot-graph (Trustpfade, Decay, Multipath)
    ├── wot-attestation (SignedClaim, Revocation)
    └── human-money-core (Voucher, Micro-Chain, Double-Spend)
```

### Migrationspfad (schrittweise)

**Phase 1 — Shared Crypto:**
- `wot-crypto` Crate: Identity (did:key, BIP39, HKDF), Signatur, Verifikation
- Ersetzt `@noble/ed25519` und Teile des `WebCryptoAdapter`
- Erstes gemeinsames Rust-Paket zwischen beiden Projekten

**Phase 2 — Attestations + Blinded Keys:**
- `wot-attestation` Crate: SignedClaim, Blinded Keys mit Salting, Revocation
- Konsumiert `wot-crypto`

**Phase 3 — Trust Graph:**
- `wot-graph` Crate: Transitive Pfade, Decay, Multipath-Berechnung
- Performance-kritisch — Rust-Vorteil am größten

**Phase 4 — Voucher-Integration:**
- Human Money Core als weiteres Crate im Workspace
- Teilt `wot-crypto` mit den WoT-Crates
- Extension Layer verbindet ProofOfDoubleSpend → Reputationsanpassung

### Netzwerk / Gossip

Fingerprint-Gossip für Double-Spend Detection braucht einen Transportkanal. Optionen:
- **Über unseren WebSocket Relay:** Fingerprints als eigener Message-Typ neben Yjs-Sync
- **Eigenes Gossip-Protokoll:** Unabhängig vom Relay, P2P
- **Hybrid:** Relay für Online, direkter Austausch bei Offline-Transaktionen

→ Zu klären in der Detailplanung.

---

## 5. Offene Fragen

| Frage | Kontext |
|---|---|
| **Rust-Kompetenz im Team?** | Anton + Sebastian Galek — wer noch? Tillmann? Sebastian Stein? |
| **WASM-Boundary-Design** | Ein großes Modul oder mehrere kleine Crates? Granularität der API? |
| **TTL / Ablaufdatum** | Sinnvoll für Attestations? Erzwingt Erneuerung, aber erhöht Aufwand |
| **Trust Manifests** | Batching spart Netzwerk, aber wie bleibt Einzelverifizierung möglich? |
| **Graph-Berechnung: wo?** | Client-seitig (WASM)? Oder braucht es einen Service für große Graphen? |
| **Yjs + Voucher-State** | CRDTs nur für Social Layer oder auch für Voucher-Metadaten? |
| **SAI (Separated Account Identity)** | Multi-Device-Konzept von HMC — kompatibel mit unserem Vault-Sync? |

---

## 6. Zusammenfassung

Das Web of Trust liefert das **Vertrauensfundament**: Wer bist du? Wer kennt dich? Wer bürgt für dich?

Human Money Core liefert die **ökonomische Schicht**: Dezentrales Geld, offline-fähig, mit kryptographisch beweisbarer Betrugserkennung.

Die Verbindung: Ein `ProofOfDoubleSpend` fließt vom Voucher-System nach oben ins WoT und löst dort automatische Reputationseffekte aus. Umgekehrt nutzt das Voucher-System den Trust Graph, um Transaktionsentscheidungen zu treffen ("Akzeptiere ich diesen Gutschein?").

**Zwei Projekte, ein Ökosystem. Vertrauen als Fundament, Geld als Anwendung.**
