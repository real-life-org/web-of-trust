# DID-Methoden-Vergleich

> Forschungsergebnisse: Welche DID-Methode passt zum Web of Trust?

**Stand:** 2026-02-07
**Kontext:** Evaluierung nach Week 2 (Identity + Verification implementiert mit did:key)

---

## Ausgangslage

Wir nutzen aktuell **did:key** (Ed25519, multibase, base58btc). Die Frage ist: Reicht das, oder brauchen wir eine andere/zusätzliche Methode?

---

## Evaluierte Methoden

### 1. did:key (aktuell implementiert)

**Prinzip:** DID = Public Key (self-certifying identifier)
**Format:** `did:key:z6MkpTHz...`

| Eigenschaft | Bewertung |
|------------|-----------|
| Infrastruktur | Keine nötig |
| Offline-fähig | Ja |
| Key Rotation | Nein (DID IST der Key) |
| Discovery | Nein |
| Interoperabilität | Hoch (W3C Standard) |
| Komplexität | Minimal |

**Fazit:** Perfekt für lokale, selbst-souveräne Identitäten. Unser aktueller Favorit.

### 2. did:peer

**Prinzip:** DID für 1:1 oder Gruppen-Beziehungen, kein globaler Resolver nötig
**Format:** `did:peer:2.Ez6Mk...`

| Eigenschaft | Bewertung |
|------------|-----------|
| Infrastruktur | Keine |
| Offline-fähig | Ja |
| Key Rotation | Ja (über DID Doc Updates) |
| Discovery | Nein (nur innerhalb der Beziehung) |
| Interoperabilität | Mittel (DIDComm-Ökosystem) |
| Komplexität | Mittel |

**Besonderheit:** Verschiedene "Numalgo"-Varianten (0-4) mit unterschiedlicher Komplexität. Numalgo 2 unterstützt Key Rotation und Service Endpoints.

**Fazit:** Interessant für sichere 1:1-Kanäle zwischen verifizierten Kontakten. Könnte did:key ergänzen.

### 3. did:web

**Prinzip:** DID wird über HTTPS/DNS aufgelöst
**Format:** `did:web:example.com:users:alice`

| Eigenschaft | Bewertung |
|------------|-----------|
| Infrastruktur | Webserver + Domain nötig |
| Offline-fähig | Nein (Auflösung braucht HTTP) |
| Key Rotation | Ja (DID Doc updaten) |
| Discovery | Ja (über URL) |
| Interoperabilität | Hoch |
| Komplexität | Mittel |

**Problem:** Vertraut dem Domain-Inhaber. Zentralisierungsrisiko. TOFU-Problem (Trust On First Use).

**Fazit:** Nützlich für öffentliche Auffindbarkeit, aber widerspricht unserer Dezentralisierungs-Philosophie als primäre Methode.

### 4. did:webvh (ehemals did:tdw)

**Prinzip:** did:web + verifiable history (hash-verkettete Key Events)
**Format:** `did:webvh:example.com:users:alice`

| Eigenschaft | Bewertung |
|------------|-----------|
| Infrastruktur | Webserver + Domain |
| Offline-fähig | Nein |
| Key Rotation | Ja (eingebaut, mit Pre-Rotation) |
| Discovery | Ja |
| Interoperabilität | Neu, wachsend |
| Komplexität | Hoch |

**Besonderheit:** Self-Certifying Identifier (SCID) + Pre-Rotation Keys. Löst das TOFU-Problem von did:web.

**Fazit:** Technisch am robustesten für Key Rotation. Overhead für POC zu hoch.

### 5. did:dht

**Prinzip:** DID im BitTorrent DHT (Mainline DHT) gespeichert
**Format:** `did:dht:...`

| Eigenschaft | Bewertung |
|------------|-----------|
| Infrastruktur | Keine eigene (nutzt BitTorrent-Netzwerk) |
| Offline-fähig | Teilweise |
| Key Rotation | Ja |
| Discovery | Ja (über DHT-Lookup) |
| Interoperabilität | Wachsend (Block, TBD) |
| Komplexität | Mittel-Hoch |

**Fazit:** Spannend für dezentrale Discovery. Abhängigkeit vom DHT-Netzwerk.

### 6. did:plc

**Prinzip:** DID mit zentraler Registry (von Bluesky/AT Protocol)
**Format:** `did:plc:z72i7hdynmk6r22z27h6tvur`

| Eigenschaft | Bewertung |
|------------|-----------|
| Infrastruktur | Zentrale PLC Registry |
| Offline-fähig | Nein |
| Key Rotation | Ja (eingebaut) |
| Discovery | Ja |
| Interoperabilität | AT Protocol Ökosystem |
| Komplexität | Mittel |

**Problem:** Aktuell zentralisiert (Bluesky betreibt die Registry).

**Fazit:** Philosophisch unpassend wegen Zentralisierung.

---

## Vergleichstabelle

| Kriterium | did:key | did:peer | did:web | did:webvh | did:dht | did:plc |
|-----------|---------|----------|---------|-----------|---------|---------|
| **Keine Infrastruktur** | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| **Offline-fähig** | ✅ | ✅ | ❌ | ❌ | ⚠️ | ❌ |
| **Key Rotation** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Discovery** | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Dezentral** | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ❌ |
| **Einfachheit** | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ |
| **Maturity** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| **Self-Certifying** | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| **Multi-Device** | ✅* | ✅* | ✅ | ✅ | ✅ | ✅ |

*\* Multi-Device via gleichen Seed (BIP39) auf allen Geräten*

---

## Key Loss & Recovery pro Methode

| Methode | Bei Key-Verlust | Bei Key-Kompromittierung |
|---------|-----------------|------------------------|
| **did:key** | BIP39 Recovery → gleiche DID | Keine Lösung (DID = Key) |
| **did:peer** | BIP39 Recovery → gleiche DID | Key Rotation möglich |
| **did:web** | Server-seitig neuen Key hinterlegen | DID Doc updaten |
| **did:webvh** | Pre-Rotation Key aktivieren | Key Rotation + History |
| **did:dht** | Neuen Key im DHT publizieren | Key Rotation via DHT |
| **did:plc** | Recovery Key nutzen | Rotation über Registry |

### Erkenntnis: Social Recovery als universelle Lösung

**Social Recovery ist kein Teil der DID-Methode**, sondern eine **Schicht darüber**:

```
┌─────────────────────────────────┐
│  Social Recovery Layer          │  ← Guardians, Shamir, Vouching
│  (methoden-agnostisch)          │     Funktioniert mit jeder DID-Methode
├─────────────────────────────────┤
│  DID Layer                      │  ← did:key, did:peer, did:web, ...
│  (austauschbar)                 │
├─────────────────────────────────┤
│  Crypto Layer                   │  ← Ed25519, BIP39, HKDF
│  (Fundament)                    │
└─────────────────────────────────┘
```

Social Recovery relativiert die DID-Methoden-Wahl erheblich:
- **Shamir** (Secret Sharing) → Seed rekonstruieren → gleiche DID behalten (funktioniert mit jeder Methode)
- **Guardians** (Vouching) → Neuen Key autorisieren → braucht Key Rotation (did:peer, did:webvh, etc.)

---

## Empfehlung

### POC (jetzt): did:key

- Bereits implementiert und getestet
- Kein Server nötig
- BIP39 Seed → deterministische DID → Multi-Device gelöst
- Social Recovery (Shamir) kann als erste Schutzschicht dazu

### Mittelfristig: did:key + did:peer Hybrid

- did:key als primäre Identität (öffentlich, stabil)
- did:peer für sichere 1:1-Kanäle nach Verification
- Ermöglicht Key Rotation innerhalb von Beziehungen

### Langfristig: Methoden-agnostisches WoT

- WoT-Layer arbeitet mit beliebigen DIDs
- Verschiedene Nutzer können verschiedene Methoden nutzen
- Alice (did:key) verifiziert Bob (did:web) → funktioniert
- Nur Voraussetzung: DID kann signieren und hat stabilen Identifier

---

## Referenz: Murmurations Network

Murmurations (https://github.com/MurmurationsNetwork) nutzt ebenfalls **did:key + Ed25519** für ihre MurmurMaps-App und bestätigt damit unsere Wahl:

- Ed25519 Key Pairs in Browser IndexedDB
- did:key als Identifier
- UCAN Tokens für capability-basierte Authorization
- **Aber:** Non-exportable Keys (kein Backup!), Email-Recovery als Fallback

**Was wir besser machen:**
- BIP39 Mnemonic → Seed ist exportierbar und backupbar
- Deterministische Key-Ableitung → Multi-Device ohne Server
- Social Recovery statt zentralisierter Email-Recovery (geplant)

**Was wir von ihnen lernen können:**
- UCAN für Delegation und Berechtigungen (relevant für Zeitgutscheine, Rollen)
- Composable JSON Schemas für Profile/Discovery
- Login Tokens als pragmatische Multi-Device-Lösung (Alternative zu Seed-Eingabe)

---

*Erstellt: 2026-02-07 | Kontext: Forschungs-Session mit Anton*
