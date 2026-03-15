# Glossar

> Begriffsdefinitionen für das Web of Trust

---

## A

### Attestation

Eine **signierte Aussage** einer Person über eine andere Person. Attestationen dokumentieren vergangene Ereignisse oder Fähigkeiten.

**Beispiel:** "Ben hat 3 Stunden im Gemeinschaftsgarten geholfen"

**Empfänger-Prinzip:** Die Attestation wird beim **Empfänger** (`to`) gespeichert, nicht beim Ersteller (`from`).

**Eigenschaften:**
- Immer von einem Nutzer (nicht von einer Gruppe)
- Wird beim Empfänger gespeichert
- Kann im Kontext einer Gruppe stehen
- Unveränderlich (Inhalt nicht änderbar)
- Empfänger kann ausblenden (`hidden=true`), aber nicht löschen
- Kryptographisch signiert vom Ersteller

Siehe auch: [Verifizierung](#verifizierung), [Empfänger-Prinzip](#empfänger-prinzip)

### Auto-Gruppe

Eine implizite Gruppe, die automatisch alle aktiven Kontakte eines Nutzers enthält. Wird für die Standard-Verschlüsselung von Content verwendet ("für alle meine Kontakte").

**Eigenschaften:**
- Genau eine pro Nutzer
- `activeMembers`: Kontakte mit Status "active", die nicht ausgeblendet sind
- `excludedMembers`: Ausgeblendete Kontakte (bleiben "active", aber nicht in der Gruppe)
- Group Key wird rotiert wenn Kontakte hinzukommen oder ausgeblendet werden

---

## C

### Claim

Der Freitext-Inhalt einer Attestation. Beschreibt, was attestiert wird.

**Beispiel:** "Hat beim Umzug geholfen - super zuverlässig!"

### Contact (Kontakt)

Eine Person, die ein Nutzer verifiziert hat. Kontakte haben einen Status:

| Status | Beschreibung |
| ------ | ------------ |
| pending | Einseitig verifiziert, wartet auf Gegenseite |
| active | Beidseitig verifiziert, in Auto-Gruppe |

> **Hinweis:** Das Ausblenden erfolgt über `excludedMembers` in der Auto-Gruppe, nicht über den Kontakt-Status. Ein ausgeblendeter Kontakt bleibt `active`.

### Content (Inhalt)

Verschlüsselte Daten, die Nutzer mit ihren Kontakten teilen. Typen:

- Kalender-Einträge
- Karten-Markierungen
- Projekte
- Attestationen

---

## D

### DID (Decentralized Identifier)

Eine global eindeutige Kennung für eine Identität, die ohne zentrale Registrierungsstelle funktioniert.

**Format im Web of Trust:**
```
did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
        │ └──────────────────────────────────────────────┘
        │                    Ed25519 Public Key
        └─ Multibase-Präfix (z = base58btc)
```

Der Public Key ist direkt im DID enthalten - kein Server-Lookup nötig.

Siehe auch: [did:key Verwendung](data-model/did-key-usage.md)

---

## E

### E2E-Verschlüsselung (End-to-End)

Verschlüsselung, bei der nur Sender und Empfänger die Nachricht lesen können. Der Server sieht nur verschlüsselte Blobs.

### Ed25519

Ein Algorithmus für digitale Signaturen, der im Web of Trust für die Schlüsselerzeugung verwendet wird. Bietet hohe Sicherheit bei kurzen Schlüssellängen (32 Bytes).

### Empfänger-Prinzip

Ein Kernprinzip des Web of Trust: **Verifizierungen und Attestationen werden beim Empfänger (`to`) gespeichert**, nicht beim Ersteller (`from`).

**Vorteile:**
- Empfänger kontrolliert, was über ihn veröffentlicht wird
- Keine Schreibkonflikte (jeder schreibt nur in seinen eigenen Datenspeicher)
- Attestationen können ausgeblendet werden (`hidden=true`)

**Beispiel:**
- Anna verifiziert Ben → Verification wird bei **Ben** gespeichert
- Ben attestiert Anna → Attestation wird bei **Anna** gespeichert

Siehe auch: [Attestation](#attestation), [Verifizierung](#verifizierung)

---

## G

### Group Key

Ein symmetrischer Schlüssel, der für die Verschlüsselung von Gruppen-Content verwendet wird. Wird bei Änderungen der Gruppenmitgliedschaft rotiert.

---

## I

### ID-Prüfwert

Eine verkürzte, menschenlesbare Darstellung einer DID für den Offline-Abgleich.

**Format:** `a7f3-82b1-c9d4-e5f6`

Wird verwendet, wenn kein Internet verfügbar ist und das Profil nicht geladen werden kann.

### Item

Eine einzelne Content-Einheit (Kalender-Eintrag, Karten-Markierung, etc.). Jedes Item hat einen eigenen symmetrischen Schlüssel (Item Key).

### Item Key

Ein symmetrischer AES-256-Schlüssel, der für die Verschlüsselung eines einzelnen Items verwendet wird. Der Item Key wird dann mit den Public Keys der Empfänger verschlüsselt.

---

## K

### Keychain / Keystore

Sicherer Speicher des Betriebssystems für kryptographische Schlüssel:

| Platform | Speicher |
| -------- | -------- |
| iOS | Keychain |
| Android | Keystore |
| Web | Web Crypto API + IndexedDB |

---

## M

### Mnemonic / Recovery-Phrase

Eine Liste von 12 Wörtern, aus der der Private Key deterministisch abgeleitet werden kann. Dient zur Wiederherstellung der Identität bei Geräteverlust.

**WICHTIG:** Wird nur einmal bei der ID-Erstellung angezeigt und muss vom Nutzer aufgeschrieben werden.

### MLS (Messaging Layer Security)

Ein Protokoll für sichere Gruppenkommunikation, das für die Gruppen-Verschlüsselung evaluiert wird.

---

## O

### Onboarding

Der Prozess, bei dem eine neue Person ins Netzwerk aufgenommen wird. Umfasst:

1. App installieren
2. Profil erstellen
3. ID generieren
4. Recovery-Phrase sichern (Quiz bestehen)
5. Erste Verifizierung

---

## P

### Pending

Zwischenzustand eines Kontakts, wenn nur eine Seite verifiziert hat. Wird zu "active" sobald die Gegenseite auch verifiziert.

### Private Key

Der geheime Schlüssel eines Nutzers. Wird nur lokal im Secure Storage gespeichert und verlässt nie das Gerät.

### Profil

Die öffentlichen Informationen eines Nutzers:

- Name (selbstgewählt)
- Foto (optional)
- Bio (optional)
- DID
- Public Key

### Proof

Ein kryptographischer Beweis, dass ein Dokument von einer bestimmten Person signiert wurde. Besteht aus Signatur und Metadaten.

### Public Key

Der öffentliche Schlüssel eines Nutzers. Wird im QR-Code geteilt und ermöglicht anderen, Daten für diesen Nutzer zu verschlüsseln.

---

## Q

### QR-Code

Zweidimensionaler Code zum Austausch von Identitätsinformationen. Varianten:

| Typ | Inhalt | Verwendung |
| --- | ------ | ---------- |
| Standard | DID + Public Key | Verifizierung |
| Invite | DID + Public Key + App-Link | Onboarding neuer Nutzer |

---

## R

### Recovery

Der Prozess, eine Identität auf einem neuen Gerät wiederherzustellen. Erfordert die Recovery-Phrase.

---

## S

### Selbst-Attestation

Eine Attestation, die ein Nutzer über sich selbst erstellt.

**Beispiel:** "Ich kann Fahrräder reparieren"

### Signatur

Kryptographischer Nachweis, dass ein Dokument von einer bestimmten Person erstellt wurde. Im Web of Trust werden Ed25519-Signaturen verwendet.

### Sync / Synchronisation

Der Prozess, Daten zwischen Geräten und dem Server abzugleichen. Funktioniert auch bei temporärer Offline-Nutzung.

### Sybil-Angriff

Ein Angriff, bei dem ein Angreifer viele gefälschte Identitäten erstellt. Das Web of Trust verhindert dies durch die Anforderung persönlicher Verifizierung.

---

## T

### Tag

Ein Schlagwort, das einer Attestation zugeordnet wird, um sie kategorisierbar und filterbar zu machen.

**Beispiele:** Garten, Helfen, Handwerk, Transport

---

## V

### Verifizierung

Die gegenseitige Bestätigung der Identität durch persönliches Treffen. Bestätigt nur "Das ist wirklich diese Person" - nicht mehr.

**Empfänger-Prinzip:** Die Verifizierung wird beim **Empfänger** (`to`) gespeichert, nicht beim Ersteller (`from`).

**Unterschied zu Attestation:**

| Verifizierung | Attestation |
| ------------- | ----------- |
| "Ich habe diese Person getroffen" | "Diese Person hat X getan" |
| Identitätsbestätigung | Vertrauensaufbau |
| Einmalig pro Kontakt | Beliebig viele möglich |
| Kann nicht ausgeblendet werden | Empfänger kann ausblenden |

Siehe auch: [Attestation](#attestation), [Empfänger-Prinzip](#empfänger-prinzip)

---

## W

### Web Crypto API

Browser-API für kryptographische Operationen. Ermöglicht sichere Schlüsselgenerierung und -speicherung im Web mit `extractable: false`.

---

## Siehe auch

- [README](../README.md) - Vision und Übersicht
- [Flows](flows/README.md) - Detaillierte Prozessbeschreibungen
- [Datenmodell](data-model/README.md) - Technische Strukturen
