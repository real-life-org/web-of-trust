# Social Recovery

> Forschungsergebnisse: Wie schützen wir Nutzer vor Key-Verlust und Key-Kompromittierung?

**Stand:** 2026-02-07
**Kontext:** Evaluierung nach DID-Methoden-Forschung

---

## Problem

Zwei grundverschiedene Szenarien:

| Szenario | Beschreibung | Risiko |
|----------|-------------|--------|
| **Key-Verlust** | Handy kaputt, Browser-Daten gelöscht, Seed vergessen | Identität nicht mehr zugänglich |
| **Key-Kompromittierung** | Seed gestohlen, Gerät gehackt | Angreifer kann als ich handeln |

BIP39 Mnemonic löst Key-Verlust (Seed aufschreiben). Aber: Was wenn der Zettel verloren geht? Und gegen Key-Kompromittierung hilft BIP39 gar nicht.

---

## Zwei Hauptansätze

### 1. Shamir Secret Sharing (Seed-Rekonstruktion)

**Prinzip:** Der BIP39 Mnemonic wird mathematisch in N Teile ("Shards") aufgeteilt. M-von-N Shards reichen zur Rekonstruktion.

```
Alice's Seed (12 Wörter)
         ↓
Shamir Secret Sharing (3-von-5)
         ↓
┌─────────┬─────────┬─────────┬─────────┬─────────┐
│ Shard 1 │ Shard 2 │ Shard 3 │ Shard 4 │ Shard 5 │
│  (Bob)  │ (Carol) │ (David) │  (Eva)  │ (Frank) │
└─────────┴─────────┴─────────┴─────────┴─────────┘

Rekonstruktion: Beliebige 3 von 5 Shards → Original-Seed
```

**Mathematik:**
- Shamir's Secret Sharing (1979) basiert auf Polynominterpolation
- Informationstheoretisch sicher: M-1 Shards verraten NICHTS über das Geheimnis
- Bewährter Algorithmus, breit implementiert

**Referenz-Implementierung: Dark Crystal (Scuttlebutt)**
- P2P Social Key Backup
- Custodians speichern Shards in ihrem lokalen SSB-Feed
- Open Source: https://darkcrystal.pw/
- Kein Server nötig

**Vorteile:**
- Original-Schlüssel wird wiederhergestellt → DID bleibt identisch
- Mathematisch bewiesen sicher
- Funktioniert mit jeder DID-Methode
- Keine Wartezeit

**Nachteile:**
- Shards müssen sicher übertragen und aufbewahrt werden
- Kollusionsrisiko: M Custodians zusammen könnten den Key stehlen
- Hilft NICHT bei Key-Kompromittierung (Angreifer hat den Key bereits)
- Custodians müssen verfügbar sein wenn Recovery gebraucht wird

---

### 2. Guardian/Vouching (Key-Autorisierung)

**Prinzip:** Kein Geheimnis wird geteilt. Vertrauenswürdige "Guardians" stimmen gemeinsam ab, einen neuen Schlüssel zu autorisieren.

```
Alice verliert ihren Key
         ↓
Alice erstellt neues Key Pair
         ↓
Alice kontaktiert ihre Guardians
         ↓
┌─────────┬─────────┬─────────┬─────────┬─────────┐
│  Bob ✅ │ Carol ✅│ David ❌│  Eva ✅ │ Frank ❌│
│bestätigt│bestätigt│  (nicht  │bestätigt│  (nicht  │
│         │         │erreichb.)│         │erreichb.)│
└─────────┴─────────┴─────────┴─────────┴─────────┘
3 von 5 bestätigen → Neuer Key wird autorisiert
```

**Referenz: Vitalik Buterin's Social Recovery Wallet**
- Signing Key (tägliche Nutzung) + Guardian-Set (Recovery)
- Guardians sind normale Personen mit eigenen Wallets
- M-von-N Guardians bestätigen neuen Signing Key
- 1-3 Tage Wartezeit (Schutz gegen Social Engineering)
- Quelle: https://vitalik.eth.limo/general/2021/01/11/recovery.html

**Vorteile:**
- Kein Geheimnis wird je geteilt → kein Kollusionsrisiko
- Funktioniert auch bei Key-Kompromittierung
- Guardians können alten Key deaktivieren
- Natürlich dezentral
- Guardians brauchen kein spezielles Setup

**Nachteile:**
- DID ändert sich (bei did:key) → alle Verknüpfungen müssen migriert werden
- Braucht DID-Methode mit Key Rotation ODER ein Mapping-Layer
- Social Engineering Risiko
- Wartezeit nötig (Schutz, aber auch Hindernis)

---

## Vergleich: Wann welcher Ansatz?

| Szenario | Shamir | Guardians |
|----------|--------|-----------|
| Handy verloren | Seed rekonstruieren → gleiche DID | Neues DID, alte Verbindungen migrieren |
| Seed vergessen | Seed rekonstruieren | Neues DID |
| Key kompromittiert | **Hilft NICHT** | Alten Key deaktivieren, neuen autorisieren |
| Langfristige Sicherheit | Key bleibt gleich | Key Rotation möglich |
| Komplexität | Niedriger | Höher |
| Zeitbedarf Recovery | Sofort (wenn Shards da) | 1-3 Tage Wartezeit |

**Shamir löst Key-Verlust. Guardians lösen Key-Kompromittierung.** Zusammen decken sie alle Fälle ab.

---

## Unser Vorteil: WoT = Guardian-Netzwerk

In Vitaliks Modell muss man künstlich Guardians designieren. Bei uns **existieren sie bereits**: die Leute, die sich in-person verifiziert haben. Unsere Kontakte mit "Verifiziert"-Status sind natürliche Guardians.

```
In-Person Verification (Week 2)
         ↓
Verifizierte Kontakte
         ↓
Potentielle Guardians für Social Recovery
         ↓
Web of Trust = Recovery-Netzwerk
```

---

## Vorgeschlagene Architektur

### Drei Schutzschichten

```
Schicht 1: Selbstschutz (BIP39)
  → 12 Wörter aufschreiben
  → Optional: Encrypted Backup (USB-Stick, Tresor)
  → Abdeckung: Key-Verlust (einfachster Fall)

Schicht 2: Social Recovery - Shamir
  → Seed in Shards aufteilen
  → Shards an verifizierte Kontakte verteilen
  → 3-von-5 zur Rekonstruktion
  → Abdeckung: Key-Verlust wenn Zettel auch weg

Schicht 3: Guardian Recovery - Vouching
  → Verifizierte Kontakte als Guardians
  → Guardians bestätigen neues Key Pair
  → Alte Verifications auf neues DID migrieren
  → Abdeckung: Key-Kompromittierung
  → Braucht: Key Rotation (did:peer oder Mapping)
```

### Priorisierung

| Schicht | Wann implementieren | Aufwand |
|---------|-------------------|---------|
| **Schicht 1** | ✅ Bereits da (BIP39) | - |
| **Schicht 2** (Shamir) | Nächster Schritt | Mittel |
| **Schicht 3** (Guardians) | Später | Hoch (braucht Key Rotation) |

---

## Shamir-Implementation (nächster Schritt)

### User Flow

```
Setup (einmalig):
1. Alice öffnet "Recovery einrichten"
2. Wählt 5 verifizierte Kontakte als Custodians
3. Wählt Schwellwert: 3-von-5
4. App generiert 5 Shards aus ihrem Seed
5. Pro Custodian: QR-Code anzeigen → Custodian scannt
6. Custodian bestätigt Empfang
7. Shard wird beim Custodian verschlüsselt gespeichert

Recovery:
1. Alice hat neues Gerät, Seed verloren
2. Erstellt neue temporäre Identity
3. Kontaktiert 3+ Custodians (persönlich, Telefon, etc.)
4. Custodians öffnen "Recovery-Shard senden"
5. Shard per QR-Code oder verschlüsseltem Kanal übermitteln
6. App rekonstruiert Seed aus 3 Shards
7. Alice hat ihre Identity zurück
```

### Technische Bausteine

- **Shamir Library:** `@noble/secp256k1` oder `secrets.js-grempe` (JavaScript)
- **Shard-Format:** Verschlüsselt mit Public Key des Custodians
- **Transport:** QR-Code (in-person), oder verschlüsselte Nachricht
- **Storage:** In ContactStorage des Custodians (neues Feld `shards`)

### Offene Fragen

- Wie aktualisiert man Shards wenn sich das Custodian-Set ändert?
- Was wenn ein Custodian seinen eigenen Key verliert?
- Soll der Schwellwert konfigurierbar sein oder fix?
- Sollen Shards ein Ablaufdatum haben?

---

## Inspirationsquellen

| Projekt | Ansatz | Was wir lernen können |
|---------|--------|----------------------|
| **Dark Crystal** (SSB) | Shamir + P2P | UX für Shard-Verteilung, Custodian-Management |
| **Vitalik's Social Recovery** | Guardians | Guardian-Set-Management, Wartezeiten |
| **Argent Wallet** | Smart Contract Guardians | Mobile UX für Recovery |
| **KERI** | Pre-Rotation Keys | Key Rotation ohne zentralen Server |
| **Murmurations** | Email Reset | Was wir NICHT wollen (zentralisiert) |

---

## Zusammenhang mit DID-Methoden

Siehe [did-methoden-vergleich.md](./did-methoden-vergleich.md) für Details.

**Kurzfassung:**
- **Shamir** funktioniert mit jeder DID-Methode (Seed wird rekonstruiert → gleiche DID)
- **Guardians** brauchen Key Rotation → did:key allein reicht nicht
- **Hybrid** (did:key + did:peer): did:key als öffentliche Identität, did:peer für Beziehungen mit Rotation
- **Langfristig:** WoT-Layer methoden-agnostisch → verschiedene Nutzer können verschiedene Methoden nutzen

---

*Erstellt: 2026-02-07 | Kontext: Forschungs-Session mit Anton*
