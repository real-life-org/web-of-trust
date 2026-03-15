# Privacy

> Datenschutz-Überlegungen im Web of Trust

## Grundprinzipien

### Datenminimierung

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Nur erforderliche Daten werden erhoben:                    │
│                                                             │
│  ✅ Name (selbst gewählt)                                   │
│  ✅ Foto (optional)                                         │
│  ✅ Kontakte (nur verifizierte)                             │
│  ✅ Selbst erstellte Inhalte                                │
│                                                             │
│  ❌ Keine Telefonnummer                                     │
│  ❌ Keine E-Mail-Adresse                                    │
│  ❌ Keine Standortdaten (außer explizit in Items)           │
│  ❌ Kein Adressbuch-Upload                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Lokale Kontrolle

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Daten bleiben unter Nutzer-Kontrolle:                      │
│                                                             │
│  • Alle Daten lokal gespeichert                             │
│  • Export jederzeit möglich                                 │
│  • Löschung möglich (lokal + Server)                        │
│  • Kein Account beim Betreiber nötig                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Was der Server sieht

### Verschlüsselte Daten (kein Zugriff auf Inhalt)

| Datentyp | Server sieht |
|----------|--------------|
| Items | Verschlüsselter Blob |
| Attestation-Inhalt | Verschlüsselt |
| Profil-Details | Verschlüsselt |

### Metadaten (Server sieht)

| Metadatum | Beschreibung | Mitigation |
|-----------|--------------|------------|
| **IP-Adresse** | Bei jeder Verbindung | VPN empfehlen |
| **Timing** | Wann synchronisiert wird | - |
| **Nachrichtengröße** | Wie viel Daten | Padding möglich |
| **DID-Paare** | Wer mit wem kommuniziert | Teilweise ableitbar |

### Kontaktgraph

```mermaid
flowchart TD
    subgraph Server["Was der Server ableiten kann"]
        A[DID A] -->|"tauscht Daten mit"| B[DID B]
        A -->|"tauscht Daten mit"| C[DID C]
        B -->|"tauscht Daten mit"| C
    end

    Note[Server sieht NICHT wer A, B, C sind - nur DIDs]
```

**Risiko:** Social Graph ist teilweise ableitbar.

**Mitigation-Optionen:**
1. Padding (alle Nachrichten gleich groß)
2. Dummy-Traffic
3. Onion Routing (komplex)

**Aktuelle Entscheidung:** Akzeptiert als Trade-off für Usability.

---

## DSGVO-Konformität

### Rechte der Nutzer

| Recht | Umsetzung |
|-------|-----------|
| **Auskunft (Art. 15)** | Export-Funktion |
| **Berichtigung (Art. 16)** | Profil bearbeitbar |
| **Löschung (Art. 17)** | Lokale Löschung + Server-Request |
| **Datenübertragbarkeit (Art. 20)** | JSON/CSV Export |
| **Widerspruch (Art. 21)** | Keine Profilbildung |

### Besondere Kategorien

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Keine besonderen Kategorien erhoben:                       │
│                                                             │
│  ❌ Keine Gesundheitsdaten                                  │
│  ❌ Keine politischen Meinungen                             │
│  ❌ Keine religiösen Überzeugungen                          │
│  ❌ Keine biometrischen Daten (Profilbild = optional)       │
│                                                             │
│  Attestationen könnten sensible Infos enthalten             │
│  → Nutzer-Verantwortung, E2E-verschlüsselt                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Löschung

### Was gelöscht werden kann

| Datentyp | Löschbar? | Anmerkung |
|----------|-----------|-----------|
| Profil | Ja | Lokal + Server |
| Items | Ja (Soft Delete) | Lokal, Server-Markierung |
| Kontakte | Ausblenden | Via Auto-Gruppe excludedMembers |
| Verifizierungen | Nein | Immutable, beim Empfänger gespeichert |
| Attestationen | Ausblendbar | Empfänger kann `hidden=true` setzen |

### Empfänger-Prinzip und Datenhoheit

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Design-Entscheidung: Empfänger-Prinzip                     │
│                                                             │
│  Verifizierungen und Attestationen werden beim              │
│  EMPFÄNGER (to) gespeichert, nicht beim Sender (from).      │
│                                                             │
│  Vorteile:                                                  │
│  • Empfänger kontrolliert, was über ihn veröffentlicht wird │
│  • Keine Schreibkonflikte (jeder schreibt nur bei sich)     │
│  • Attestationen können ausgeblendet werden (hidden=true)   │
│                                                             │
│  Einschränkungen:                                           │
│  • Verifizierungen können nicht ausgeblendet werden         │
│    (steuern Kontakt-Status)                                 │
│  • Attestationen können nicht gelöscht werden, nur hidden   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Warum Verifizierungen/Attestationen nicht löschbar

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Design-Entscheidung:                                       │
│                                                             │
│  Verifizierungen und Attestationen sind signierte Aussagen  │
│  über die Vergangenheit:                                    │
│                                                             │
│  "Ich habe Anna am 05.01.2025 getroffen"                    │
│  "Ben hat mir beim Umzug geholfen"                          │
│                                                             │
│  Diese Fakten können nicht "ungeschehen" gemacht werden.    │
│                                                             │
│  Aber: Der Empfänger kann Attestationen AUSBLENDEN          │
│  (hidden=true) - sie sind dann nur für ihn selbst sichtbar. │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Account-Löschung

```mermaid
flowchart TD
    Delete[Account löschen] --> Local[Lokal löschen]
    Delete --> Server[Server-Request]

    Local --> L1[Private Key löschen]
    Local --> L2[Alle lokalen Daten löschen]

    Server --> S1[Verschlüsselte Blobs löschen]
    Server --> S2[DID aus Index entfernen]

    Note[Verifizierungen bei Kontakten bleiben - sind deren Daten]
```

---

## Anonymität vs. Pseudonymität

### Aktueller Stand: Pseudonymität

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Nutzer sind PSEUDONYM:                                     │
│                                                             │
│  • DID = zufälliges Pseudonym                               │
│  • Name = selbst gewählt (kann falsch sein)                 │
│  • Aktivitäten = einem DID zuordenbar                       │
│                                                             │
│  Nutzer sind NICHT anonym:                                  │
│  • Verifizierung = jemand kennt die echte Person            │
│  • Aktivitätsmuster = analysierbar                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### De-Anonymisierung möglich durch

| Methode | Risiko |
|---------|--------|
| Verifizierender kennt echte Identität | Hoch |
| Attestations-Inhalte | Mittel |
| Metadaten-Korrelation | Mittel |
| IP-Analyse | Mittel |

---

## Privacy by Design

### Implementiert

| Prinzip | Umsetzung |
|---------|-----------|
| **Minimierung** | Nur nötige Daten |
| **Verschlüsselung** | E2E für alle Inhalte |
| **Lokale Speicherung** | Daten auf Gerät |
| **Keine Accounts** | Kein Betreiber-Login |
| **Export** | Volle Datenportabilität |

### Offen

| Prinzip | Status |
|---------|--------|
| **Metadaten-Schutz** | Teilweise (Trade-off) |
| **Unlinkability** | Nicht vollständig |
| **Plausible Deniability** | Nicht implementiert |

---

## Empfehlungen für Nutzer

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Für maximale Privacy:                                      │
│                                                             │
│  ✅ Pseudonymes Profil verwenden                            │
│  ✅ Kein echtes Foto hochladen                              │
│  ✅ VPN verwenden                                           │
│  ✅ Nur vertrauenswürdige Personen verifizieren             │
│  ✅ Vorsicht bei Attestations-Inhalten                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Weiterführend

- [Threat Model](threat-model.md) - Sicherheitsrisiken
- [Export-Flow](../flows/08-export-nutzer-flow.md) - Daten exportieren
