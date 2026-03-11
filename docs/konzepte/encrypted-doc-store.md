# Encrypted Doc Store

> E2E-verschlüsselter Document Store für Automerge-Docs im wot-relay

## Problem

Automerge-Docs (Shared Spaces) werden aktuell nur über Peer-to-Peer-Sync verfügbar gemacht:
Wenn Alice einen Space mit Bob teilt, synct Alice direkt mit Bob über den wot-relay als
Message-Router. **Wenn alle Peers offline sind, ist das Doc für ein neues Gerät nicht erreichbar.**

Konkretes Szenario:
1. Alice erstellt Space, fügt Bob und Carla hinzu
2. Carla loggt sich auf neuem Gerät ein
3. Personal-Doc synct → Carla kennt den Space (Metadaten + Group Key)
4. Aber: Das Space-Doc liegt auf keinem Server — nur bei Alice und Bob lokal
5. Alice und Bob sind offline → **Carla hat ein leeres Space-Doc**

## Lösung: Append-basierter Encrypted Doc Store

Der wot-relay wird um HTTP-Endpoints erweitert, die verschlüsselte Automerge-Changes
als append-only Log speichern. Der Server versteht weder Automerge noch den Inhalt —
er speichert opake verschlüsselte Blobs.

```
Client                              wot-relay
  │                                     │
  ├── POST /docs/{docId}/changes ─────→ │  Verschlüsselten Change appendieren
  │                                     │
  ├── GET  /docs/{docId}/changes ─────→ │  Alle Changes seit Sequenz N abrufen
  │                                     │
  ├── PUT  /docs/{docId}/snapshot ────→ │  Kompaktierten Snapshot speichern
  │                                     │  (ersetzt alle bisherigen Changes)
  │                                     │
  ├── GET  /docs/{docId}/snapshot ────→ │  Letzten Snapshot abrufen
  │                                     │
  └── GET  /docs/{docId}/info ────────→ │  Metadaten (Sequenz, Größe, letzte Änderung)
```

### Warum append-only statt Blob-Store?

| Aspekt | Blob-Store (PUT/GET) | Append-Log |
|--------|---------------------|------------|
| Concurrent Writes | Last-write-wins (Datenverlust) | Alle Changes erhalten |
| Merge | Client muss ganzes Doc laden | Client merged nur neue Changes |
| Bandbreite | Immer ganzes Doc | Nur Deltas |
| Zukunft (Subduction) | Inkompatibel | Gleiche Semantik |
| Kompaktierung | Nicht nötig | Optional (Snapshot) |

## Architektur

### Datenfluss

```
Alice ändert Space-Doc lokal
    │
    ├── 1. Automerge erzeugt Change (binär)
    ├── 2. Change mit Group Key verschlüsseln (AES-256-GCM)
    ├── 3. POST /docs/{docId}/changes + Capability-Token
    │
    ▼
wot-relay speichert verschlüsselten Chunk
    │
    ▼
Carla (neues Gerät) will Space laden
    │
    ├── 1. Personal-Doc synct → Space-Metadaten (docId, Group Key) bekannt
    ├── 2. GET /docs/{docId}/changes?since=0 + Capability-Token
    ├── 3. Changes mit Group Key entschlüsseln
    └── 4. Automerge.loadIncremental() → Doc materialisiert
```

### Verschlüsselung

Jeder Change wird einzeln verschlüsselt — gleiche Methode wie beim bestehenden
Peer-to-Peer-Sync über `EncryptedSyncService`:

```typescript
// Push
const binary = Automerge.saveIncremental(doc)
const encrypted = await EncryptedSyncService.encryptChange(
  binary, groupKey, spaceId, generation, myDid
)
// POST /docs/{docId}/changes → { ciphertext, nonce, generation, fromDid }

// Pull
const response = await fetch(`/docs/${docId}/changes?since=${lastSeq}`)
const chunks = await response.json()
for (const chunk of chunks) {
  const binary = await EncryptedSyncService.decryptChange(chunk, groupKey)
  Automerge.loadIncremental(doc, binary)
}
```

## Authentifizierung: Signierte Capability-Tokens

Der Relay hat keine ACL-Datenbank. Stattdessen verifiziert er **signierte Capability-Tokens**
— dezentral, stateless, delegierbar.

### Capability-Token Format

```typescript
interface DocCapability {
  docId: string            // Welches Dokument
  grantedTo: string        // DID des Empfängers
  permissions: ('read' | 'write')[]
  grantedBy: string        // DID des Ausstellers
  delegatable: boolean     // Darf weiter-delegieren?
  exp: number              // Ablaufzeit (Unix timestamp)
}
```

Der Token wird als JWS signiert (Ed25519, via `WotIdentity.signJws()`).

### Flow

```
1. Alice erstellt Space
   └── Generiert Capabilities für Bob und Carla:
       { docId: "abc", grantedTo: "did:key:bob", permissions: ["read","write"],
         grantedBy: "did:key:alice", delegatable: true, exp: ... }
       Signiert mit Alice's Ed25519-Key → JWS

2. Bob und Carla speichern Capability im Personal-Doc

3. Bob will Changes pushen:
   POST /docs/{docId}/changes
   Authorization: Bearer <Bob's Identity-JWS>
   X-Capability: <Alice's signierte Capability für Bob>

4. Relay verifiziert:
   a) Identity-JWS → Bob ist Bob (Public Key aus did:key)
   b) Capability-JWS → Alice hat Bob "write" auf docId gewährt
   c) Alice's Public Key aus did:key → Signatur gültig
   d) Capability nicht abgelaufen
   → Request erlaubt
```

### Delegation

```
Alice (Creator)
  └── signiert Capability für Bob (delegatable: true)
        └── Bob signiert Capability für Dave
              └── Dave's Request enthält Chain: [Alice→Bob, Bob→Dave]
                  Relay verifiziert die gesamte Chain
```

### Revocation

Capability-Revocation ist in dezentralen Systemen schwierig. Wir lösen es über
**doppelte Sicherheit**:

1. **Kryptografisch:** Bei Member-Remove wird der Group Key rotiert.
   Entferntes Mitglied kann neue Changes nicht mehr entschlüsseln — selbst wenn
   es noch eine gültige Capability hat.

2. **Capability-Ablauf:** Tokens haben eine begrenzte Gültigkeit (z.B. 30 Tage).
   Mitglieder erneuern automatisch. Entfernte Mitglieder bekommen keine neuen Tokens.

3. **Optionale Revocation-Liste:** Für sofortige Sperrung kann der Creator eine
   signierte Revocation an den Relay senden. Niedrige Priorität für MVP.

## SQLite Schema

```sql
-- Append-only Change Log
CREATE TABLE doc_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  seq INTEGER NOT NULL,          -- Monoton steigende Sequenznummer pro Doc
  data BLOB NOT NULL,            -- Verschlüsselter Change (opak)
  author_did TEXT NOT NULL,      -- Wer hat gepushed
  created_at TEXT NOT NULL,
  UNIQUE(doc_id, seq)
);

CREATE INDEX idx_doc_changes_lookup ON doc_changes (doc_id, seq);

-- Kompaktierte Snapshots (optional, ersetzt alle Changes bis seq)
CREATE TABLE doc_snapshots (
  doc_id TEXT NOT NULL,
  data BLOB NOT NULL,            -- Verschlüsselter Snapshot (opak)
  up_to_seq INTEGER NOT NULL,    -- Snapshot enthält alle Changes bis hier
  author_did TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id)
);
```

### Kompaktierung

Wenn ein Client einen Snapshot pushed:
1. `PUT /docs/{docId}/snapshot` mit `upToSeq: N`
2. Server speichert Snapshot, löscht alle Changes mit `seq <= N`
3. Zukünftige `GET /changes` liefern: Snapshot + Changes nach N

## HTTP-Endpoints

### POST /docs/{docId}/changes

Neuen verschlüsselten Change appendieren.

```
Request:
  Authorization: Bearer <Identity-JWS>
  X-Capability: <Capability-JWS> (ggf. mit Chain)
  Content-Type: application/octet-stream
  Body: <verschlüsselter Change als Binary>

  Oder als JSON:
  Content-Type: application/json
  Body: { "data": "<base64>", "generation": 0 }

Response: 201 Created
  { "seq": 42, "docId": "abc" }
```

### GET /docs/{docId}/changes?since={seq}

Changes seit einer bestimmten Sequenznummer abrufen.

```
Request:
  Authorization: Bearer <Identity-JWS>
  X-Capability: <Capability-JWS>

Response: 200 OK
  {
    "docId": "abc",
    "snapshot": { "data": "<base64>", "upToSeq": 10 } | null,
    "changes": [
      { "seq": 11, "data": "<base64>", "authorDid": "did:key:...", "createdAt": "..." },
      { "seq": 12, "data": "<base64>", "authorDid": "did:key:...", "createdAt": "..." }
    ]
  }
```

Wenn `since=0` und ein Snapshot existiert: Snapshot + Changes nach Snapshot.
Wenn `since > 0`: Nur Changes nach `since`.

### PUT /docs/{docId}/snapshot

Kompaktierten Snapshot speichern. Löscht alle Changes bis `upToSeq`.

```
Request:
  Authorization: Bearer <Identity-JWS>
  X-Capability: <Capability-JWS> (braucht "write")
  Content-Type: application/json
  Body: { "data": "<base64>", "upToSeq": 42 }

Response: 200 OK
  { "docId": "abc", "upToSeq": 42 }
```

### GET /docs/{docId}/info

Metadaten ohne Daten — für Client-Entscheidungen (brauche ich Pull?).

```
Response: 200 OK
  { "docId": "abc", "latestSeq": 42, "snapshotSeq": 10, "totalSize": 102400 }
```

## Integration in bestehenden wot-relay

### Server-Seite

Der wot-relay nutzt aktuell einen reinen `WebSocketServer`. Für HTTP-Endpoints wird
ein minimaler HTTP-Server auf dem gleichen Port ergänzt:

```typescript
import { createServer } from 'http'
import { WebSocketServer } from 'ws'

const httpServer = createServer(handleHttpRequest)
const wss = new WebSocketServer({ server: httpServer })

httpServer.listen(PORT)
```

Die JWS-Verifikation nutzt `@noble/ed25519` (bereits Dependency von wot-core)
und die `did:key`-Auflösung aus `wot-core/crypto/did.ts`.

### Client-Seite (Demo-App)

Neuer Service `DocStoreClient`:

```typescript
class DocStoreClient {
  constructor(
    private baseUrl: string,     // https://relay.utopia-lab.org
    private identity: WotIdentity
  )

  // Nach jedem Space-Doc-Change
  async pushChange(docId: string, encryptedData: Uint8Array, capability: string): Promise<number>

  // Beim Login auf neuem Gerät / Space-Discovery
  async pullChanges(docId: string, sinceSeq: number, capability: string): Promise<EncryptedChange[]>

  // Periodisch (z.B. alle 100 Changes)
  async pushSnapshot(docId: string, encryptedData: Uint8Array, upToSeq: number, capability: string): Promise<void>
}
```

### Capability-Verteilung

Capabilities werden bei Space-Operationen erstellt und im Personal-Doc gespeichert:

```typescript
// createSpace() → Capability für jedes Mitglied generieren + signieren
// handleSpaceInvite() → empfangene Capability im Personal-Doc speichern
// addMember() → neue Capability generieren + per Messaging senden
```

## Abgrenzung

### Encrypted Doc Store vs. Encrypted Blob Store

| | Doc Store (dieses Dokument) | Blob Store (encrypted-blob-store.md) |
|--|----------------------------|-------------------------------------|
| **Datentyp** | Automerge-Docs (CRDT) | Binärdaten (Bilder, Dateien) |
| **Struktur** | Append-only Change Log | Einzelne Blobs (PUT/GET) |
| **Merge** | Automerge merged Changes | Kein Merge (overwrite) |
| **Schlüssel** | Space Group Key | Kontakt-Blob-Key / Space Key |
| **Auth** | Capability-Tokens | JWS-signierte Requests |
| **Größe** | Klein-mittel (KB-MB) | Klein-groß (KB-MB) |

Beide könnten auf der gleichen Infrastruktur laufen (gleicher Server, gleiche SQLite-DB),
sind aber konzeptionell verschieden.

### Doc Store vs. WebSocket-Sync

Der Doc Store **ersetzt nicht** den bestehenden WebSocket-Sync — er ergänzt ihn:

| | WebSocket-Sync (Messaging) | Doc Store (HTTP) |
|--|---------------------------|-----------------|
| **Wann** | Peers online (Echtzeit) | Peers offline (Fallback) |
| **Latenz** | Sofort | Polling / Pull-basiert |
| **Protokoll** | Automerge Sync Protocol | Append-only Changes |
| **Server-Rolle** | Blind Message Router | Blind Blob Store |

Langfristig (Subduction) werden beide durch ein einheitliches Sync-Protokoll ersetzt,
das E2E-verschlüsselt und server-persistent ist.

## Zukunft: Migration zu Subduction

Der Append-basierte Doc Store ist bewusst als **Brücke zu Subduction** designed:

| Aspekt | Unser Doc Store | Subduction |
|--------|----------------|------------|
| Datenstruktur | Append-only Log | Sedimentree (tiefenbasiert) |
| Sync | Pull (HTTP) | Push + Pull (WebSocket/QUIC) |
| Diffing | Sequenznummer | Fingerprint-Reconciliation |
| Encryption | AES-256-GCM (EncryptedSyncService) | Keyhive (BeeKEM CGKA) |
| Auth | Signierte Capabilities | Keyhive Convergent Capabilities |

Die Migration zu Subduction wird sein:
1. Gleiche Server-Rolle (speichert verschlüsselte Chunks, versteht Inhalt nicht)
2. Neues Sync-Protokoll (Subduction statt HTTP-Polling)
3. Neue Key-Management (Keyhive statt manueller GroupKeyService)
4. Gleiche Semantik (append-only, client-side merge)

## Priorität

- **Jetzt:** HTTP-Endpoints im wot-relay + DocStoreClient + Capability-System
- **Danach:** Automatisches Push nach Change, automatisches Pull bei Space-Discovery
- **Später:** Snapshot-Kompaktierung, Quotas, Monitoring
- **Zukunft:** Subduction + Keyhive ersetzen den gesamten Stack
