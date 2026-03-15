# Encrypted Blob Store

> Konzept fur verschlusselte Binardaten (Profilbilder, Anhange) im Web of Trust

## Problem

Binardaten (Bilder, Dokumente) durfen **nicht** in Automerge-Docs landen:
- Jeder `transact`-Delta enthalt die Binardaten als Change
- `requestSync` schickt den gesamten Doc-Snapshot inkl. aller Blobs
- Ein Space mit 10 Profilbildern a 100KB = 1MB pro Sync

Gleichzeitig wollen Nutzer bestimmte Daten (z.B. Profilbild) nicht offentlich machen,
aber trotzdem mit vertrauensvollen Kontakten teilen.

## Drei Sichtbarkeitsstufen

| Stufe | Beispiel | Speicherort | Zugriff |
|-------|----------|-------------|---------|
| **Offentlich** | Name, Bio | wot-profiles (`GET /p/{did}`) | Jeder |
| **Kontakte** | Profilbild, Telefon | Encrypted Blob Store | Wer den Key hat |
| **Space** | Projekt-Dateien | Encrypted Blob Store (Space-Key) | Space-Mitglieder |

## Architektur

```
Nutzer                          Server (wot-profiles)
------                          ---------------------

Profilbild (Klartext)
    |
    v
AES-256-GCM verschlusseln
(mit "Kontakt-Blob-Key")
    |
    v
PUT /blob/{did}/{hash}  ------>  Speichert Ciphertext
                                 (versteht Inhalt nicht)

Kontakt will Bild sehen:
GET /blob/{did}/{hash}  <------  Liefert Ciphertext
    |
    v
AES-256-GCM entschlusseln
(mit Kontakt-Blob-Key)
    |
    v
Profilbild (Klartext)
```

## Key-Verteilung

Der Blob-Key wird **einmalig** bei Kontaktaufnahme per ECIES geteilt:

```
Anton verifiziert Bob
    |
    v
ECIES(blob-key, bob-encryption-pubkey) ---> Bob
    |
    Bob speichert Antons blob-key lokal
    Bob kann ab jetzt alle privaten Blobs von Anton lesen
```

### Vorteile gegenuber Messaging-Ansatz

| Aspekt | Messaging (schlecht) | Blob Store (besser) |
|--------|---------------------|---------------------|
| Bild andern | n Nachrichten an n Kontakte | 1 PUT, Kontakte holen selbst |
| Neuer Kontakt | Nochmal schicken | Key teilen, Kontakt holt |
| Kontakt offline | Redelivery-Problem | Holt wenn online |
| Cache geloscht | Nochmal schicken | Nochmal holen |
| Bandbreite | n x Bildgrosse | 1 x Bildgrosse + n x Keygrosse |

### Warum nicht einfach das Bild fur jeden Kontakt einzeln verschlusseln?

Das ware O(n) Verschlusselungsoperationen pro Blob-Upload. Stattdessen:
- **1 symmetrischer Key pro Sichtbarkeitsstufe** (z.B. "Kontakte-Key")
- Blob wird 1x mit diesem Key verschlusselt
- Der Key wird per ECIES an jeden Kontakt geteilt (einmalig, bei Kontaktaufnahme)
- Key-Rotation bei Kontakt-Entfernung (analog zu Space Group Key Rotation)

## Referenzierung

Im Automerge-Doc oder Profil-JSON steht nur die Referenz:

```json
{
  "avatar": {
    "hash": "sha256:abc123...",
    "scope": "contacts"
  }
}
```

Der Client lost auf:
1. `hash` -> `GET /blob/{did}/{hash}`
2. `scope: "contacts"` -> lokalen Kontakt-Blob-Key verwenden
3. Entschlusseln + anzeigen

## Integration mit wot-profiles

wot-profiles wird um einen Blob-Endpunkt erweitert:

```
GET  /p/{did}              -- Offentliches Profil (JSON, Klartext)
PUT  /p/{did}              -- Offentliches Profil aktualisieren (JWS-signiert)

GET  /blob/{did}/{hash}    -- Verschlusselten Blob abrufen
PUT  /blob/{did}/{hash}    -- Verschlusselten Blob hochladen (JWS-signiert)
DELETE /blob/{did}/{hash}  -- Blob loschen (JWS-signiert)
```

Der Server speichert nur Ciphertext. Er kann weder den Inhalt noch den Typ
(Bild vs. Dokument) erkennen.

## Scope-Keys

| Scope | Key | Geteilt mit | Rotation |
|-------|-----|-------------|----------|
| `contacts` | Kontakt-Blob-Key | Alle verifizierten Kontakte | Bei Kontakt-Entfernung |
| `space:{id}` | Space Group Key | Space-Mitglieder | Bei Member-Remove (schon implementiert) |
| `public` | Kein Key (Klartext) | Alle | Nie |

Fur Spaces konnen wir den bestehenden **GroupKeyService** wiederverwenden --
der Space Group Key verschlusselt dann sowohl Automerge-Changes als auch Blobs.

## Prioritat

- **POC:** Nicht nötig. Profilbilder offentlich uber wot-profiles oder gar nicht.
- **MVP:** Kontakt-Blob-Key fur private Profilbilder implementieren.
- **Produktion:** Scope-Keys, Space-Blobs, Key-Rotation.

## Abgrenzung zu Item-Keys und Auto-Gruppe

### Zwei Verschlusselungsmechanismen — bewusst getrennt

Das WoT nutzt zwei komplementare Verschlusselungsansatze:

|  | Item-Keys | Kontakt-Blob-Key (Blob Store) |
|--|-----------|-------------------------------|
| **Datentyp** | Strukturierte Items (Kalender, Notizen, Attestationen) | Binardaten (Profilbilder, Thumbnails) |
| **Granularitat** | Pro Item wahlbar (`contacts`, `selective`, `groups`) | Pro Scope (alle Kontakte oder Space) |
| **Selektive Sichtbarkeit** | Ja — Item X nur fur Anna und Ben | Nein — alle Kontakte oder niemand |
| **Kosten pro Datum** | O(N) Verschlusselungen pro Item | O(1) pro Blob |
| **Key-Verteilung** | Pro Item, pro Empfanger | Einmalig bei Kontaktaufnahme |

### Rolle der Auto-Gruppe

Die [Auto-Gruppe](../data-model/entitaeten.md#auto-gruppe) ist **keine Verschlusselungsmechanik**,
sondern eine **Empfangerliste**: Sie beantwortet die Frage *"Wer sind alle meine aktiven Kontakte?"*

- Bei **Item-Keys** mit `visibility: contacts`: Item-Key wird fur jeden in der Auto-Gruppe gewrappt
- Beim **Blob Store** mit `scope: contacts`: Kontakt-Blob-Key wird einmalig an jeden in der Auto-Gruppe verteilt

Der Kontakt-Blob-Key ist konzeptionell ein **Group Key fur die Auto-Gruppe** —
analog zum Space Group Key, nur fur die implizite Gruppe aller aktiven Kontakte.
Die `excludedMembers`-Mechanik der Auto-Gruppe gilt fur beide Ansatze:
- Item-Keys: Ausgeblendeter Kontakt bekommt keinen neuen Item-Key
- Blob Store: Key-Rotation bei Kontakt-Entfernung (analog zu Space Group Key Rotation)

### Warum nicht einfach Item-Keys auch fur Blobs?

Item-Keys sind fur **viele kleine Items** optimiert, die sich selten andern.
Ein Profilbild ist ein **einzelner grosser Blob**, der sich selten andert —
aber von vielen Kontakten oft abgerufen wird. Dafur ist ein geteilter Scope-Key effizienter:
- Kein O(N) pro Blob-Upload
- Kein Redelivery-Problem bei Offline-Kontakten
- Kontakte holen den Blob selbst, wenn sie online sind

## Abgrenzung

Dieser Blob Store ist **kein** generischer Dateispeicher. Er ist optimiert fur:
- Kleine bis mittlere Blobs (Profilbilder, Thumbnails: < 1MB)
- Seltene Schreibvorgange (Profilbild andern)
- Haufige Lesevorgange (Kontakt zeigt Profilbild an)

Fur grosse Dateien (Videos, Dokumente) in Spaces ware ein anderer Ansatz notig
(z.B. Chunking + Content-Addressing), aber das ist nicht Teil des aktuellen Scope.
