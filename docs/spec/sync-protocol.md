# Sync Protocol — Event-basierte Spezifikation

**Status:** Draft
**Date:** 2026-04-11
**Purpose:** Definiert exakt, was bei welchem Event passiert — und was nicht.
**Bezug:** Ergänzt `docs/architecture/sync.md` (Architektur-Überblick) und `docs/spec/wot-protocol-spec.md` (Formate & Krypto).

---

## 1. Komponenten

```
┌─────────────────────────────────────────────────────┐
│                        App                          │
│                                                     │
│  ┌─────────────┐    ┌──────────────────────────┐    │
│  │ PersonalDoc │    │ Space-Docs (1 pro Space) │    │
│  │   (Y.Doc)   │    │        (Y.Doc)           │    │
│  └──────┬──────┘    └────────────┬─────────────┘    │
│         │                       │                   │
│  ┌──────┴──────┐    ┌───────────┴──────────┐        │
│  │ PersonalSync│    │ ReplicationAdapter   │        │
│  │  Adapter    │    │ (Space Sync)         │        │
│  └──────┬──────┘    └───────────┬──────────┘        │
│         │                       │                   │
│         └───────────┬───────────┘                   │
│                     │                               │
└─────────────────────┼───────────────────────────────┘
                      │
          ┌───────────┼───────────┐
          │           │           │
    ┌─────┴────┐ ┌────┴────┐ ┌───┴────┐
    │  Relay   │ │  Vault  │ │Compact │
    │(WebSocket│ │ (HTTP)  │ │ Store  │
    │  Server) │ │ Server  │ │(IDB)   │
    └──────────┘ └─────────┘ └────────┘
```

### 1.1 Zwei unabhängige Sync-Domänen

| Domäne | Adapter | Doc | Verschlüsselung | Empfänger |
|--------|---------|-----|------------------|-----------|
| **Personal** | `YjsPersonalSyncAdapter` | PersonalDoc | Personal Key (HKDF) | Nur eigene DID (Multi-Device) |
| **Spaces** | `YjsReplicationAdapter` | Space-Docs | Group Key (pro Space) | Alle Members + eigene DID |

**Regel: Diese Domänen sind unabhängig.** Eine Änderung in der Personal-Domäne darf keinen Sync in der Space-Domäne auslösen und umgekehrt. Die einzige Verbindung ist die Space-Discovery (siehe Event P3).

### 1.2 Nachrichtentypen

| Type | Domäne | Payload | Sender → Empfänger |
|------|--------|---------|-------------------|
| `personal-sync` | Personal | Encrypted PersonalDoc Update/FullState | Self → Self |
| `content` | Space | Encrypted Space-Doc Update | Member → All Members |
| `space-invite` | Space | Encrypted Snapshot + Group Key | Member → New Member |
| `member-update` | Space | Member add/remove signal + effective key generation | Member/Admin → eingeladene oder entfernte Person und bestehende Space-Mitglieder, je nach Aktion |
| `group-key-rotation` | Space | Encrypted new Group Key | Member → All Members |

**Implementierungsstatus (2026-05-05):** `@web_of_trust/core` stellt den reinen
Helper `evaluateMemberUpdateDisposition` für `member-update`-Statusentscheidungen
bereit. Der Evaluator ordnet eingehende Signale dem Disposition-Vokabular
`store-pending-and-sync`, `store-unverified-pending-and-sync`,
`upgrade-pending-and-sync`, `ignore-lower-authority`, `ignore-duplicate`,
`ignore-stale` und `buffer-future-and-catch-up` zu. Die Abdeckung dieser
Ergebnisse stammt aus dem lokalen Phase-1-Interop-Vector
`packages/wot-core/tests/fixtures/wot-spec/phase-1-interop.json` unter
`space_membership_messages.member_update_generation_cases`, synchronisiert aus
`../wot-spec/test-vectors/phase-1-interop.json` auf `spec-vnext`.

Die Yjs- und Automerge-Replikationsadapter implementieren noch keinen dauerhaft
gespeicherten pending- oder unverified-pending-Status für `member-update`.
Künftige Adapter-Arbeit sollte den Core-Evaluator aufrufen, bevor eine
`member-update`-Nachricht gespeichert, hochgestuft, ignoriert oder gepuffert
wird, und den daraus entstehenden Pending-Status danach in der Adapter-Storage
persistieren.

---

## 2. Events & Reaktionen

### Notation

```
✅ = MUSS passieren
❌ = DARF NICHT passieren (Invariante)
⏱️ = Mit Debounce/Delay
🔒 = Geschützt durch Guard (kein Re-Entry)
```

---

### E1: App-Start (Cold Start)

Einmalig beim Öffnen der App. Drei Phasen, strikt sequentiell.

```
Trigger: App wird geöffnet, User ist eingeloggt
```

#### Phase 1: Lokaler State aufbauen (offline-fähig, kein Netzwerk nötig)

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 1a | CompactStore öffnen | IDB bereit |
| ✅ 1b | PersonalDoc aus CompactStore laden | Spaces, Keys, Contacts lokal verfügbar |
| ✅ 1c | Spaces aus PersonalDoc restaurieren (`restoreSpacesFromMetadata`) | Space-Einträge bekannt |
| ✅ 1d | Space-Docs aus CompactStore laden (`Y.applyUpdate` pro Space) | Lokaler Content verfügbar |

**Nach Phase 1:** App ist offline benutzbar. Alle lokalen Daten sind geladen.
UI kann bereits rendern (Spaces, Contacts, Items aus Cache).

#### Phase 2: Netzwerk herstellen

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 2a | Vault-Client aufsetzen (HTTP) | Vault-Zugriff möglich |
| ✅ 2b | Falls PersonalDoc leer (kein CompactStore): aus Vault restaurieren | Neues Device bekommt State |
| ✅ 2c | Falls PersonalDoc leer (kein Vault): leeres Doc erstellen | Erstbenutzer |
| ✅ 2d | Relay verbinden (WebSocket) | Echtzeit-Kanal steht |

**Nach Phase 2:** Netzwerk steht, aber es wird noch nichts gesendet.
Reihenfolge 2a-2c vor 2d: Vault-Restore braucht nur HTTP, kein Relay.
Aber der State muss vollständig sein bevor wir anfangen zu syncen.

#### Phase 3: Sync starten (erst wenn Phase 1+2 abgeschlossen)

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 3a | PersonalSync starten → sendet FullState an eigene DID | Andere Devices bekommen PersonalDoc |
| ✅ 3b | Vault Pull für alle Spaces (einmalig, Concurrency Limit) | Neueste Snapshots aus Vault holen |
| ✅ 3c | Full State Broadcast für alle Spaces (einmalig) | Andere Devices/Members bekommen Space-State |

**3b und 3c können parallel laufen.** Beide sind einmalig beim Start.

| ❌ | Darf nicht passieren |
|----|---------------------|
| ❌ | PersonalSync starten bevor Relay verbunden ist (erzeugt gescheiterte Messages) |
| ❌ | Vault Pull oder Broadcast bei nachfolgenden PersonalDoc-Änderungen wiederholen |
| ❌ | `requestSync("__all__")` als Reaktion auf den eigenen Start-Sync |
| ❌ | Full State Broadcast bevor lokaler State geladen ist (sendet sonst leere Docs) |

---

### E2: Relay Reconnected

Verbindung war weg, ist wieder da.

```
Trigger: MessagingAdapter feuert state='connected'
Guard:   ⏱️ 2s Debounce (schnelle Reconnect-Zyklen ignorieren)
         🔒 Reentrant Guard (nur ein Reconnect-Sync gleichzeitig)
```

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 1 | PersonalDoc FullState senden (an eigene DID) | Andere Devices auf Stand bringen |
| ✅ 2 | Space-Docs FullState senden (an alle Members) | Space-Daten synchronisieren |
| ✅ 3 | Vault Pull für alle Spaces | Vault-Änderungen holen |

| ❌ | Darf nicht passieren |
|----|---------------------|
| ❌ | Mehrfach-Trigger bei connected→disconnected→connected innerhalb 2s |
| ❌ | Re-Entry: Reconnect-Sync löst neuen Reconnect-Sync aus |

---

### E3: User erstellt Space

Aktive User-Aktion.

```
Trigger: User klickt "Space erstellen"
```

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 1 | Y.Doc erzeugen, `initialDoc` anwenden | Space-Doc bereit |
| ✅ 2 | Group Key generieren (`GroupKeyService.createKey`) | Verschlüsselung |
| ✅ 3 | Space-Metadata + Group Key ins PersonalDoc schreiben | Andere Devices erfahren davon |
| ✅ 4 | → PersonalSync sendet Update automatisch (origin='local') | Multi-Device Sync |
| ✅ 5 | Encrypted Content an eigene DID senden | Andere Devices bekommen das Doc |
| ✅ 6 | CompactStore save + Vault push | Persistenz |

| ❌ | Darf nicht passieren |
|----|---------------------|
| ❌ | `requestSync("__all__")` auslösen |
| ❌ | `_sendFullStateAllSpaces()` (nur das neue Space senden, nicht alle) |

---

### E4: User wird in Space eingeladen

Space-Invite von anderem User empfangen.

```
Trigger: Eingehende Nachricht type='space-invite'
```

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 1 | Group Key aus Invite entschlüsseln (X25519 ECIES) | Key verfügbar |
| ✅ 2 | Group Key im GroupKeyService importieren | Decrypt möglich |
| ✅ 3 | Space-Doc aus Invite entschlüsseln und laden | Content verfügbar |
| ✅ 4 | Space-Metadata + Group Key ins PersonalDoc schreiben | Andere Devices erfahren davon |
| ✅ 5 | → PersonalSync sendet Update automatisch | Multi-Device |
| ✅ 6 | CompactStore save | Persistenz |
| ✅ 7 | Update-Handler registrieren (live changes empfangen) | Echtzeit |

| ❌ | Darf nicht passieren |
|----|---------------------|
| ❌ | `requestSync("__all__")` auslösen |
| ❌ | Full State Broadcast aller Spaces |

---

### E5: Content-Message empfangen (Space-Update)

Ein anderes Mitglied hat etwas im Space geändert.

```
Trigger: Eingehende Nachricht type='content', spaceId bekannt
```

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 1 | Decrypt mit Group Key | Klartext |
| ✅ 2 | `Y.applyUpdate(doc, decrypted, 'remote')` | CRDT Merge |
| ✅ 3 | CompactStore save (debounced, 2s) | Lokale Persistenz |
| ✅ 4 | Vault push (debounced, 5s) | Backup |

| ❌ | Darf nicht passieren |
|----|---------------------|
| ❌ | PersonalDoc ändern |
| ❌ | Full State Broadcast |
| ❌ | Content-Message an andere Members weiterleiten (kein Relay-Relay) |

---

### E6: User ändert etwas im Space (lokale Mutation)

User fügt Contact hinzu, editiert Item, etc.

```
Trigger: Y.Doc transact(..., 'local') im Space-Doc
```

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 1 | Encrypted Update an alle Members senden (inkl. eigene DID) | Echtzeit-Sync |
| ✅ 2 | CompactStore save (debounced, 2s) | Lokale Persistenz |
| ✅ 3 | Vault push (debounced, 5s) | Backup |

| ❌ | Darf nicht passieren |
|----|---------------------|
| ❌ | Full State senden (nur Delta) |
| ❌ | PersonalDoc ändern (Space-Inhalt lebt im Space-Doc) |

---

### P1: PersonalDoc ändert sich lokal (User-Aktion)

User ändert Profil, fügt Contact hinzu, etc.

```
Trigger: changeYjsPersonalDoc(fn) mit origin='local'
```

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 1 | Y.Doc Update Event feuert (origin='local') | |
| ✅ 2 | → PersonalSync sendet encrypted Update an eigene DID | Multi-Device |
| ✅ 3 | CompactStore save (immediate) | Persistenz |
| ✅ 4 | Vault push (debounced, 5s) | Backup |
| ✅ 5 | `onYjsPersonalDocChange` Listener feuern | UI + Space-Discovery |

| ❌ | Darf nicht passieren |
|----|---------------------|
| ❌ | Space Full State Broadcast |
| ❌ | Vault Pull für Spaces |

---

### P2: PersonalDoc ändert sich remote (von anderem Device)

Anderes Device hat PersonalDoc geändert, Update kommt über Relay.

```
Trigger: personal-sync Message empfangen, Y.applyUpdate(doc, data, 'remote')
```

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 1 | Decrypt + Apply (origin='remote') | Lokaler State aktuell |
| ✅ 2 | `onYjsPersonalDocChange` Listener feuern | UI + Space-Discovery |
| ✅ 3 | CompactStore save | Persistenz |

| ❌ | Darf nicht passieren |
|----|---------------------|
| ❌ | PersonalSync sendet Update zurück (origin='remote' wird gefiltert) |
| ❌ | Space Full State Broadcast |
| ❌ | Vault Pull für Spaces |

---

### P3: PersonalDoc-Change enthält neuen Space (Space-Discovery)

Neuer Space taucht im PersonalDoc auf (von anderem Device oder nach Invite).

```
Trigger: onYjsPersonalDocChange → prüfe auf neue Spaces
Guard:   🔒 Reentrant Guard (nur ein Restore gleichzeitig)
```

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 1 | `restoreSpacesFromMetadata()` aufrufen | Neue Spaces entdecken |
| ✅ 2 | Für jeden neuen Space: Group Key importieren | Decrypt möglich |
| ✅ 3 | Für jeden neuen Space: Doc aus CompactStore laden | Lokaler State |
| ✅ 4 | Space-Metadata nur schreiben wenn sich was geändert hat (Dirty-Check) | Kein Loop |
| ✅ 5 | Update-Handler registrieren | Echtzeit |

| ❌ | Darf nicht passieren |
|----|---------------------|
| ❌ | `_sendFullStateAllSpaces()` |
| ❌ | `_pullAllFromVault()` (gehört zum Reconnect, nicht zur Discovery) |
| ❌ | `requestSync("__all__")` |
| ❌ | Erneuter Aufruf während Restore läuft (Reentrant Guard) |

---

### P4: PersonalDoc-Metadata wird geschrieben (saveSpaceMetadata)

Interne Operation: Space-Info wird im PersonalDoc aktualisiert.

```
Trigger: saveSpaceMetadata() in YjsReplicationAdapter
Guard:   Dirty-Check (nur schreiben wenn sich was geändert hat)
```

| # | Aktion | Ziel |
|---|--------|------|
| ✅ 1 | Fingerprint berechnen (members, name, type, encKeys) | |
| ✅ 2 | Wenn unverändert: **Skip** (kein Write) | Loop-Prävention |
| ✅ 3 | Wenn geändert: `changePersonalDoc(...)` | PersonalDoc aktualisiert |
| ✅ 4 | → PersonalSync sendet Update an andere Devices | Multi-Device |

| ❌ | Darf nicht passieren |
|----|---------------------|
| ❌ | Redundantes Schreiben derselben Daten (Dirty-Check verhindert das) |

---

## 3. Invarianten

Regeln die **immer** gelten, egal welches Event:

### I1: Kein Echo
> Ein eingehender Sync (origin='remote') darf niemals denselben Nachrichtentyp
> als Reaktion senden. Empfangene `personal-sync` Messages dürfen keine neuen
> `personal-sync` Messages erzeugen. Empfangene `content` Messages dürfen keine
> neuen `content` Messages erzeugen.

### I2: Domänen-Trennung
> PersonalDoc-Änderungen lösen keinen Space-Broadcast aus.
> Space-Doc-Änderungen lösen keine PersonalDoc-Mutation aus.
> Ausnahme: Space-Discovery (P3) — aber nur `restoreSpacesFromMetadata`,
> nicht Full State Broadcast.

### I3: Einmaliger Reconnect-Sync
> `_sendFullStateAllSpaces()` und `_pullAllFromVault()` laufen **höchstens einmal
> pro stabilem Reconnect** (2s Debounce + Reentrant Guard).

### I4: Dirty-Check für Metadata
> `saveSpaceMetadata()` schreibt nur wenn sich der Inhalt tatsächlich geändert hat.
> Redundante Writes sind die häufigste Ursache für Sync-Loops.

### I5: sentMessageIds Filter
> Jedes Device trackt die IDs der Messages die es selbst gesendet hat.
> Eigene Messages die über den Relay zurückkommen werden ignoriert.

### I6: Full State nur bei Reconnect
> `sendFullState()` (PersonalDoc) und `_sendFullStateAllSpaces()` (Spaces) laufen
> nur bei App-Start und bei Relay-Reconnect — nicht bei jeder Änderung.
> Einzelne Änderungen senden nur Deltas.

---

## 4. Offene Design-Fragen

Dinge die wir noch klären müssen:

### Q1: Doc-pro-Space vs. Doc-pro-Modul
Benchmarks zeigen: Delta auf ein Space-Doc mit 2000 Chat-Nachrichten + 500 Contacts
kostet 26ms (Single Doc) vs. 3.4ms (Contacts-only Doc). Faktor 7.8x.
Empfehlung: Chat-Modul als separates Y.Doc pro Space.

### Q2: State Vector statt Full State
Aktuell senden wir bei Reconnect `Y.encodeStateAsUpdate(doc)` (Full State).
Yjs unterstützt `Y.encodeStateVector` + `Y.encodeStateAsUpdate(doc, remoteStateVector)`
für effiziente Delta-Berechnung. Könnte Full State Broadcast ersetzen.

### Q3: Key Rotation bei Member-Remove
Aktuell: neuer Key an alle verbleibenden Members senden + Snapshot mit neuem Key.
Offen: Forward Secrecy? Ratcheting? (Keyhive/BeeKEM frühestens Ende 2026)

### Q4: Chat als CRDT?
Chat-Nachrichten sind append-only. Ein CRDT (Y.Array) ist Overhead für etwas das
nie Konflikte hat. Alternative: Chat als einfache verschlüsselte Messages über Relay,
persistiert in einem separaten Store.

### Q5: Relay Multicast
Aktuell: N unicast Messages pro Space-Update (eine pro Member).
Besser: Eine Message an den Relay mit Empfängerliste.

---

## 5. Bekannte Bugs (Stand 2026-04-11)

### B1: Sync-Loop bei PersonalDoc-Änderungen
**Status:** Offen
**Symptom:** Hunderte `personal-sync` Messages pro Sekunde, Browser hängt sich auf.
**Ursache:** `onYjsPersonalDocChange` → `requestSync("__all__")` → mutiert PersonalDoc → Loop.
Tritt besonders auf wenn eine Demo-Identität in RLS geladen wird (Spaces aus Demo).
**Fix-Ansatz:** Dieses Dokument definiert die Events und Invarianten die den Loop verhindern:
- P3 statt requestSync("__all__") (nur restoreSpacesFromMetadata, kein Broadcast)
- I2 (Domänen-Trennung)
- I4 (Dirty-Check)
- I3 (Einmaliger Reconnect-Sync)

---

*Ergänzt: `docs/architecture/sync.md` (Überblick), `docs/spec/wot-protocol-spec.md` (Formate)*
