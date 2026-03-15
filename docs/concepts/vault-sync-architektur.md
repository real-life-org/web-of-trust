# Vault Sync Architektur

> Wie Automerge-Docs zwischen Geräten, Peers und dem Vault synchronisiert werden.
> Stand: 2026-03-13

## Überblick

Das System hat **drei Sync-Patterns** für unterschiedliche Zwecke:

| Pattern | Transport | Datenformat | Zweck |
|---------|-----------|-------------|-------|
| **Peer-to-Peer** | WebSocket (wot-relay) | Automerge Sync-Messages (inkrementell) | Live-Sync zwischen Peers |
| **Vault** | HTTPS (wot-vault) | `Automerge.save()` Snapshot (kompakt) | Multi-Device Persistenz, Offline-Restore |
| **Invite** | WebSocket (wot-relay) | `Automerge.save()` Snapshot (kompakt) | Initiales Teilen eines Space |

## 1. Peer-to-Peer Sync (Live)

Automerge-repo handhabt den Live-Sync intern über den `EncryptedMessagingNetworkAdapter`:

```
docHandle.change(fn)
  → Automerge erzeugt inkrementelle Sync-Message
  → EncryptedMessagingNetworkAdapter.send()
  → AES-256-GCM encrypt mit Group-Key
  → WebSocket → wot-relay → anderer Peer
  → decrypt → Automerge mergt inkrementell
```

- **Messages sind klein** — nur die Diffs, nicht der volle State
- **Automerge übernimmt alles** — Conflict Resolution, Ordering, Deduplication
- **Verschlüsselung pro Space** — jeder Space hat seinen eigenen AES-256-GCM Group-Key

## 2. Vault Sync (Persistenz)

Der Vault (`wot-vault`) ist ein **opaker E2E-verschlüsselter Doc Store**. Er sieht nur Ciphertext.

### Architektur

```
Client                              Vault (Server)
──────                              ──────────────
Automerge.save(doc)                 SQLite (WAL)
  → AES-256-GCM encrypt              ├── doc_snapshots (1 pro Doc, UPSERT)
  → HTTP PUT /docs/{id}/snapshot      └── doc_changes (Append-only, wird bereinigt)
```

### Push-Strategie: Debounced Snapshot Replace

- **Trigger**: Jede Doc-Änderung startet einen 5s Debounce-Timer
- **Format**: `Automerge.save(doc)` — kompakter Snapshot ohne unnötige History
- **Übertragung**: `PUT /docs/{id}/snapshot` — UPSERT, ersetzt vorherigen Snapshot
- **Server-seitig**: Alte Changes (`seq ≤ upToSeq`) werden bei Snapshot-UPSERT gelöscht

### Warum Snapshot statt Incremental?

Der Vault hat eine `POST /changes` API für inkrementelle Pushes, die wir bewusst **nicht nutzen**:

1. **E2E-Encryption**: Der Server kann nicht in den Automerge-State reinschauen.
   Inkrementelle Pushes (`saveSince(doc, heads)`) erfordern Head-Tracking, das bei
   verschlüsselten Daten über den Server hinweg nicht möglich ist.
2. **Kompakte Docs**: Unsere Docs sind klein (2-50 KB). Ein Full-Snapshot-Push bei
   jeder Änderung ist bei diesen Größen vernachlässigbar.
3. **Einfachheit**: Snapshot-Replace ist idempotent, hat keine Ordering-Probleme,
   und der Client muss keinen State über frühere Pushes tracken.

### Restore-Strategie: Vault-First

```
initPersonalDoc() / restoreSpacesFromMetadata()
  1. Vault abrufen: GET /docs/{id}/changes → Snapshot + ggf. Changes
  2. Decrypt + Automerge.load() / repo.import()
  3. Fallback: IndexedDB (repo.find mit Timeout)
  4. Fallback: Migration aus alter DB / neues leeres Doc
```

Vault-First ist schneller als IndexedDB, weil:
- Vault liefert **einen** kompakten Snapshot (HTTP Fetch ~200-700ms)
- IndexedDB kann 40+ Incremental-Chunks haben, die Automerge einzeln laden und mergen muss

## 3. Automerge.save() Semantik

### Was save() tut

`Automerge.save(doc)` erzeugt ein **komprimiertes Binary** das den gesamten Doc-State
enthält — inklusive Change-History, aber in einem hochkomprimierten Format.

### Gemessene Größen (wot-core Tests, 2026-03-13)

**Szenario 1: 100 verschiedene Items hinzufügen**
```
 20 changes:  1.251 bytes
 40 changes:  1.886 bytes
 60 changes:  2.235 bytes
 80 changes:  2.285 bytes
100 changes:  2.745 bytes

save(doc):          2.745 bytes (mit History)
save(from(state)):  2.560 bytes (ohne History)
Ratio: 1.1x — History-Overhead vernachlässigbar!
```

**Szenario 2: Gleiches Feld 100x überschreiben**
```
 20 overwrites:   719 bytes
 40 overwrites:   915 bytes
 60 overwrites: 1.239 bytes
 80 overwrites:   973 bytes
100 overwrites: 1.085 bytes

save(fresh):        170 bytes (ohne History)
Ratio: ~6.4x — History wächst bei wiederholten Overwrites
```

### Fazit für unseren Use-Case

- **Contacts/Spaces/Attestations hinzufügen** → History-Overhead <10%, irrelevant
- **Profile-Updates** (Name, Bio) → Moderat, akzeptabel
- **Outbox** (Items rein/raus) → Könnte wachsen, aber Outbox wird regelmäßig geleert

**`Automerge.save()` ist für unsere Docs optimal.** Kein History-Stripping nötig.

## 4. Automerge-repo Internes Storage

Automerge-repo verwaltet die lokale Persistenz (IndexedDB) selbstständig:

### Chunk-Struktur
```
[documentId, "snapshot", hash]      — Kompakter Full-State
[documentId, "incremental", hash]   — Einzelne Changes seit letztem Snapshot
[documentId, "sync-state", peerId]  — Sync-State pro Peer
```

### Automatische Compaction
- **Trigger**: Wenn Summe der Incremental-Chunks ≥ Snapshot-Größe
- **Aktion**: Neuer Snapshot via `Automerge.save()`, alte Chunks löschen
- **Ergebnis**: IndexedDB wächst nicht unbegrenzt

### save() vs saveIncremental() vs saveSince()
| Funktion | Was sie tut | Wer nutzt sie |
|----------|------------|---------------|
| `save(doc)` | Full State, komprimiert | Wir (Vault Push), repo.export() |
| `saveSince(doc, heads)` | Diff seit bestimmten Heads | automerge-repo intern (IndexedDB Incrementals) |
| `saveIncremental(doc)` | Diff seit letztem Aufruf (interner State) | Niemand bei uns |

### repo.export() vs Automerge.save()
**Identisch** — `repo.export()` ruft intern `Automerge.save(handle.doc())` auf.
Wir nutzen `Automerge.save()` direkt, weil wir bereits Zugriff auf das Doc haben.

## 5. Encryption-Schichten

### Personal Doc
```
Schlüssel:  HKDF(masterKey, 'personal-doc-v1')
Algorithmus: AES-256-GCM
Scope:      Nur eigene Geräte (gleicher Mnemonic → gleicher Key)
```

### Shared Spaces
```
Schlüssel:  AES-256 Group-Key (pro Space, pro Generation)
Algorithmus: AES-256-GCM
Rotation:   Bei removeMember() → neue Generation, alter Key bleibt für Decrypt
Verteilung: X25519 ECIES verschlüsselt pro Empfänger
```

### Vault-Server sieht nur
```
PUT /docs/{id}/snapshot
  Body: { data: "base64(nonceLen + nonce + AES-GCM-ciphertext)", upToSeq: N }
```
Kein Plaintext, keine Metadata, keine Automerge-Strukturen.

## 6. Bekannte Limitierungen

### Vault pusht immer Full State
Bei sehr aktiven Spaces (viele Änderungen pro Minute) wird alle 5s der
komplette State gepusht. Für Docs <50KB ist das akzeptabel. Für größere Docs
(z.B. mit eingebetteten Daten) sollte über inkrementelle Pushes nachgedacht werden.

### Kein Server-seitiges Merging
Der Vault kann nicht mergen — er ersetzt nur Snapshots. Wenn zwei Devices
gleichzeitig pushen, gewinnt der letzte Push. Das ist akzeptabel, weil:
- Automerge-repo synchronisiert Devices in Echtzeit über den Relay
- Der Vault ist nur Backup, nicht primäre Sync-Quelle
- Beim nächsten Push nach einem Live-Merge enthält der Snapshot den gemergten State

### History wächst bei Overwrites
`Automerge.save()` enthält Change-History. Bei häufigen Überschreibungen des gleichen
Felds (z.B. Outbox, Counter) kann das Binary 5-7x größer sein als der reine State.
Für unsere aktuellen Doc-Größen ist das irrelevant.

## 7. Zukunft: Subduction

[Subduction](https://www.inkandswitch.com/) (Ink & Switch, pre-alpha) ist Automerge's
nächste Generation mit:
- **Encryption-native** Sync (Sedimentree)
- **Inkrementeller E2E-Sync** ohne dass der Server in den State reinschauen muss
- **Ed25519-kompatibel** (passt zu unserem DID-System)

Subduction würde unser Vault-Pattern durch echten inkrementellen E2E-Sync ersetzen.
Frühestens produktionsreif: Ende 2026/2027.
