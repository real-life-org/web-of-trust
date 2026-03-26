# Multi-Device Offline Sync — Gelöst (2026-03-19)

## Kontext

Wir bauen eine Local-First, Ende-zu-Ende-verschlüsselte App mit Yjs CRDTs. Nutzer können die gleiche Identität (abgeleitet aus einer BIP39 Seed Phrase) auf mehreren Geräten verwenden (z.B. Laptop + Handy).

### Architektur

- **Yjs Y.Doc** — CRDT-Dokumente für kollaborative Daten (Spaces)
- **PersonalDoc** — Ein spezielles Y.Doc pro Identität das Space-Metadata, Group Keys, Kontakte und Profildaten enthält. Synct zuverlässig zwischen eigenen Geräten.
- **Relay (WebSocket)** — Echtzeit Message-Router. Leitet verschlüsselte Messages weiter. Hat eine SQLite-Queue für offline Empfänger.
- **Vault (HTTP)** — Verschlüsselter Snapshot-Store. Jedes Gerät pusht periodisch (5s Debounce) verschlüsselte Snapshots seiner Y.Docs dorthin.
- **CompactStore (IndexedDB)** — Lokale Persistenz pro Gerät.

### Datenfluss

Jeder Space hat sein eigenes Y.Doc (verschlüsselt mit einem Group Key). Das PersonalDoc enthält die Metadaten aller Spaces (IDs, Namen, Members) und die Group Keys. Wenn ein Gerät das PersonalDoc hat, kann es alle Spaces entschlüsseln.

Änderungen an einem Space werden als verschlüsselte CRDT-Updates über den Relay an alle Space-Members gesendet (inkl. eigene DID für Multi-Device).

## Was funktioniert

1. **PersonalDoc Sync** — Zuverlässig zwischen Geräten. Hat einen eigenen `YjsPersonalSyncAdapter` der bei jedem Connect den vollen State sendet (`sendFullState`) und andere Geräte um ihren State bittet (`sendSyncRequest`).

2. **Space Sync wenn beide Geräte online** — Device 1 ändert etwas → verschlüsseltes Update geht an alle Members (inkl. eigene DID) → Device 2 empfängt und merged via `Y.applyUpdate`.

3. **Space Discovery** — Wenn Device 1 einen Space erstellt, wird die Metadata ins PersonalDoc geschrieben → synct zu Device 2 → Device 2 entdeckt den neuen Space via `restoreSpacesFromMetadata()`.

4. **Vault-Pull bei Start** — Beim Start holt jedes Gerät den neuesten Vault-Snapshot für jeden bekannten Space und merged ihn ins lokale Y.Doc.

## Das Problem

**Szenario:** Device 2 war offline. Device 1 hat Änderungen an einem Space gemacht (z.B. Items erstellt, Member entfernt mit Key-Rotation). Device 2 kommt online.

**Erwartung:** Device 2 sieht alle Änderungen.

**Realität:** Device 2 sieht die Änderungen teilweise oder gar nicht.

### Root Causes

#### 1. Relay-Queue markiert Messages als "delivered" für die ganze DID

```
relay.ts handleSend():
  const recipientSockets = this.connections.get(toDid)
  if (recipientSockets && recipientSockets.size > 0) {
    // Liefert an ALLE verbundenen Sockets
    for (const ws of recipientSockets) {
      this.sendTo(ws, { type: 'message', envelope })
    }
    // Enqueue + mark as delivered
    this.queue.enqueue(toDid, envelope)
    this.queue.markDelivered(messageId)  // ← Problem!
  }
```

Wenn Device 2 offline ist aber Device 1 online (gleiche DID), hat die DID noch einen Socket im Relay. Die Message wird an Device 1 geliefert und als `delivered` markiert. Bei `register` (Device 2 kommt online) werden nur `queued` Messages zugestellt, nicht `delivered`. **Device 2 bekommt die Message nie.**

#### 2. Timing zwischen Space-Discovery und Content-Messages

Wenn Device 2 einen neuen Space über das PersonalDoc entdeckt, erstellt es ein leeres Y.Doc. Content-Messages für diesen Space kommen möglicherweise **vor** der Space-Discovery an und werden verworfen (Space unbekannt).

**Implementierter Fix:** Content-Buffering — Messages für unbekannte Spaces werden 60s gepuffert und abgearbeitet sobald der Space entdeckt wird. Ebenso für Messages mit unbekanntem Group Key (nach Key-Rotation).

#### 3. Vault-Pull als Fallback

Der Vault-Pull sollte den Offline-Fall abfangen: Device 2 kommt online → holt den neuesten Snapshot vom Vault → merged. Das funktioniert wenn:
- Device 1 den Vault-Push gemacht hat (5s Debounce)
- Der Vault erreichbar ist
- Die Entschlüsselung funktioniert (gleicher Key)

In unseren E2E Tests ist der Vault zwar jetzt gestartet, aber das Timing zwischen PersonalDoc-Sync, Space-Discovery, Vault-Pull und Content-Message-Buffering ist nicht stabil genug für deterministische Tests.

## Implementierte Lösungen

1. **Content-Buffering** (`pendingMessages` Map mit 60s TTL) — Messages für unbekannte Spaces oder unbekannte Keys werden gepuffert
2. **Space-Sync-Request** — Bei Space-Discovery sendet das Gerät einen Request an die eigene DID; andere Geräte antworten mit dem vollen State
3. **Self-Content bei createSpace** — Der Ersteller sendet den vollen Doc-State an die eigene DID (für andere Geräte)
4. **handleSpaceInvite Merge** — Space-Invites für bereits bekannte Spaces werden gemerged statt ignoriert
5. **Vault-Pull bei Space-Discovery** — Neuentdeckte Spaces holen sofort den Vault-Snapshot
6. **Vault im E2E-Setup** — wot-vault Server wird neben Relay und Profiles gestartet

## Analyse: Warum der Relay-Queue-Bug nicht das eigentliche Problem ist

Der Relay-Queue-Bug (Messages als "delivered" markiert für die ganze DID) ist real, betrifft aber nur den Echtzeit-Pfad. In einer Local-First Architektur muss es immer einen Fallback geben für den Fall dass Messages verloren gehen — sei es durch den Queue-Bug, einen Relay-Neustart, oder Netzwerkprobleme.

Vergleich mit anderen Projekten (recherchiert 2026-03-19):

- **SECSYNC** (E2EE auf Yjs): Kein per-Device Tracking. Jedes Device ist ein unabhängiger Client. Delta-Sync via Update Clocks (`{ pubKey: clockValue }`). Server vergibt monotone Versionsnummern. Multi-Device ist explizit kein First-Class Concept — CRDTs sorgen für Konvergenz.
- **NextGraph** (E2EE CRDTs): Kein per-Device Delivery-Tracking. DAG-basierter Catch-Up (wie Git): Device schickt `known_heads`, Broker berechnet fehlendes Subgraph. Online-Geräte bekommen Updates via Pub/Sub, offline Geräte pullen das Delta beim Reconnect.

Beide Projekte setzen auf **Client-Pull statt Server-Push** für Offline-Catch-Up. Der Server weiß nicht wer was hat — der Client ist verantwortlich dafür, seinen eigenen State aktuell zu halten.

Das bestätigt unseren Ansatz: Der Relay bleibt wie er ist (funktioniert für den Online-Fall, 15 E2E Tests bestehen). Der Vault ist das Safety Net.

## Die eigentliche Root Cause

### Das kritische Szenario

```
T0  Device 1 + Device 2 online, Space mit Gen 0 Key
T1  Device 2 geht offline
T2  Device 1 entfernt Bob → Key Rotation → Gen 1
    ├── group-key-rotation Message → Relay liefert an Device 1 (einziger Socket)
    ├── saveGroupKey(Gen 1) ins PersonalDoc
    ├── PersonalDoc Vault-Push (enthält Gen 1 Key)
    ├── Space Vault-Push: Snapshot encrypted mit Gen 1
T3  Device 1 geht offline
T4  Device 2 kommt online — Device 1 ist NICHT da
```

### Was bei T4 passiert

```
Device 2 reconnects:
├── PersonalSyncAdapter: sendSyncRequest() → an eigene DID
│   └── Device 1 ist offline → niemand antwortet
│   └── PersonalDoc bleibt auf Stand von T1 (nur Gen 0 Key)
│
├── ReplicationAdapter.start():
│   └── restoreSpacesFromMetadata()
│       └── loadGroupKeys() → nur Gen 0
│   └── requestSync('__all__')
│       └── _pullFromVault(space) → Vault-Snapshot ist mit Gen 1 encrypted
│           → Gen 1 Key nicht vorhanden → Decryption FAILS
│
└── Ergebnis: Device 2 sieht den alten Stand (Gen 0), neuer Content fehlt
```

### Warum das PersonalDoc nicht hilft (in diesem Szenario)

Der PersonalDoc Vault-Pull in `initYjsPersonalDoc()` passiert NUR wenn der CompactStore leer ist:

```typescript
// YjsPersonalDocManager.ts Zeile 441-450
if (loadedFrom === 'new') {      // ← nur wenn CompactStore leer!
  const restored = await restoreFromVault()
}
```

Device 2 hat aber einen CompactStore (aus T0, mit Gen 0 Key). Also wird der Vault **nicht gefragt**, obwohl dort ein neueres PersonalDoc mit dem Gen 1 Key liegt.

**Das ist die Root Cause:** Der PersonalDoc Vault-Pull ist zu konservativ. Er fragt den Vault nur bei komplett leerem lokalen State, nicht wenn der lokale State veraltet sein könnte.

## Lösung

### Vault-Pull für PersonalDoc bei fehlendem Key (Lazy Fetch)

Statt den PersonalDoc Vault-Pull bei jedem Start zu machen (unnötiger Traffic), wird er **on-demand getriggert** wenn ein Space-Vault-Pull am fehlenden Key scheitert:

```
Device 2 reconnects:
  1. CompactStore laden → PersonalDoc mit Gen 0
  2. restoreSpacesFromMetadata() → Gen 0 Key bekannt
  3. _pullFromVault(space) → Vault hat Gen 1 Snapshot
     → Decrypt versucht Gen 0 → passt nicht (oder Gen 1 Key fehlt)
     → ⚡ Fallback: PersonalDoc aus Vault pullen
         → Y.applyUpdate mergt Gen 1 Key ins PersonalDoc
         → loadGroupKeys() nochmal → Gen 1 jetzt da
     → Retry _pullFromVault(space) → Decrypt mit Gen 1 → ✅
```

### Voraussetzung: PersonalDoc Vault-Push bei Key-Rotation muss zuverlässig sein

Damit der Fallback-Mechanismus funktioniert, muss Device 1 das PersonalDoc (mit dem neuen Key) **sofort und zuverlässig** an den Vault pushen. Aktueller Stand:

- `saveGroupKey()` → `changePersonalDoc()` (ohne `background`) → `pushImmediate()` → **sofortiger Push** ✅
- `pushImmediate()` ist fire-and-forget (nicht awaited) — wenn Device 1 unmittelbar danach offline geht, könnte der HTTP Request noch nicht abgeschlossen sein ⚠️

Für die Key-Rotation muss sichergestellt werden, dass der Vault-Push **awaited** wird bevor die Rotation als abgeschlossen gilt. Entweder:
- `saveGroupKey` bei Rotation mit `await flushYjsPersonalDoc()` nachziehen
- Oder den Vault-Push im Rotation-Flow explizit awaiten

Ohne das könnte es passieren: Device 1 rotiert Key → PersonalDoc Vault-Push startet → Device 1 geht offline bevor der Push durch ist → Gen 1 Key liegt nie im Vault → Device 2 hat keine Chance ihn zu bekommen.

### Implementierungsplan

**Schritt 1: PersonalDoc Vault-Push bei Key-Rotation awaiten**

`YjsReplicationAdapter.ts` — Nach `saveGroupKey` im Rotation-Flow einen `flushYjsPersonalDoc()` Call:

```typescript
// In removeMember(), nach saveGroupKey:
await this.metadataStorage.saveGroupKey({ spaceId, generation: newGen, key: newKey })
await flushYjsPersonalDoc()  // ← Sicherstellen dass der Key im Vault landet
```

**Schritt 2: PersonalDoc Vault-Pull exportieren**

`YjsPersonalDocManager.ts` — Die existierende `restoreFromVault()` Funktion als public API exportieren:

```typescript
export async function refreshPersonalDocFromVault(): Promise<boolean> {
  return restoreFromVault()
}
```

**Schritt 3: `_pullFromVault` im ReplicationAdapter erweitern**

`YjsReplicationAdapter.ts` — Bei Decrypt-Fehler (fehlender Key) das PersonalDoc aus dem Vault auffrischen und den Pull retrien:

```typescript
private async _pullFromVault(state: YjsSpaceState): Promise<void> {
  if (!this.vault) return
  const groupKey = this.groupKeyService.getCurrentKey(state.info.id)
  if (!groupKey) {
    // Key komplett unbekannt → PersonalDoc Vault-Pull, dann retry
    const refreshed = await refreshPersonalDocFromVault()
    if (refreshed) {
      await this.restoreGroupKeysForSpace(state.info.id)
      return this._pullFromVaultInner(state)
    }
    return
  }
  return this._pullFromVaultInner(state)
}

private async _pullFromVaultInner(state: YjsSpaceState): Promise<void> {
  // ... existierender Vault-Pull Code ...
  // Bei Decrypt-Fehler: PersonalDoc refreshen + retry (einmalig)
}
```

### Warum das reicht

| Szenario | Sync-Kanal | Funktioniert? |
|---|---|---|
| Beide online, kein Key-Rotation | Relay (Echtzeit) | ✅ (15 E2E Tests) |
| Beide online, Key-Rotation | Relay (`group-key-rotation` Message) | ✅ |
| Device 2 offline, kommt online WÄHREND Device 1 online | PersonalDoc-Sync + Vault-Pull | ✅ |
| Device 2 offline, kommt online NACHDEM Device 1 offline | **PersonalDoc Vault-Pull** + Space Vault-Pull | ✅ (der neue Fix) |
| Relay-Neustart, Messages verloren | Vault-Pull | ✅ |

### Was sich NICHT ändert

- **Relay** bleibt unverändert. Der Queue-Bug existiert weiter, ist aber irrelevant weil der Vault das auffängt.
- **PersonalDoc-Sync** bleibt unverändert. Funktioniert zuverlässig wenn beide Devices gleichzeitig online sind.
- **Content-Buffering** bleibt als Lösung für das Timing-Problem zwischen Space-Discovery und Content-Messages.

## Relevante Dateien

- `packages/adapter-yjs/src/YjsPersonalDocManager.ts` — PersonalDoc Vault-Pull (`restoreFromVault`, Zeile 338-382). Hier muss `refreshPersonalDocFromVault()` exportiert werden.
- `packages/adapter-yjs/src/YjsReplicationAdapter.ts` — Space Vault-Pull (`_pullFromVault`, Zeile 751-787). Hier kommt der Fallback-Mechanismus rein.
- `packages/adapter-yjs/src/YjsPersonalSyncAdapter.ts` — PersonalDoc Multi-Device Sync (funktioniert, keine Änderung nötig)
- `packages/wot-core/src/services/VaultClient.ts` — Vault HTTP Client (keine Änderung nötig)
- `packages/wot-core/src/services/GroupKeyService.ts` — Group Key Management (keine Änderung nötig)
- `apps/demo/e2e/key-rotation-multi-device.spec.ts` — E2E Test (Offline-Test sollte nach dem Fix unskipped werden)

## Architektur-Optimierungen (unabhängig vom Bug)

In der Analyse-Session (2026-03-19) wurden weitere Optimierungen diskutiert. Bewertung nach Nutzen und Aufwand, unabhängig vom konkreten Key-Rotation-Bug:

### 1. TTL statt ACK-Delete im Relay

**Idee:** Messages nicht bei ACK löschen, sondern mit TTL (z.B. 1h) aufbewahren. Bei `register` bekommt ein Device alle Messages der letzten Stunde. Yjs dedupliziert automatisch.

**Nutzen:** Mittel. Entschärft den Relay-Queue-Bug für alle Message-Typen, nicht nur Key Rotation. Reduziert die Abhängigkeit vom Vault für kurze Offline-Phasen.

**Aufwand:** Klein — nur `queue.ts` ändern (ACK setzt Status statt zu löschen, Cleanup-Job per TTL).

**Bewertung: Sinnvoll, niedrige Priorität.** Der Vault-Pull-Fix löst das Haupt-Problem. TTL wäre ein zusätzliches Safety Net das den Relay für Multi-Device robuster macht. Lohnt sich wenn der Queue-Bug in anderen (nicht Key-Rotation) Szenarien auffällt.

### 2. Periodischer Vault-Check

**Idee:** Alle 30s ein leichtgewichtiger `getDocInfo()` Call pro Space. Wenn `latestSeq > localSeq` → Vault-Pull triggern. Fängt den Fall ab wo Relay-Messages verloren gehen während das Device online ist.

**Nutzen:** Gering bis Mittel. Relevant nur wenn Messages verloren gehen während das Device online und connected ist — ein seltener Edge Case (Relay-Neustart, Netzwerk-Hickup).

**Aufwand:** Klein — Interval + `getDocInfo()` (ein kleiner JSON-Response pro Space).

**Bewertung: Eher unnötig aktuell.** Der Vault-Pull passiert schon bei jedem Reconnect. Ein Reconnect passiert auch nach Netzwerk-Hickups (WebSocket reconnects). Periodisches Polling würde vor allem bei vielen Spaces unnötigen Traffic erzeugen. Erst relevant wenn es Fälle gibt wo der Relay Messages verliert ohne dass die WebSocket-Verbindung abbricht.

### 3. Changes statt Snapshots im Vault (SECSYNC-Style)

**Idee:** Statt Full-Snapshots einzelne verschlüsselte Yjs-Updates als Changes in den Vault pushen. Delta-Pull via `getChanges(docId, since=lastSeq)`. Periodische Compaction (neuer Snapshot, alte Changes löschen).

**Nutzen:** Hoch — und zwar nicht primär wegen Performance, sondern wegen **Datensicherheit**:

Der aktuelle Snapshot-Ansatz hat ein fundamentales Debounce-Problem: Zwischen der letzten Änderung und dem Vault-Push liegt ein 5s-Fenster. Wenn das Device in diesem Fenster offline geht (Handy zuklappen, Tab schließen, Verbindung verlieren), gehen alle Änderungen seit dem letzten Push verloren — sie existieren nur lokal im CompactStore und im Relay (der sie an andere Devices weiterleitet, aber nicht zuverlässig an alle). Das ist normales Nutzerverhalten, kein Edge Case.

Mit Changes wird jedes Yjs-Update sofort und einzeln an den Vault gepusht. Kein Debounce, kein Datenverlust-Fenster. Die einzelnen Changes sind klein (50-200 Bytes), der Overhead pro Push minimal.

Zusätzliche Vorteile:

- Delta-Pull: `getChanges(since=lastSeq)` statt Full Snapshot bei jedem Reconnect
- Der Vault wird ein vollwertiger Sync-Kanal (nicht nur Backup)
- Grundlage für Optimierung 5 (Stateless Relay)

**Aufwand:** Mittel bis Hoch.

- Push: Jedes Y.Doc `update` Event einzeln verschlüsseln und pushen (die API `pushChange` existiert bereits im VaultClient)
- Pull: `getChanges(since=lastSeq)`, mehrere Changes decrypten und applyen (die API `getChanges(docId, since)` existiert bereits)
- Compaction: Periodisch Snapshot schreiben + alte Changes löschen (reduziert Speicher)
- Key Rotation: Compaction muss sofort nach Rotation passieren, damit keine Changes mit dem alten Key im Vault bleiben (Security!)
- Vault-Server: `pushChange` + `getChanges(since)` existieren bereits, Compaction-Endpoint (`DELETE changes < seq`) fehlt eventuell

**Bewertung: Hohe Priorität, als nächster Schritt nach dem Bug-Fix.** Löst das Debounce-Datenverlust-Problem und macht den Vault zu einem zuverlässigen Sync-Kanal. Die Client-seitige API existiert bereits — der Hauptaufwand liegt in der Umstellung des Push-Flows und der Compaction-Logik bei Key Rotation.

### 4. Device-IDs im Relay

**Idee:** Jedes Gerät bekommt eine stabile `deviceId`. Relay trackt Delivery per Device statt per DID. ACK löscht nur für das ACKende Device.

**Nutzen:** Hoch für korrektes Message-Delivery. Löst den Queue-Bug sauber auf Protocol-Ebene.

**Aufwand:** Hoch.
- Neues Identitäts-Konzept (generieren, persistieren in IndexedDB, mitsenden bei `register`)
- Queue-Schema umbauen (messages + delivery_tracking Tabellen)
- Cleanup-Logik (wann ist ein Device "tot"? TTL? Max Devices pro DID?)
- Privacy-Implikation (Device-Tracking-Vektor auf dem Relay)
- Alle Clients müssen angepasst werden

**Bewertung: Nicht empfohlen.** Sowohl SECSYNC als auch NextGraph verzichten bewusst auf per-Device Tracking. Der Vault-Pull-Fix löst das Problem ohne neues Identitäts-Konzept. Device-IDs lohnen sich nur wenn es zukünftig Features gibt die Device-Awareness brauchen (z.B. "auf welchen Geräten bin ich eingeloggt", selektives Device-Revoke).

### 5. Stateless Relay (keine Queue)

**Idee:** Relay komplett ohne Queue — reines Echtzeit-Forwarding (Pub/Sub). Alle Persistenz liegt beim Vault.

**Nutzen:** Vereinfacht den Relay massiv. Kein Queue-Code, kein ACK-Handling, kein Delivery-Tracking.

**Aufwand:** Mittel (Code entfernen ist einfach), aber der Vault müsste **alle** Offline-Fälle abdecken — auch kurze Offline-Phasen die heute die Queue auffängt.

**Bewertung: Interessant, aber zu früh.** Die Queue fängt heute viele kurze Offline-Fälle ab (Tab-Wechsel, kurzer Verbindungsabbruch) ohne Vault-Roundtrip. Ein stateless Relay würde den Vault-Traffic deutlich erhöhen. Erst sinnvoll wenn der Vault auf Changes umgestellt ist (Optimierung 3) und damit schnelle Delta-Pulls möglich sind.

### Zusammenfassung Priorität

| # | Optimierung | Nutzen | Aufwand | Empfehlung |
|---|---|---|---|---|
| 1 | TTL statt ACK-Delete | Mittel | Klein | Backlog — bei Bedarf |
| 2 | Periodischer Vault-Check | Gering | Klein | Nicht nötig aktuell |
| 3 | Changes statt Snapshots | Hoch (Datensicherheit) | Mittel-Hoch | Nächster Schritt nach Bug-Fix |
| 4 | Device-IDs | Hoch (korrekt) | Hoch | Nicht empfohlen |
| 5 | Stateless Relay | Mittel | Mittel | Erst nach Optimierung 3 |
