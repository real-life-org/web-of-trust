# Current Implementation

> **Hinweis:** Dies ist KEINE Spezifikation, sondern dokumentiert den aktuellen Implementierungsstand.
> Die Spezifikation findest du in [docs/flows/](./flows/) und anderen Spec-Dokumenten.

Dieses Dokument zeigt, was bereits implementiert ist und welche Entscheidungen getroffen wurden.

## Letzte Aktualisierung

**Datum:** 2026-02-25
**Phase:** Week 6++ - i18n + Offline Polish
**Demo:** https://web-of-trust.de/demo/
**Relay:** wss://relay.utopia-lab.org
**Profiles:** https://profiles.utopia-lab.org

---

## Week 1: Identity Foundation ✅

### Übersicht

Die Grundlage für das Identitätssystem wurde implementiert und vollständig getestet.

### Implementiert

#### WotIdentity Class (`packages/wot-core/src/identity/WotIdentity.ts`)

Vollständige Identity-Management-Lösung mit:

- ✅ **BIP39 Mnemonic Generation** - 12-Wort Recovery-Phrase (128-bit Entropy)
- ✅ **Deutsche BIP39-Wortliste** - 2048 deutsche Wörter (dys2p/wordlists-de)
- ✅ **Deterministic Key Derivation** - Gleicher Mnemonic → gleiche DID
- ✅ **Ed25519 Key Pairs** - @noble/ed25519 Library
- ✅ **did:key Format** - Standard-konforme Decentralized Identifiers
- ✅ **Encrypted Storage** - Seed verschlüsselt in IndexedDB mit PBKDF2 (600k) + AES-GCM
- ✅ **Runtime-only Keys** - Keys nur während Session im Memory
- ✅ **storeSeed Parameter** - Kontrolle wann Identity in IndexedDB gespeichert wird

**API Methods:**

```typescript
// Identity Creation & Recovery
create(passphrase: string, storeSeed: boolean): Promise<{ mnemonic: string, did: string }>
unlock(mnemonic: string, passphrase: string, storeSeed: boolean): Promise<void>
unlockFromStorage(passphrase: string): Promise<void>

// Cryptographic Operations
sign(data: string): Promise<string>
getDid(): string
getPublicKeyMultibase(): Promise<string>

// Storage Management
hasStoredIdentity(): Promise<boolean>
deleteStoredIdentity(): Promise<void>

// Framework Integration
deriveFrameworkKey(info: string): Promise<Uint8Array>
```

#### Deutsche BIP39-Wortliste (`packages/wot-core/src/wordlists/german-positive.ts`)

- ✅ **2048 deutsche Wörter** - Quelle: [dys2p/wordlists-de](https://github.com/dys2p/wordlists-de)
- ✅ **BIP39-konform** - Erste 4 Zeichen jedes Worts sind einzigartig
- ✅ **Validierung** - Runtime-Check auf exakt 2048 Wörter
- ✅ **User-facing: "Magische Wörter"** - Mnemonic heißt in der UI "Magische Wörter"

#### SeedStorage Class (`packages/wot-core/src/identity/SeedStorage.ts`)

Sichere Seed-Verschlüsselung und -Speicherung:

- ✅ **IndexedDB Storage** - Browser-native persistence
- ✅ **PBKDF2 Key Derivation** - 600,000 iterations
- ✅ **AES-GCM Encryption** - Authenticated encryption
- ✅ **Random Salt & IV** - Pro Storage-Operation
- ✅ **Passphrase Protection** - HMAC validation

#### Demo App Integration

- ✅ **Onboarding Flow** - Neue Identität erstellen
  - Mnemonic anzeigen (einmalig, "Magische Wörter")
  - Mnemonic-Verifikation (3 zufällige Wörter)
  - Passphrase setzen → Encrypted Storage
  - Enter-Navigation in allen Schritten
  - storeSeed=false bei Generierung, storeSeed=true erst nach Passphrase
- ✅ **Recovery Flow** - Identität aus Mnemonic wiederherstellen
  - storeSeed=true beim Import
- ✅ **Unlock Flow** - Identität aus verschlüsseltem Storage entsperren
- ✅ **Identity Management** - DID anzeigen, Identität löschen
- ✅ **Persistenz-Handling** - hasStoredIdentity Check beim App-Start
  - Loading State während Check
  - Unlock Screen wenn Identity gespeichert
  - Onboarding Screen wenn keine Identity

#### Shared UI Components

- ✅ **ProgressIndicator** - Step-Anzeige im Onboarding
- ✅ **SecurityChecklist** - Checkbox-Liste für Sicherheitsbestätigung
- ✅ **InfoTooltip** - Hilfe-Tooltips

### Tests

**29 Tests** mit vollständiger Coverage:

#### WotIdentity Tests (17 Tests)

```typescript
✓ create() - 12-word mnemonic generation
✓ create() - valid did:key format
✓ create() - store encrypted seed (storeSeed=true)
✓ create() - do not store seed (storeSeed=false)

✓ unlock() - from mnemonic and passphrase
✓ unlock() - deterministic (same mnemonic → same DID)
✓ unlock() - throws on invalid mnemonic

✓ unlockFromStorage() - from encrypted seed
✓ unlockFromStorage() - throws with wrong passphrase
✓ unlockFromStorage() - throws when no seed stored

✓ sign() - returns base64url signature

✓ getPublicKeyMultibase() - returns multibase format

✓ hasStoredIdentity() - returns false when empty
✓ hasStoredIdentity() - returns true after storing

✓ deleteStoredIdentity() - deletes seed
✓ deleteStoredIdentity() - locks identity after deletion

✓ Deterministic Key Derivation - same mnemonic across instances
```

#### SeedStorage Tests (12 Tests)

```typescript
✓ storeSeed() and loadSeed() - correct passphrase
✓ storeSeed() - seed is encrypted
✓ loadSeed() - throws with wrong passphrase
✓ loadSeed() - returns null when empty

✓ hasSeed() - returns false when empty
✓ hasSeed() - returns true after storing
✓ hasSeed() - returns false after deletion

✓ deleteSeed() - removes stored seed
✓ deleteSeed() - no error when deleting non-existent

✓ Security: different salt per storage operation
✓ Security: different passphrases for same seed
```

**Test Environment:**

- Vitest with happy-dom
- fake-indexeddb for IndexedDB simulation
- All tests passing ✅

---

## Week 2: In-Person Verification ✅

### Übersicht Week 2

Das bestehende Verification-System wurde auf WotIdentity migriert und vollständig getestet. Challenge-Response-Protokoll mit Ed25519-Signaturen funktioniert end-to-end.

### Implementiert Week 2

#### ContactStorage Class (`packages/wot-core/src/contact/ContactStorage.ts`)

IndexedDB-basierte Contact-Verwaltung:

- ✅ **CRUD Operations** - Add, Get, Update, Remove Contacts
- ✅ **Status Management** - Pending → Active nach Verification
- ✅ **DID-based Lookup** - Contacts via did:key identifiziert
- ✅ **Timestamp Tracking** - createdAt, updatedAt, verifiedAt
- ✅ **Active Contact Filter** - Schneller Zugriff auf verifizierte Contacts

**API Methods:**

```typescript
addContact(contact: Contact): Promise<void>
getContact(did: string): Promise<Contact | null>
getAllContacts(): Promise<Contact[]>
updateContact(did: string, updates: Partial<Contact>): Promise<void>
activateContact(did: string): Promise<void>
removeContact(did: string): Promise<void>
getActiveContacts(): Promise<Contact[]>
```

#### VerificationHelper Class (`packages/wot-core/src/verification/VerificationHelper.ts`)

Challenge-Response-Protokoll mit WotIdentity:

- ✅ **Challenge Creation** - Nonce + Timestamp + DID + Public Key
- ✅ **Challenge Response** - Responder fügt eigene Identity-Info hinzu
- ✅ **Signature Creation** - Ed25519 signature via WotIdentity.sign()
- ✅ **Signature Verification** - Multibase public key conversion + WebCrypto verify
- ✅ **Nonce Validation** - Schutz gegen Replay-Angriffe
- ✅ **Nonce Fallback** - Nonce aus Response wenn Challenge-State verloren
- ✅ **Base64 Encoding** - QR-Code-kompatibel

**API Methods:**

```typescript
createChallenge(identity: WotIdentity, name: string): Promise<string>
respondToChallenge(code: string, identity: WotIdentity, name: string): Promise<string>
completeVerification(code: string, identity: WotIdentity, nonce: string): Promise<Verification>
verifySignature(verification: Verification): Promise<boolean>
publicKeyFromDid(did: string): string
multibaseToBytes(multibase: string): Uint8Array
```

**Verification Flow:**

1. **Anna (Initiator):** `createChallenge()` → Challenge Code (Base64)
2. **Ben (Responder):** `respondToChallenge(code)` → Response Code (Base64)
3. **Anna (Completes):** `completeVerification(responseCode)` → Signed Verification
4. **Storage:** Verification gespeichert bei Anna (Empfänger-Prinzip)
5. **Contacts:** Beide fügen sich gegenseitig als "active" Contact hinzu

#### Demo App Services

**VerificationService** - Vereinfacht zu thin wrapper:
- Core-Logik delegiert an VerificationHelper
- Storage-Persistenz für Verification-Records
- Encoding/Decoding-Helpers für QR-Codes

**ContactService** - Migriert zu ContactStorage:
- Ersetzt StorageAdapter-Calls durch ContactStorage
- Gleiche API-Oberfläche beibehalten
- Nutzt IndexedDB statt localStorage

#### Demo App Hooks

**useVerification** - Migriert zu WotIdentity:
- Ersetzt `useIdentity + KeyPair` durch `useWotIdentity`
- Nutzt VerificationHelper aus wot-core
- Challenge/Response-Flow unverändert
- Automatic contact activation nach Verification

#### QR-Code Support (Week 2 Extension)

**ShowCode Component** - QR-Code Generation:

- ✅ **Automatische QR-Generierung** - 256x256px QR-Code mit `qrcode` package
- ✅ **Visuell prominent** - QR-Code zentral angezeigt
- ✅ **Dev-Mode Fallback** - Text-Code in collapsible `<details>`
- ✅ **Copy & Paste** - Für Development ohne QR-Scanner

**ScanCode Component** - QR-Scanner:

- ✅ **Kamera-Scanner** - `html5-qrcode` mit live preview
- ✅ **"QR-Code scannen" Button** - Startet Kamera mit Permission-Request
- ✅ **Stop-Button** - Rotes X zum Abbrechen des Scans
- ✅ **Auto-Fill** - Gescannter Code wird automatisch eingetragen
- ✅ **Dev-Mode Fallback** - Manuelle Text-Eingabe in collapsible details
- ⚠️ **Kamera-Permission** - Benötigt HTTPS oder localhost für Browser-Kamera-Zugriff

### Tests Week 2

**35 neue Tests** (zusätzlich zu 29 Week 1 Tests):

#### ContactStorage Tests (15 Tests)

```typescript
✓ addContact() - store contact with did:key format
✓ addContact() - default status is pending
✓ addContact() - throws if contact already exists

✓ getContact() - retrieve by DID
✓ getContact() - returns null for non-existent

✓ getAllContacts() - returns all stored contacts
✓ getAllContacts() - returns empty array when empty

✓ updateContact() - update name
✓ updateContact() - update updatedAt timestamp
✓ updateContact() - throws if contact not found

✓ activateContact() - changes status to active
✓ activateContact() - sets verifiedAt timestamp
✓ activateContact() - throws for non-existent contact

✓ removeContact() - deletes contact from storage
✓ removeContact() - no error for non-existent

✓ getActiveContacts() - filters by active status
✓ getActiveContacts() - returns empty array when none active
```

#### VerificationIntegration Tests (20 Tests)

```typescript
✓ Challenge Creation - with WotIdentity DID and public key
✓ Challenge Creation - encodes to base64
✓ Challenge Creation - generates unique nonce
✓ Challenge Creation - includes challenger name

✓ Challenge Response - responder adds own identity
✓ Challenge Response - encodes to base64
✓ Challenge Response - preserves nonce from challenge
✓ Challenge Response - includes challenge initiator info

✓ Signature Verification - signs with WotIdentity
✓ Signature Verification - verifies using public key multibase
✓ Signature Verification - creates Ed25519Signature2020 proof
✓ Signature Verification - fails with wrong public key
✓ Signature Verification - rejects nonce mismatch

✓ Public Key Exchange - extracts key from did:key format
✓ Public Key Exchange - converts multibase to bytes
✓ Public Key Exchange - parses did:key for public key

✓ Complete Verification Flow - full mutual verification
✓ Complete Verification Flow - bidirectional verification
✓ Complete Verification Flow - nonce fallback for lost challenge state
```

### Demo App Integration Week 2

- ✅ **useWotIdentity Hook** - Demo nutzt WotIdentity statt alte Identity
- ✅ **Verification Flow** - Challenge/Response mit VerificationHelper
- ✅ **Contact Management** - ContactStorage in AdapterContext
- ✅ **Status Management** - Pending → Active nach Verification
- ✅ **Build Success** - TypeScript clean, keine Errors

### Verifizierter End-to-End Flow Week 2

User-Bestätigung: "Läuft noch und es funktioniert" ✅

1. Identity Creation in Browser
2. Challenge Generation
3. Challenge Code Copy/Paste (oder QR)
4. Response Generation
5. Response Code Copy/Paste
6. Verification Completion
7. Contact Storage (beide Seiten)

---

## Week 2+: Identity Polish ✅

### Übersicht

Verbesserungen an Identity-Persistenz und UX nach User-Testing.

### Implementiert

#### Deutsche BIP39-Wortliste

- ✅ **2048 deutsche Wörter** aus [dys2p/wordlists-de](https://github.com/dys2p/wordlists-de)
- ✅ Ersetzt englische Wortliste komplett
- ✅ Validierung: exakt 2048 Wörter, einzigartige erste 4 Zeichen
- ✅ Alle bestehenden Tests laufen weiterhin

#### Identity Persistence Bugfixes

Drei kritische Bugs nach User-Testing gefunden und behoben:

**Bug #1: Vorzeitige Speicherung während Onboarding**
- **Problem:** `create()` speicherte Identity sofort in IndexedDB, bevor User Passphrase gesetzt hatte. Reload bei Mnemonic-Anzeige zeigte Unlock-Screen.
- **Fix:** `storeSeed: false` bei `create()` im OnboardingFlow. Speicherung erst nach Passphrase-Schritt.

**Bug #2: Verlust nach Reload in der App**
- **Problem:** Nach vollständigem Onboarding ging Reload zurück zum Start statt zum Unlock-Screen.
- **Fix:** `hasStoredIdentity` State in WotIdentityContext mit `useEffect` Check beim Mount. App.tsx zeigt Loading → Unlock → App basierend auf Storage-Status.

**Bug #3: Import/Recovery speicherte nicht**
- **Problem:** RecoveryFlow rief `unlock()` ohne `storeSeed=true`. Nach Import war Identity nicht persistent.
- **Fix:** `storeSeed: true` im RecoveryFlow `handleProtect()`.

#### UX-Verbesserungen

- ✅ **Enter-Navigation** im gesamten Onboarding:
  - Step 1 (Generate): Enter → Identity generieren
  - Step 2 (Display): Enter → Weiter (wenn alle Checkboxen gesetzt)
  - Step 3 (Verify): Enter → Nächstes Input / Submit wenn letztes
  - Step 4 (Protect): Enter → Abschließen (wenn Passphrase gültig)

### Tests Week 2+

**13 neue Tests** (OnboardingFlow):

#### OnboardingFlow Tests (13 Tests)

```typescript
✓ Step 1 - generate mnemonic and DID without passphrase
✓ Step 1 - generate different mnemonics on each call

✓ Step 2 - split mnemonic into 12 words
✓ Step 2 - valid BIP39 format

✓ Step 3 - validate correct word at correct position
✓ Step 3 - reject incorrect word at position
✓ Step 3 - handle case-insensitive verification

✓ Step 4 - accept passphrase after mnemonic generated
✓ Step 4 - enforce minimum passphrase length
✓ Step 4 - accept passphrase with 8+ characters
✓ Step 4 - store identity with passphrase protection

✓ Full Flow - complete onboarding flow
```

**Gesamt: 77 Tests** (29 Week 1 + 35 Week 2 + 13 Week 2+) - alle passing ✅ (auch nach Week 3 Evolu Integration)

---

## Week 3: Evolu Integration ✅

### Übersicht Week 3

Evolu als Storage- und Sync-Framework integriert. Die Demo App nutzt jetzt Evolu (SQLite WASM + CRDT) statt des direkten IndexedDB-Adapters für Contacts, Verifications und Attestations. Identity-Daten bleiben in verschlüsseltem IndexedDB (SeedStorage).

### Warum Evolu

- **Custom Keys** (seit Nov 2025, Issue #537) - `externalAppOwner` erlaubt eigene Keys
- **BIP39-kompatibel** - `deriveFrameworkKey('evolu-storage-v1')` → 32-byte `OwnerSecret`
- **Local-first** - SQLite WASM mit OPFS, CRDT-basierter Sync
- **TypeScript-native** - Effect Schema für Type Safety
- **React Integration** - Provider, Hooks, Queries

Details: [docs/protokolle/framework-evaluation.md](./protokolle/framework-evaluation.md)

### Implementiert Week 3

#### Evolu Schema & Setup (`apps/demo/src/db.ts`)

Zentrales Schema mit 4 Tabellen und WotIdentity-Key-Integration:

- ✅ **4 Tabellen** - contact, verification, attestation, attestationMetadata
- ✅ **Branded ID Types** - `ContactId`, `VerificationId`, `AttestationId`, `AttestationMetadataId`
- ✅ **Effect Schema Types** - `NonEmptyString1000`, `SqliteBoolean`, `nullOr()`
- ✅ **Custom Key Integration** - `deriveFrameworkKey('evolu-storage-v1')` → `OwnerSecret` → `AppOwner`
- ✅ **Local-only Transports** - `transports: []` (Sync kommt später)
- ✅ **Instance Management** - `createWotEvolu()`, `getEvolu()`, `isEvoluInitialized()`

```typescript
// Key Integration Pattern:
const frameworkKey = await identity.deriveFrameworkKey('evolu-storage-v1')
const ownerSecret = frameworkKey as unknown as OwnerSecret
const appOwner = createAppOwner(ownerSecret)
const evolu = createEvolu(evoluReactWebDeps)(Schema, {
  name: SimpleName.orThrow('wot'),
  externalAppOwner: appOwner,
  transports: [],
})
```

#### EvoluStorageAdapter (`apps/demo/src/adapters/EvoluStorageAdapter.ts`)

Implementiert `StorageAdapter` Interface mit Evolu als Backend:

- ✅ **Identity in localStorage** - Nicht in Evolu (local-only, kein Sync nötig)
- ✅ **Contacts in Evolu** - CRUD mit deterministic IDs via `createIdFromString<'Contact'>(did)`
- ✅ **Verifications in Evolu** - Empfänger-Prinzip beibehalten
- ✅ **Attestations in Evolu** - Inkl. Metadata (accepted/acceptedAt)
- ✅ **JSON Serialization** - Proof, GeoLocation, tags als JSON Strings in `NonEmptyString1000`
- ✅ **Soft Delete** - Evolu nutzt `isDeleted` statt physischem Löschen
- ✅ **Row Mappers** - Konvertierung Evolu Rows ↔ WoT Types

**Key Patterns:**
```typescript
// Deterministic branded IDs
createIdFromString<'Contact'>(contact.did)

// Branded strings
const str = (s: string) => NonEmptyString1000.orThrow(s)

// Boolean conversion
booleanToSqliteBoolean(true)  // → 1
sqliteBooleanToBoolean(row.accepted)  // → true/false
```

#### Provider-Hierarchie (geändert)

WotIdentity muss vor Evolu initialisiert werden (Evolu braucht abgeleitete Keys):

```
// Vorher (Week 2):
BrowserRouter > AdapterProvider > IdentityProvider > WotIdentityProvider > Routes

// Nachher (Week 3):
BrowserRouter > WotIdentityProvider > RequireIdentity > AdapterProvider(identity) > IdentityProvider > Routes
```

- ✅ **AdapterProvider** akzeptiert jetzt `identity: WotIdentity` prop
- ✅ **Async Initialization** - Evolu wird in `useEffect` initialisiert
- ✅ **RequireIdentity** - Rendert AdapterProvider erst nach Identity-Unlock

#### TypeScript Compatibility

`exactOptionalPropertyTypes: true` in tsconfig (Evolu-Requirement) erforderte 4 Fixes:

- ✅ `AttestationCard.tsx` - Optional props `?: string | undefined`
- ✅ `ContactService.ts` - Spread pattern statt `undefined` assignment
- ✅ `AttestationService.ts` - Spread pattern für tags
- ✅ `LocalStorageAdapter.ts` - Spread pattern für acceptedAt

### Packages

```json
{
  "@evolu/common": "^7.4.1",
  "@evolu/react": "^10.4.0",
  "@evolu/react-web": "^2.4.0"
}
```

### Build Output

Evolu bringt SQLite WASM mit (~1MB):
- `Db.worker-*.js` (~497KB) - SQLite Worker
- `sqlite3.wasm` (~1MB) - SQLite WASM Binary
- OPFS (Origin Private File System) für Browser-Storage

### Tests Week 3

- ✅ **77/77 bestehende Tests passing** - Keine Regressionen
- ✅ **TypeScript clean** - 0 Errors mit `exactOptionalPropertyTypes`
- ✅ **Vite Build erfolgreich** - SQLite WASM + Workers korrekt gebundelt

---

## Week 3+: Architektur-Revision (2026-02-08)

### Übersicht

Während der Evolu-Integration wurde eine fundamentale Lücke offensichtlich: **Evolu kann kein Cross-User Messaging.** Evolu synchronisiert nur innerhalb desselben Owners (Single-User, Multi-Device). SharedOwner-API existiert, ist aber nicht funktional (Discussion #558, Feb 2026).

Dies führte zu einer umfassenden Neu-Evaluation des gesamten Technology-Stacks und einer Erweiterung der Adapter-Architektur.

### Zentrale Erkenntnis

> **Ein einzelnes Framework kann unsere Anforderungen nicht erfüllen.**
>
> CRDT/Sync (Zustandskonvergenz) und Messaging (Cross-User Delivery) sind
> zwei orthogonale Probleme, die unterschiedliche Lösungen brauchen.

### Was passiert ist

1. **Evolu-Limitation erkannt** — SharedOwner nicht funktional, kein Cross-User Messaging
2. **8 Frameworks evaluiert** — Nostr, Matrix, DIDComm, ActivityPub, Iroh, Willow/Earthstar + Updates für DXOS, p2panda
3. **6 eliminiert** — ActivityPub (kein E2EE), Nostr (secp256k1 ≠ Ed25519), DXOS (P-256 ≠ Ed25519), DIDComm (stale JS-Libs), Iroh (nur Networking-Layer), p2panda (kein JS SDK)
4. **3-Achsen-Architektur definiert** — Discovery (öffentlich, pre-contact) → Messaging (1:1, post-contact) → Replication (group, CRDT)
5. **7-Adapter-Architektur v2** — 4 neue Interfaces (MessagingAdapter, ReplicationAdapter, DiscoveryAdapter, AuthorizationAdapter)
6. **3 Sharing-Patterns identifiziert** — Group Spaces, Selective Sharing, 1:1 Delivery
7. **UCAN-ähnliche Capabilities** als cross-cutting Concern erkannt

### Neue Adapter-Architektur (v2)

| Adapter | Status | Implementierung |
|---------|--------|----------------|
| StorageAdapter | ✅ Implementiert | EvoluStorageAdapter |
| ReactiveStorageAdapter | ✅ Implementiert | EvoluStorageAdapter |
| CryptoAdapter | ✅ Implementiert | WebCryptoAdapter (Ed25519 + AES-256-GCM symmetric) |
| DiscoveryAdapter | ✅ Implementiert | HttpDiscoveryAdapter (wot-profiles HTTP Service) |
| MessagingAdapter | ✅ Implementiert | InMemory + WebSocket (Heartbeat) + Outbox (Decorator) + wot-relay |
| ReplicationAdapter | ✅ Implementiert | AutomergeReplicationAdapter (Encrypted CRDT Spaces) |
| AuthorizationAdapter | ⏳ Spezifiziert | UCAN-like (Phase 3+) |

### Empfohlener Stack

| Achse | POC | Produktion |
|-------|-----|------------|
| CRDT/Sync | Evolu (lokale Persistenz + Multi-Device) | Automerge (Cross-User Spaces) |
| Messaging | Custom WebSocket Relay | Matrix (Gruppen-E2EE, Federation) |
| Authorization | NoOp (Creator = Admin) | Custom UCAN-like (Delegation Chains) |

### Was sich NICHT geändert hat

- **wot-core Package** — Alle Types, Interfaces und Implementierungen bleiben stabil
- **Alle Tests** — Keine Regressionen bei Architektur-Änderungen
- **WotIdentity** — BIP39, Ed25519, HKDF, did:key — alles unverändert
- **Evolu als Storage** — Bleibt für lokale Persistenz + Multi-Device Sync
- **Empfänger-Prinzip** — Bestätigt als fundamentales Designprinzip

### Neue Dokumentation

- [Framework-Evaluation v2](./protokolle/framework-evaluation.md) — 16 Frameworks evaluiert, Anforderungs-Matrix
- [Adapter-Architektur v2](./protokolle/adapter-architektur-v2.md) — 6-Adapter-Spezifikation, Interaction-Flows
- [Architektur](./datenmodell/architektur.md) — Schichtenmodell aktualisiert

---

## Week 3++: MessagingAdapter + WebSocket Relay (2026-02-08) ✅

### Übersicht

MessagingAdapter-Interface implementiert, WebSocket Relay Server gebaut, Demo App mit Relay verbunden. **Attestation-Delivery funktioniert end-to-end über den Relay.**

### Implementiert

#### MessagingAdapter Interface + Types (`packages/wot-core`)

Neue Types für Cross-User-Messaging:

- ✅ **MessageEnvelope** — Standardisiertes Envelope-Format (v, id, type, fromDid, toDid, encoding, payload, signature, ref)
- ✅ **DeliveryReceipt** — Multi-Stage (accepted → delivered → acknowledged → failed)
- ✅ **MessagingState** — disconnected | connecting | connected | error
- ✅ **ResourceRef** — Branded string `wot:<type>:<id>` für Ressourcen-Adressierung (5 Typen)
- ✅ **8 MessageTypes** — verification, attestation, contact-request, item-key, space-invite, group-key-rotation, ack, content
- ✅ **MessagingAdapter Interface** — connect, disconnect, getState, send, onMessage, onReceipt, registerTransport, resolveTransport
- ✅ **OutboxStore Interface** — enqueue, dequeue, getPending, has, incrementRetry, count
- ✅ **OutboxEntry Type** — envelope, createdAt, retryCount

#### InMemoryMessagingAdapter (`packages/wot-core`)

Test-Adapter mit shared-bus Pattern:

- ✅ **Shared static registry** — Map<did, adapter> für In-Memory Message Routing
- ✅ **Offline Queue** — Nachrichten an nicht-verbundene DIDs werden gepuffert
- ✅ **resetAll()** — Test-Isolation

#### WebSocket Relay Server (`packages/wot-relay`)

Minimaler Node.js WebSocket Relay (blind, self-hostable):

- ✅ **DID → WebSocket Mapping** — In-Memory, ephemeral
- ✅ **SQLite Offline Queue** — `better-sqlite3` mit WAL Mode, überlebt Restarts
- ✅ **Relay-Protokoll** — JSON über WebSocket: register/send → registered/message/receipt/error
- ✅ **Blind Relay** — Payload ist `Record<string, unknown>`, Relay sieht keinen Inhalt
- ✅ **CLI Entry Point** — `src/start.ts` mit PORT + DB_PATH Env-Variablen
- ✅ **Delivery Receipts** — accepted (offline) / delivered (online)

#### WebSocketMessagingAdapter (`packages/wot-core`)

Browser-nativer WebSocket Client:

- ✅ **Browser WebSocket API** — Keine `ws` Dependency in wot-core
- ✅ **Implements MessagingAdapter** — connect, disconnect, send, onMessage, onReceipt
- ✅ **Pending Receipts** — Korreliert send() → receipt via Message-ID
- ✅ **Ping/Pong Heartbeat** — 15s Ping, 5s Timeout → erkennt tote TCP-Verbindungen

#### Demo App Integration

- ✅ **AdapterContext** — WebSocketMessagingAdapter initialisiert, connect(did) nach Evolu-Init
- ✅ **useMessaging Hook** — send, onMessage, state, isConnected
- ✅ **Home Page** — Relay-Status-Anzeige (Wifi/WifiOff Icons, grün/amber/grau)
- ✅ **AttestationService** — Sendet Attestation nach lokaler Speicherung als MessageEnvelope via Relay
- ✅ **useAttestations** — onMessage-Listener empfängt, verifiziert und speichert eingehende Attestationen automatisch
- ✅ **Profil-Verwaltung** — Name editierbar auf Identity-Page, Profil wird bei Init automatisch in localStorage angelegt
- ✅ **RecoveryFlow** — Enter-Navigation in allen Schritten (analog OnboardingFlow)

#### Attestation-Delivery E2E Flow

1. Alice erstellt Attestation → lokal gespeichert + MessageEnvelope an Bobs DID via Relay
2. Bob empfängt Envelope via onMessage → verifiziert Signatur → speichert lokal
3. Attestation erscheint automatisch in Bobs UI (via ReactiveStorage/Subscribable)
4. Funktioniert auch offline: Relay queued in SQLite, liefert bei Reconnect nach

### Tests

**15 neue Tests** (wot-relay, 2 Dateien):

#### Relay Tests (9 Tests)
```
✓ Register DID
✓ Send to online recipient + delivered receipt
✓ Send to offline + accepted receipt
✓ Deliver queued messages on connect
✓ Error without register
✓ Error on invalid JSON
✓ Disconnect cleanup
✓ Multiple clients
✓ Large envelope
```

#### Integration Tests (6 Tests)
```
✓ Send attestation Alice → Bob over real relay
✓ All message types
✓ ResourceRef in envelope
✓ Offline queuing + delivery
✓ Receipt callbacks
✓ Bidirectional messaging
```

**28 neue Tests** (wot-core, MessagingAdapter + ResourceRef):

#### ResourceRef Tests (14 Tests)
```
✓ Create all 5 resource types (attestation, verification, contact, space, item)
✓ Parse round-trip
✓ Sub-paths
✓ DID with colons in ID
✓ Error cases (unknown type, invalid format)
```

#### MessagingAdapter Tests (14 Tests)
```
✓ Lifecycle (connect, disconnect, getState)
✓ Send/receive between two adapters
✓ All 8 message types
✓ Offline queuing + delivery on connect
✓ Receipts
✓ Transport resolution
✓ resetAll for test isolation
```

**Gesamt Week 4: 132 Tests** (106 wot-core + 11 wot-profiles + 15 wot-relay) — alle passing ✅

### Packages (neu)

```json
// packages/wot-relay/package.json
{
  "name": "@real-life/wot-relay",
  "dependencies": {
    "ws": "^8.18",
    "better-sqlite3": "^11.9"
  }
}
```

### Commits

16. **feat: Add MessagingAdapter interface with InMemory implementation** — Types, Interface, InMemory, 28 Tests
17. **feat: Add WebSocket relay server and WebSocketMessagingAdapter** — wot-relay Package, Integration Tests
18. **feat: Connect demo app to WebSocket relay for live attestation delivery** — Demo Integration, Profil-Verwaltung, RecoveryFlow Enter-Nav

### Week 4 Commits

19. **feat: Add symmetric encryption (AES-256-GCM) to CryptoAdapter** — Interface + WebCryptoAdapter, 10 Tests
20. **feat: Add JWS signing to WotIdentity and ProfileService** — signJws, ProfileService, PublicProfile, 9 Tests
21. **feat: Add wot-profiles HTTP service for public profile sync** — Standalone Package, SQLite, JWS Verify, REST API, 11 Tests
22. **feat: Integrate profile sync in demo app** — useProfileSync Hook, Identity Page Upload

---

## Week 4: Profile Sync + Symmetrische Encryption (2026-02-10) ✅

### Übersicht

Zwei Phasen implementiert (Test-First, RED → GREEN):

1. **Symmetrische Encryption** — AES-256-GCM im CryptoAdapter (Grundlage für E2EE Group Spaces)
2. **Öffentliches Profil-System** — JWS-signierte Profile, eigener HTTP Service (`wot-profiles`), Demo-App Integration

Außerdem: SyncAdapter entfernt (ersetzt durch zukünftigen ReplicationAdapter).

### Phase 2: Symmetrische Encryption (AES-256-GCM) ✅

3 neue Methoden im CryptoAdapter Interface und WebCryptoAdapter:

- ✅ **generateSymmetricKey()** — `crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 })` → 32-byte Uint8Array
- ✅ **encryptSymmetric(plaintext, key)** — 12-byte Random-Nonce, AES-GCM Encryption (Auth-Tag inkludiert)
- ✅ **decryptSymmetric(ciphertext, nonce, key)** — AES-GCM Decryption mit Auth-Tag-Verifikation

**Tests (10 Tests):**
```
✓ generateSymmetricKey() - returns 32 bytes
✓ generateSymmetricKey() - generates different keys each time
✓ encryptSymmetric/decryptSymmetric - round-trip
✓ encryptSymmetric - different ciphertexts for same plaintext (random nonce)
✓ decryptSymmetric - fails with wrong key
✓ decryptSymmetric - fails with wrong nonce
✓ decryptSymmetric - fails with tampered ciphertext (GCM auth tag)
✓ encryptSymmetric/decryptSymmetric - handles empty plaintext
✓ encryptSymmetric/decryptSymmetric - handles large plaintext (64KB)
✓ encryptSymmetric - returns 12-byte nonce
```

### Phase 1: Öffentliches Profil-System ✅

#### Architektur

```
┌─────────────────┐     ┌─────────────────┐
│  wot-relay       │     │  wot-profiles    │
│  (WebSocket)     │     │  (HTTP/REST)     │
│                  │     │                  │
│  - Messaging     │     │  - GET /p/{did}  │
│  - Offline Queue │     │  - PUT /p/{did}  │
│  - Blind Relay   │     │  - JWS Verify    │
│                  │     │  - SQLite Store  │
└─────────────────┘     └─────────────────┘
     Port 8787               Port 8788
```

Begründung für separaten Service: Relay = WebSocket-Transport (austauschbar), Profiles = öffentliches REST-API. Verschiedene Protokolle, verschiedene Concerns.

#### WotIdentity.signJws() (`packages/wot-core`)

- ✅ **signJws(payload)** — Signiert beliebige Payload als JWS Compact Serialization (EdDSA/Ed25519)
- Nutzt internen non-extractable Private Key
- Wirft `'Identity not unlocked'` wenn Identity gesperrt

#### ProfileService (`packages/wot-core/src/services/ProfileService.ts`)

Statische Methoden für self-certifying Profile:

- ✅ **signProfile(profile, identity)** — Erzeugt JWS aus PublicProfile
- ✅ **verifyProfile(jws)** — Extrahiert DID aus Payload → Public Key auflösen → JWS verifizieren
- Erkennt DID-Mismatch (Payload-DID ≠ Signatur-Key-DID)

#### PublicProfile Type (`packages/wot-core/src/types/identity.ts`)

```typescript
interface PublicProfile {
  did: string
  name: string
  bio?: string
  avatar?: string
  updatedAt: string
}
```

#### wot-profiles Package (`packages/wot-profiles`)

Eigenständiger HTTP Service — **keine wot-core Dependency** in Produktion:

- ✅ **ProfileStore** — SQLite (better-sqlite3, WAL Mode), Upsert via ON CONFLICT
- ✅ **Standalone JWS Verify** — Eigene Base64URL/Base58/did:key Auflösung (kein wot-core Import)
- ✅ **HTTP Server** — Node.js `http.createServer` mit CORS
- ✅ **PUT /p/{did}** — JWS-Signatur verifizieren, DID-Match prüfen (URL ≠ Payload → 403), speichern
- ✅ **GET /p/{did}** — Gespeichertes JWS zurückgeben (Content-Type: application/jws)

#### Demo App Integration

- ✅ **useProfileSync Hook** — `uploadProfile()`, `fetchContactProfile()`, Auto-Sync bei Mount, profile-update Listener
- ✅ **Identity Page** — Ruft `uploadProfile()` nach Profil-Speichern auf
- ✅ **MessageType 'profile-update'** — Neuer Nachrichtentyp für Profile-Änderungen

### Tests Week 4

**30 neue Tests:**

#### Symmetric Crypto Tests (10 Tests)
```
packages/wot-core/tests/SymmetricCrypto.test.ts
✓ Key generation (2), Round-trip (1), Random nonce (1),
✓ Wrong key/nonce/tampered (3), Empty/large plaintext (2), Nonce length (1)
```

#### WotIdentity signJws Tests (3 Tests)
```
packages/wot-core/tests/WotIdentity.test.ts (erweitert)
✓ JWS compact serialization format
✓ Verifiable with public key
✓ Throws when identity is locked
```

#### ProfileService Tests (6 Tests)
```
packages/wot-core/tests/ProfileService.test.ts
✓ signProfile returns JWS string
✓ verifyProfile with valid profile
✓ Reject tampered JWS
✓ Reject mismatched DID
✓ Reject invalid JWS format
✓ Round-trip preserves all fields
```

#### wot-profiles Tests (11 Tests)
```
packages/wot-profiles/tests/profile-store.test.ts (4 Tests)
✓ Store and retrieve JWS by DID
✓ Return null for unknown DID
✓ Upsert existing DID
✓ Persist updated_at timestamp

packages/wot-profiles/tests/profile-rest.test.ts (7 Tests)
✓ PUT valid JWS → 200
✓ PUT mismatched DID → 403
✓ PUT invalid JWS → 400
✓ PUT empty body → 400
✓ GET stored profile → 200
✓ GET unknown DID → 404
✓ CORS headers present
```

**Gesamt: 132 Tests** (106 wot-core + 11 wot-profiles + 15 wot-relay) — alle passing ✅

### Entfernungen

- **SyncAdapter** — Interface und NoOpSyncAdapter entfernt. Wird durch zukünftigen ReplicationAdapter (Automerge) ersetzt.

---

## Week 5: Encrypted Group Spaces — Foundations (2026-02-11) ✅

### Übersicht

Phase 3 des Plans: Asymmetrische Encryption, EncryptedSyncService und GroupKeyService — die drei Grundbausteine für Encrypted Group Spaces. Außerdem: wot-profiles Docker-Deployment auf `profiles.utopia-lab.org`.

### Architektur-Entscheidung: Separater HKDF-Pfad

Statt Ed25519→X25519 Konvertierung (mit `@noble/curves`) oder separatem Key Pair wurde ein **dritter Weg** gewählt: Ein eigener HKDF-Pfad vom gleichen Master Seed.

```
BIP39 Mnemonic
     ↓
Master Seed (32 bytes)
     ↓ HKDF
     ├─→ 'wot-identity-v1'   → Ed25519 (Signing, DID)
     ├─→ 'wot-encryption-v1' → X25519 (Encryption, ECDH)  ← NEU
     └─→ 'evolu-storage-v1'  → Evolu OwnerSecret
```

**Vorteile:**
- Ein Seed, kryptographisch unabhängige Keys
- Keine externe Dependency (`@noble/curves` nicht nötig)
- Rein WebCrypto API — keine Drittbibliotheken für Phase 3
- Sicherheits-theoretisch sauber (keine Cross-Curve-Konvertierung nötig)

**Referenz:** Option C wurde nach Evaluation von Thormarker 2021 (formaler Sicherheitsbeweis für Ed25519→X25519) gewählt. Die Konvertierung wäre sicher gewesen, aber der separate HKDF-Pfad ist eleganter.

### Implementiert

#### Asymmetrische Encryption (ECIES-like Pattern)

**WotIdentity erweitert** (`packages/wot-core/src/identity/WotIdentity.ts`):

- ✅ **deriveEncryptionKeyPair()** — HKDF(`'wot-encryption-v1'`) → X25519 Key Pair
- ✅ **getEncryptionKeyPair()** — Lazy-Init, cached X25519 CryptoKeyPair
- ✅ **getEncryptionPublicKeyBytes()** — 32-byte Raw Public Key (zum Teilen)
- ✅ **encryptForRecipient(plaintext, recipientPublicKeyBytes)** — ECIES: Ephemeral X25519 → ECDH → HKDF(`'wot-ecies-v1'`) → AES-256-GCM
- ✅ **decryptForMe(payload)** — Reverse ECIES mit eigenem statischen X25519 Key
- ✅ **wrapX25519PrivateKey()** — PKCS8 DER Wrapping für WebCrypto Import

**EncryptedPayload Type** (`packages/wot-core/src/adapters/interfaces/CryptoAdapter.ts`):
```typescript
export interface EncryptedPayload {
  ciphertext: Uint8Array
  nonce: Uint8Array
  ephemeralPublicKey?: Uint8Array  // 32 bytes, für ECIES
}
```

#### EncryptedSyncService (`packages/wot-core/src/services/EncryptedSyncService.ts`)

Verschlüsselt/entschlüsselt CRDT-Changes mit einem Group Key (AES-256-GCM). Encrypt-then-sync Pattern:

- ✅ **encryptChange(data, groupKey, spaceId, generation, fromDid)** — AES-256-GCM mit Random-Nonce
- ✅ **decryptChange(change, groupKey)** — Entschlüsselung mit Auth-Tag-Verifikation

```typescript
interface EncryptedChange {
  ciphertext: Uint8Array
  nonce: Uint8Array
  spaceId: string
  generation: number  // Key-Generation für Key-Lookup
  fromDid: string
}
```

#### GroupKeyService (`packages/wot-core/src/services/GroupKeyService.ts`)

In-Memory Key-Management pro Space mit Generation-Tracking:

- ✅ **createKey(spaceId)** — Erzeugt 32-byte Key (Generation 0)
- ✅ **rotateKey(spaceId)** — Neue Generation, alte Keys bleiben zugänglich
- ✅ **getCurrentKey(spaceId)** — Aktueller Key (neueste Generation)
- ✅ **getKeyByGeneration(spaceId, generation)** — Alter Key für historische Nachrichten
- ✅ **getCurrentGeneration(spaceId)** — Aktuelle Generation (-1 wenn unbekannt)
- ✅ **importKey(spaceId, key, generation)** — Key von Invite importieren

### wot-profiles Deployment

- ✅ **Dockerfile** — Multi-Stage Build (Node 22-slim, better-sqlite3 native compilation)
- ✅ **docker-compose.yml** — Port 8788, SQLite Volume, gleiche Netzwerk-Konfiguration wie wot-relay
- ✅ **Produktion** — Live unter `profiles.utopia-lab.org` (Caddy Reverse Proxy)
- ✅ **E2E-Test gegen Produktion** — PUT/GET/Tamper/DID-Mismatch/CORS bestanden
- ✅ **Demo App verbunden** — `VITE_PROFILE_SERVICE_URL=https://profiles.utopia-lab.org`

### Tests Week 5

**34 neue Tests:**

#### Asymmetric Crypto Tests (16 Tests)
```
packages/wot-core/tests/AsymmetricCrypto.test.ts
✓ deriveEncryptionKeyPair - returns X25519 key pair
✓ deriveEncryptionKeyPair - deterministic (same identity = same public key)
✓ deriveEncryptionKeyPair - different from Ed25519 identity key
✓ deriveEncryptionKeyPair - different keys for different identities
✓ deriveEncryptionKeyPair - throws when identity is locked
✓ encryptForRecipient/decryptForMe - round-trip
✓ encryptForRecipient/decryptForMe - wrong recipient fails
✓ encryptForRecipient - different ciphertexts (ephemeral key)
✓ encryptForRecipient/decryptForMe - tampered ciphertext fails
✓ encryptForRecipient/decryptForMe - tampered ephemeral key fails
✓ encryptForRecipient/decryptForMe - empty plaintext
✓ encryptForRecipient/decryptForMe - large plaintext (1MB)
✓ encryptForRecipient - 12-byte nonce
✓ encryptForRecipient/decryptForMe - throws when locked
✓ getEncryptionPublicKeyBytes - returns 32 bytes
✓ getEncryptionPublicKeyBytes - deterministic
```

#### EncryptedSyncService Tests (8 Tests)
```
packages/wot-core/tests/EncryptedSyncService.test.ts
✓ Encrypt change with group key
✓ Decrypt change with correct group key
✓ Fail with wrong group key
✓ Include spaceId and generation in metadata
✓ Include fromDid in metadata
✓ Different ciphertexts for same data (random nonce)
✓ Fail with tampered ciphertext
✓ Handle empty data
```

#### GroupKeyService Tests (10 Tests)
```
packages/wot-core/tests/GroupKeyService.test.ts
✓ Create new group key for space
✓ Track key generations
✓ Retrieve current key for space
✓ Retrieve key by generation (old messages)
✓ Rotate key and increment generation
✓ Keep old keys accessible after rotation
✓ Return null for unknown space
✓ Throw when rotating key for unknown space
✓ Manage multiple spaces independently
✓ Generate different keys on each creation
```

**Gesamt: ~156 Tests** (140 wot-core + 11 wot-profiles + 15 wot-relay) — alle passing ✅

### Commits

23. **feat: Add asymmetric encryption (X25519 ECIES), EncryptedSyncService, GroupKeyService** — Phase 3 Foundations, 34 Tests

---

## Week 5+: AutomergeReplicationAdapter (2026-02-11) ✅

### Übersicht

Phase 3 abgeschlossen: **AutomergeReplicationAdapter** — der CRDT-Motor für verschlüsselte Group Spaces. Kombiniert Automerge (CRDT), EncryptedSyncService (AES-256-GCM), GroupKeyService (Key-Generationen) und MessagingAdapter (Transport).

### Architektur-Entscheidung: Automerge als External

Automerge wird als `external` in `rollupOptions` markiert (nicht gebundelt). Da wot-core ein Library-Package ist, installieren Consumer (z.B. die Demo-App) Automerge selbst. Das vermeidet WASM-Bundling-Probleme.

### Implementiert

#### ReplicationAdapter Interface (`packages/wot-core/src/adapters/interfaces/ReplicationAdapter.ts`)

Zwei Interfaces für CRDT-Spaces:

- ✅ **SpaceHandle\<T\>** — Typed access auf ein CRDT-Dokument
  - `getDoc()` — Aktueller Read-Only Snapshot
  - `transact(fn)` — Änderung → Encrypt → Broadcast an alle Members
  - `onRemoteUpdate(cb)` — Callback bei Remote-Changes
  - `close()` — Handle schließen, Subscription aufräumen

- ✅ **ReplicationAdapter** — Space-Management mit verschlüsseltem Transport
  - `start()` / `stop()` — Lifecycle
  - `createSpace(type, initialDoc)` — Neuen Automerge-Space erstellen
  - `openSpace(spaceId)` — SpaceHandle öffnen
  - `addMember(spaceId, did, encPubKey)` — Member einladen (verschlüsselte Group-Key-Übergabe)
  - `removeMember(spaceId, did)` — Member entfernen + Key-Rotation
  - `onMemberChange(cb)` — Membership-Änderungen

#### AutomergeReplicationAdapter (`packages/wot-core/src/adapters/replication/AutomergeReplicationAdapter.ts`)

Vollständige Implementierung (~470 Zeilen):

- ✅ **Space Creation** — `Automerge.from(initialDoc)` + `GroupKeyService.createKey()`
- ✅ **Transact** — `Automerge.change()` → `getChanges()` → `EncryptedSyncService.encryptChange()` → `messaging.send()` an alle Members
- ✅ **Space Invite Flow** — Group Key mit ECIES für Empfänger verschlüsselt + verschlüsselter Doc-Snapshot
- ✅ **Content Receive** — Decrypt → Split Changes (via `changeLengths`) → `Automerge.applyChanges()` → Notify Handles
- ✅ **Key Rotation** — Bei `removeMember()`: Neuer Key, alte Keys bleiben für historische Nachrichten
- ✅ **Forward Secrecy** — Entfernte Members können neue Changes nicht entschlüsseln
- ✅ **3 Message-Typen** — `space-invite`, `content`, `group-key-rotation`

**Data Flow:**

```
Alice.transact(fn)
  → Automerge.change(doc, fn)
  → Automerge.getChanges(before, after)
  → EncryptedSyncService.encryptChange(changes, groupKey)
  → messaging.send({ type: 'content', payload: encrypted })
  → Bob.handleContentMessage()
    → EncryptedSyncService.decryptChange(encrypted, groupKey)
    → Automerge.applyChanges(doc, changes)
    → handle._notifyRemoteUpdate()
```

#### Space Types (`packages/wot-core/src/types/space.ts`)

```typescript
type ReplicationState = 'idle' | 'syncing' | 'error'

interface SpaceInfo {
  id: string
  type: 'personal' | 'shared'
  members: string[] // DIDs
  createdAt: string
}

interface SpaceMemberChange {
  spaceId: string
  did: string
  action: 'added' | 'removed'
}
```

### Tests Week 5+

**16 neue Tests:**

#### AutomergeReplication Tests (16 Tests)
```
packages/wot-core/tests/AutomergeReplication.test.ts

Space Lifecycle:
✓ Create space with Automerge doc
✓ List spaces
✓ Get space by ID
✓ Return null for unknown space

SpaceHandle:
✓ Open space and get handle
✓ Transact: change doc locally
✓ Transact sends encrypted changes via messaging

Space Invite + Sync:
✓ AddMember sends space-invite message
✓ Invited user can join space after invite
✓ Sync changes Alice → Bob
✓ Bidirectional sync (Alice ↔ Bob)

Key Rotation:
✓ RemoveMember rotates key (generation increments)
✓ Forward secrecy: removed member cannot decrypt new changes

Callbacks:
✓ onRemoteUpdate callback fires on received changes

Adapter State:
✓ Adapter state management (start/stop)
✓ onMemberChange callback fires
```

**Gesamt: 190 Tests** (156 wot-core + 19 wot-profiles + 15 wot-relay) — alle passing ✅

### Dependencies

```json
// packages/wot-core/package.json
{
  "@automerge/automerge": "^3.2.3"  // NEU — als external in rollupOptions
}
```

### Commits

24. **feat: Add AutomergeReplicationAdapter with encrypted CRDT spaces** — 16 Tests, ReplicationAdapter Interface, SpaceHandle, Space Invite, Key Rotation

---

## Week 5++: DiscoveryAdapter — 7. Adapter (2026-02-11) ✅

### Übersicht

DiscoveryAdapter als 7. Adapter-Interface formalisiert und implementiert. Beantwortet die Frage "Wer ist diese DID?" — öffentlich, signiert (JWS), nicht verschlüsselt. Bestehende direkte `fetch()`-Aufrufe in der Demo-App wurden durch den Adapter ersetzt.

### Drei Achsen

```
Discovery (öffentlich, pre-contact)
  → "Wer ist DID xyz?"
  → Profile, Verifikationen, Attestationen abrufen

Messaging (1:1, post-contact)
  → "Sende Nachricht an DID xyz"
  → Attestationen, Profile-Updates, Space-Invites

Replication (group, CRDT)
  → "Synchronisiere Daten in Space xyz"
  → Automerge Changes, verschlüsselt
```

### Implementiert

#### DiscoveryAdapter Interface (`packages/wot-core/src/adapters/interfaces/DiscoveryAdapter.ts`)

Formales Interface mit 6 Methoden — 3 zum Publizieren (JWS-signiert), 3 zum Abrufen (JWS-verifiziert):

- ✅ **publishProfile(data, identity)** — Eigenes Profil als JWS publizieren
- ✅ **publishVerifications(data, identity)** — Eigene Verifikationen als JWS publizieren
- ✅ **publishAttestations(data, identity)** — Akzeptierte Attestationen als JWS publizieren
- ✅ **resolveProfile(did)** — Profil einer DID abrufen und JWS verifizieren
- ✅ **resolveVerifications(did)** — Verifikationen einer DID abrufen
- ✅ **resolveAttestations(did)** — Attestationen einer DID abrufen

Neue Typen:

```typescript
interface PublicVerificationsData {
  did: string
  verifications: Verification[]
  updatedAt: string
}

interface PublicAttestationsData {
  did: string
  attestations: Attestation[]
  updatedAt: string
}
```

#### HttpDiscoveryAdapter (`packages/wot-core/src/adapters/discovery/HttpDiscoveryAdapter.ts`)

POC-Implementierung gegen wot-profiles HTTP Service:

- ✅ **Publish** — `identity.signJws(data)` → `PUT /p/{did}` (bzw. `/v`, `/a`)
- ✅ **Resolve** — `GET /p/{did}` → `ProfileService.verifyProfile(jws)` → verifiziertes Profil
- ✅ **Error Handling** — `null`/`[]` bei 404, throw bei Server-Fehlern

#### Demo-App Refactoring

**AdapterContext** — `HttpDiscoveryAdapter` instanziiert mit `PROFILE_SERVICE_URL`, im Provider bereitgestellt.

**useProfileSync** — Alle direkten `fetch()`-Aufrufe ersetzt:
- `fetch(PUT /p/{did})` → `discovery.publishProfile(profile, identity)`
- `fetch(GET /p/{did})` → `discovery.resolveProfile(contactDid)`
- 2× `fetch(PUT /p/{did}/v|a)` → `discovery.publishVerifications()` + `discovery.publishAttestations()`

**PublicProfile.tsx** — Refactored mit Fallback-Pattern:
- Eingeloggt: `discovery` aus `useAdapters()`
- Nicht eingeloggt: Module-level `fallbackDiscovery = new HttpDiscoveryAdapter(PROFILE_SERVICE_URL)`
- `fetchAll()` vereinfacht zu `Promise.all([discovery.resolveProfile(), resolveVerifications(), resolveAttestations()])`

### Tests Week 5++

Keine neuen Tests nötig — die bestehenden wot-profiles Tests (19) decken die HTTP-Endpunkte ab, und die Demo-App funktioniert wie vorher.

**Gesamt (vor Week 5+++): 190 Tests** (156 wot-core + 19 wot-profiles + 15 wot-relay) — alle passing ✅

---

## Week 5+++: Offline-First Discovery + Reactive Identity (2026-02-14) ✅

### Übersicht

Vier zusammenhängende Verbesserungen für Offline-Fähigkeit und reaktive Daten: Identity-Refactoring (Evolu als Single Source of Truth), Offline-First Discovery Layer, Reactive Identity mit Offline-Fallback für Public Profiles, und Profile-Upload-Fix.

### Implementiert

#### Identity-Refactoring: localStorage eliminiert (`e1a54cd`)

- ✅ **Evolu ist Single Source of Truth** — Identity-Daten (Name, Bio, Avatar) werden nicht mehr parallel in localStorage gehalten
- ✅ **Migration** — Bestehende localStorage-Daten werden beim ersten Start nach Evolu migriert
- ✅ **Vereinfachung** — Keine Synchronisationsprobleme mehr zwischen zwei Stores

#### Offline-First Discovery Layer (`55d82a3`)

Neues Wrapper-Pattern: `OfflineFirstDiscoveryAdapter` umschließt `HttpDiscoveryAdapter` und fügt Offline-Cache + Dirty-Flag-Tracking hinzu.

**Neue Interfaces/Klassen in wot-core:**

- ✅ **DiscoverySyncStore Interface** (`adapters/interfaces/DiscoverySyncStore.ts`) — 5 Methoden für Cache-Persistenz
  - `getCachedProfile(did)` / `setCachedProfile(did, profile)`
  - `getDirtyProfiles()` / `markDirty(did)` / `clearDirty(did)`
- ✅ **InMemoryDiscoverySyncStore** — In-Memory-Implementierung für Tests
- ✅ **OfflineFirstDiscoveryAdapter** — Wrapper mit Offline-Fallback
  - `resolveProfile()` → Cache zuerst, dann HTTP (wenn online)
  - `publishProfile()` → HTTP wenn online, sonst Dirty-Flag setzen
  - `syncDirty()` — Alle ausstehenden Profile-Updates hochladen

**Neue Klassen in Demo-App:**

- ✅ **EvoluDiscoverySyncStore** (`adapters/EvoluDiscoverySyncStore.ts`) — Evolu-basierte Cache-Persistenz
  - Neue Evolu-Tabelle `profileCache` (did, name, bio, avatar, updatedAt, isDirty)
  - Überlebt Browser-Restart
- ✅ **useOnlineStatus Hook** — `navigator.onLine` + Event-Listener
- ✅ **useSyncStatus Hook** — Zeigt Dirty-Count an

**AdapterContext aktualisiert:**

- `OfflineFirstDiscoveryAdapter` statt direktem `HttpDiscoveryAdapter`
- `EvoluDiscoverySyncStore` als Cache-Backend
- Auto-Sync bei Online-Reconnect

#### Reactive Identity + Offline Profile Fallback (`a5fdc3a`)

- ✅ **watchIdentity()** — Neues Method in `ReactiveStorageAdapter` Interface, reagiert auf Identity-Änderungen in Evolu
- ✅ **useProfile Hook erweitert** — Nutzt `watchIdentity()` für reaktive Updates (Name/Bio ändern → sofort sichtbar)
- ✅ **useSubscribable erweitert** — Unterstützt jetzt `initialValue` Parameter
- ✅ **Home.tsx reaktiv** — Zeigt Identity-Daten reaktiv an (kein Reload nötig nach Profiländerung)
- ✅ **PublicProfile Offline-Fallback** — Wenn offline: Profildaten aus lokalen Kontakten/Identity-Daten zusammenbauen
- ✅ **Amber Offline-Banner** — Zeigt an wenn Profildaten möglicherweise veraltet sind

#### Profile-Upload Fix (`e3712c1`)

- ✅ **Kein unconditional uploadProfile() bei Mount** — Verhindert Stale Overwrites (wenn Tab geöffnet wird, überschreibt es nicht die Serverdaten mit möglicherweise veralteten lokalen Daten)
- ✅ **Upload nur bei expliziter Profiländerung** — Dirty-Flag-basiert

### Tests Week 5+++

**19 neue Tests:**

#### OfflineFirstDiscoveryAdapter Tests (19 Tests)

```typescript
packages/wot-core/tests/OfflineFirstDiscoveryAdapter.test.ts

Resolve (Online):
✓ Fetch from HTTP and cache locally
✓ Return cached profile when HTTP fails
✓ Update cache when HTTP returns newer data

Resolve (Offline):
✓ Return cached profile when offline
✓ Return null when offline and no cache

Publish (Online):
✓ Publish via HTTP and clear dirty flag
✓ Publish falls back to dirty flag when HTTP fails

Publish (Offline):
✓ Mark as dirty when offline
✓ Don't attempt HTTP when offline

Sync:
✓ Sync all dirty profiles when back online
✓ Clear dirty flags after successful sync
✓ Handle partial sync failures

Cache Management:
✓ Cache profiles from resolve
✓ Separate caches per DID
✓ Update existing cache entries

Verifications/Attestations:
✓ Delegate to inner adapter (online)
✓ Return empty arrays when offline
✓ Publish verifications/attestations
✓ Dirty flag for verifications/attestations
```

**Gesamt: 209 Tests** (175 wot-core + 19 wot-profiles + 15 wot-relay) — alle passing ✅

### Commits Week 5+++

- **refactor: eliminate localStorage for identity, Evolu is single source of truth** — Identity-Daten nur noch in Evolu
- **feat: offline-first discovery layer with dirty-flag tracking and profile caching** — OfflineFirstDiscoveryAdapter, DiscoverySyncStore, EvoluDiscoverySyncStore, 19 Tests
- **feat: reactive identity + offline fallback for public profiles** — watchIdentity(), useProfile reaktiv, PublicProfile Offline-Fallback
- **fix: remove unconditional uploadProfile() on mount to prevent stale overwrites** — Dirty-Flag-basierter Upload

---

## Week 5++++: Messaging Outbox + WebSocket Heartbeat (2026-02-15) ✅

### Übersicht

Zwei zusammenhängende Probleme gelöst: (1) Nachrichten (Attestationen, Verifikationen) gingen verloren wenn der Sender offline war — der Relay hat zwar eine Queue für offline *Empfänger*, aber nicht für offline *Sender*. (2) Der Relay-Status-Indikator aktualisierte sich nicht reaktiv bei Verbindungsverlust — WebSocket `onclose` feuert nicht sofort bei physischem Netzwerk-Disconnect, und `navigator.onLine` ist unzuverlässig.

### Implementiert

#### OutboxMessagingAdapter (Decorator Pattern)

Neuer Wrapper um `WebSocketMessagingAdapter` (gleiches Pattern wie `OfflineFirstDiscoveryAdapter`):

- ✅ **`send()` schlägt nie fehl** — Bei Disconnect/Fehler/Timeout wird in persistente Outbox gequeued
- ✅ **Synthetic Receipt** — Sofortige `accepted`-Receipt bei Offline-Queue statt Error
- ✅ **`flushOutbox()`** — FIFO-Iteration bei Reconnect, `dequeue()` bei Erfolg, `incrementRetry()` bei Fehler
- ✅ **Send Timeout** — 15s Timeout für `inner.send()` (WebSocket kann bei halbtoten Verbindungen hängen)
- ✅ **`skipTypes`** — Konfigurierbar: `['profile-update']` überspringt die Outbox (Fire-and-Forget)
- ✅ **Dedup** — Gleiche `envelope.id` wird nicht doppelt gequeued
- ✅ **Flushing Guard** — Verhindert parallele Flush-Operationen

**Neue Interfaces/Klassen in wot-core:**

- ✅ **OutboxStore Interface** (`adapters/interfaces/OutboxStore.ts`) — 6 Methoden: `enqueue`, `dequeue`, `getPending`, `has`, `incrementRetry`, `count`
- ✅ **OutboxEntry Type** — `{ envelope, createdAt, retryCount }`
- ✅ **InMemoryOutboxStore** — Map-basiert für Tests
- ✅ **OutboxMessagingAdapter** — Decorator mit Outbox-Logik

**Neue Klassen in Demo-App:**

- ✅ **EvoluOutboxStore** (`adapters/EvoluOutboxStore.ts`) — Evolu-basierte persistente Outbox
  - Neue Evolu-Tabelle `outbox` (envelopeId, envelopeJson, retryCount)
  - Soft-Delete via `isDeleted: true`
  - `watchPendingCount()` — Subscribable für reaktiven UI-Badge

#### WebSocket Ping/Pong Heartbeat

Application-Level Heartbeat zur Erkennung toter TCP-Verbindungen:

- ✅ **Client sendet `ping`** alle 15 Sekunden
- ✅ **Relay antwortet `pong`** sofort
- ✅ **Timeout 5 Sekunden** — Kein `pong` → `ws.close()` + `setState('disconnected')`
- ✅ **Worst-Case Detection** — ~20s (15s Intervall + 5s Timeout)

**Warum nötig:** `navigator.onLine` ist laut MDN "inherently unreliable" — es prüft nur ob ein Netzwerk-Interface existiert, nicht ob Internet erreichbar ist. WebSocket `onclose` feuert bei physischem Ethernet-Disconnect erst nach TCP-Timeout (Minuten). Nur aktives Probing erkennt tote Verbindungen zuverlässig.

**Geänderte Dateien:**

- `WebSocketMessagingAdapter.ts` — `startHeartbeat()`, `stopHeartbeat()`, `handlePong()`, `pong` Case in `onmessage`
- `wot-relay/src/relay.ts` — `ping` Handler → `sendTo(ws, { type: 'pong' })`
- `wot-relay/src/types.ts` — `{ type: 'ping' }` in ClientMessage, `{ type: 'pong' }` in RelayMessage

#### Fire-and-Forget Sends

Alle `send()`-Aufrufe für Nachrichten die auch lokal gespeichert werden:

- ✅ **useVerification** — `send(envelope).catch(() => {})` statt `await send(envelope)` (3 Stellen: confirmAndRespond, confirmIncoming, counterVerify)
- ✅ **AttestationService** — `this.messaging.send(envelope).catch(...)` statt `await`
- **Begründung:** Daten sind lokal bereits gespeichert, Outbox übernimmt Retry — kein Grund den UI-Flow zu blockieren

#### Auto-Reconnect + Flush bei Online/Visibility

- ✅ **10s Reconnect-Timer** — In AdapterContext, prüft `getState()` und ruft `reconnectRelay()` auf
- ✅ **Offline-Handler** — Browser `offline` Event → sofort `disconnect()` + `setState('disconnected')`
- ✅ **Online/Visibility Events** — `reconnectRelay()` + `syncDiscovery()` + `flushOutbox()` bei Online-Reconnect und Tab-Wechsel zurück

#### UI: Outbox-Status auf Home-Seite

- ✅ **useOutboxStatus Hook** — Nutzt `outboxStore.watchPendingCount()` für reaktiven Pending-Count
- ✅ **Pending-Badge** — Send-Icon + "{n} Nachricht(en) in Warteschlange" neben Relay-Status und Profil-Sync-Status

### Tests Week 5++++

**18 neue Tests:**

#### OutboxMessagingAdapter Tests (18 Tests)

```text
packages/wot-core/tests/OutboxMessagingAdapter.test.ts

Send (connected):
✓ Delegate to inner adapter when connected
✓ No outbox entry when send succeeds
✓ Queue on inner.send() failure
✓ Queue on send timeout

Send (disconnected):
✓ Queue message and return synthetic receipt
✓ Synthetic receipt has correct messageId and status

Skip Types:
✓ Do not queue skipTypes messages when connected
✓ Do not queue skipTypes messages when disconnected

Dedup:
✓ Do not enqueue duplicate envelope IDs

Flush:
✓ Flush sends pending messages FIFO
✓ Dequeue on successful send
✓ Increment retryCount on failed send
✓ Stop flushing on disconnect
✓ Guard prevents parallel flush

Connect:
✓ Trigger flushOutbox after connect

Delegation:
✓ Delegate onMessage to inner
✓ Delegate disconnect to inner
✓ Delegate getState to inner
```

**Gesamt: 261 Tests** (205 wot-core + 41 demo + 15 wot-relay) — alle passing ✅

### Commits

25. **feat: messaging outbox for offline reliability + WebSocket heartbeat** — OutboxMessagingAdapter, Ping/Pong, Fire-and-Forget, EvoluOutboxStore, 18 Tests

---

## Week 6: Discovery Refactor + Multi-Device + UX Polish (2026-02-16) ✅

### Übersicht

Umfassender Refactor des Discovery-Systems (GraphCacheStore + PublishStateStore statt monolithischem DiscoverySyncStore), Relay Multi-Device-Support, Notification-Queue, und diverse Bugfixes.

### Implementiert

#### DiscoverySyncStore → GraphCacheStore + PublishStateStore

Monolithisches `DiscoverySyncStore` Interface aufgeteilt in zwei fokussierte Stores:

- ✅ **GraphCacheStore** (`adapters/interfaces/GraphCacheStore.ts`) — Cached Profile-Summaries für Trust-Graph-Anzeige
- ✅ **PublishStateStore** (`adapters/interfaces/PublishStateStore.ts`) — Dirty-Flags für Profile-Publish-State
- ✅ **InMemoryGraphCacheStore** — Map-basiert für Tests
- ✅ **InMemoryPublishStateStore** — Map-basiert für Tests
- ✅ **GraphCacheService** (`services/GraphCacheService.ts`) — Batch Profile Resolution via `resolveSummaries`
- ✅ **EvoluGraphCacheStore** — Evolu-basierte Persistenz in Demo-App
- ✅ **EvoluPublishStateStore** — Evolu-basierte Persistenz in Demo-App

#### Batch Profile Resolution

- ✅ **`POST /p/batch`** Endpoint in wot-profiles — Löst mehrere DIDs auf einmal auf
- ✅ **`resolveSummaries(dids)`** in DiscoveryAdapter Interface — Batch-Methode
- ✅ **`useGraphCache` Hook** — Batch-Resolution für PublicProfile Trust-Graph

#### Relay Multi-Device Support

- ✅ **`Map<string, Set<WebSocket>>`** statt `Map<string, WebSocket>` — Mehrere Geräte pro DID
- ✅ **Broadcast an alle Geräte** — `handleSend` liefert an alle verbundenen Sockets einer DID
- ✅ **Sauberes Cleanup** — Socket entfernen bei Disconnect, DID erst löschen wenn kein Socket mehr verbunden
- ✅ **3 neue Tests** — Multi-Device Delivery, partielle Disconnects, vollständige DID-Entfernung

#### Notification Queue

- ✅ **Dedup-Queue** statt 3 separater Dialog-States — Mehrere Attestations/Verifikationen nacheinander statt Überschreiben
- ✅ **`enqueue(notification)`** mit ID-basiertem Dedup
- ✅ **`dismiss()`** entfernt erstes Element, zeigt nächstes
- ✅ **Wrapper-Kompatibilität** — `triggerMutualDialog`, `triggerAttestationDialog`, `setPendingIncoming` nutzen intern die Queue
- ✅ **Tests** — NotificationQueue.test.ts

#### MutualVerificationEffect: Konfetti-Reload-Fix

- ✅ **sessionStorage** statt useRef für "schon gezeigt"-Tracking
- ✅ **Überlebt Reload**, aber nicht Browser-Neustart — Konfetti zeigt sich einmal pro Session

#### Identity Page: Profil-Links

- ✅ **Verifikations-/Attestation-Namen verlinkt** auf `/p/{did}` (wie in PublicProfile)

#### VerificationFlow: Auto-Regenerate Nonce

- ✅ **Automatische Nonce-Neugenerierung** nach eingehender Verifikation auf `/verify`
- ✅ **Mehrere Kontakte verifizieren** ohne die Seite zu verlassen

#### Attestation Emoji-Fix

- ✅ **`btoa()` Unicode-Crash behoben** — `btoa()` wirft `InvalidCharacterError` bei Emojis/Unicode
- ✅ **`saveIncomingAttestation()`** — Nimmt Attestation-Objekt direkt, kein Base64-Roundtrip mehr
- ✅ **`importAttestation()`** delegiert intern an `saveIncomingAttestation()`

#### Attestation UI: Import/Export entfernt

- ✅ **Import-Button** und Route entfernt
- ✅ **Copy/Export-Button** aus AttestationCard entfernt

### Tests Week 6

**3 neue Relay-Tests + Notification-Queue-Tests:**

```text
packages/wot-relay/tests/relay.test.ts (3 neue Tests, 18 gesamt)

Multi-Device:
✓ should deliver message to all devices of a DID
✓ should keep other devices connected when one disconnects
✓ should remove DID when all devices disconnect
```

**Gesamt: ~270 Tests** — alle passing ✅

### Commits

26. **refactor: replace DiscoverySyncStore with GraphCacheStore + PublishStateStore** — Split + GraphCacheService + Batch Endpoint
27. **feat: integrate GraphCacheStore + PublishStateStore in demo app** — Evolu Stores + useGraphCache + PublicProfile Refactor
28. **feat: notification queue + fix confetti on reload** — Dedup-Queue + sessionStorage
29. **feat: link names to profiles on identity page + auto-regenerate nonce** — Profil-Links + Nonce-Regen
30. **fix: attestations with emojis not arriving + remove import/export** — btoa-Fix + UI Cleanup
31. **feat: relay multi-device support** — Set<WebSocket> pro DID

---

## Week 6+: Delivery Acknowledgment (2026-02-17) ✅

### Übersicht

Nachrichten (Attestations, Verifikationen) konnten unter bestimmten Umständen verloren gehen: Der Relay löschte sie aus der Queue sobald sie gesendet wurden — ohne zu wissen ob der Empfänger sie tatsächlich verarbeitet hat. Jetzt bestätigt der Empfänger jede Nachricht mit ACK. Der Relay behält Nachrichten bis ACK eintrifft. Bei Reconnect: Redelivery aller unbestätigten Nachrichten.

### Implementiert

#### ACK-Protokoll

- ✅ **Neuer Client-Message-Typ** — `{ type: 'ack', messageId: string }` in Relay-Protokoll
- ✅ **At-least-once Delivery** — Relay speichert alle zugestellten Nachrichten bis ACK
- ✅ **Redelivery bei Reconnect** — `handleRegister` liefert unACKed Nachrichten automatisch erneut
- ✅ **Client-side Idempotency** — Duplikate werden in der App erkannt (Attestation-ID, Verification-ID)

#### Queue Schema-Erweiterung (`queue.ts`)

Neues Schema mit Delivery-Tracking:

- ✅ **`message_id`** — Envelope-ID für ACK-Matching (UNIQUE Index)
- ✅ **`status`** — `'queued'` (offline) oder `'delivered'` (gesendet, wartet auf ACK)
- ✅ **`delivered_at`** — Zeitstempel der Zustellung
- ✅ **`dequeue()`** — Markiert als 'delivered' statt zu löschen (vorher: DELETE)
- ✅ **`markDelivered()`** — Für online-zugestellte Nachrichten
- ✅ **`ack()`** — Löscht Nachricht nach ACK-Empfang
- ✅ **`getUnacked()`** — Alle zugestellten aber unbestätigten Nachrichten (für Redelivery)
- ✅ **Schema-Migration** — Erkennt altes Schema (ohne `message_id`), droppt und erstellt neu

#### Relay-Server (`relay.ts`)

- ✅ **`handleAck()`** — Löscht Nachricht aus Queue nach ACK
- ✅ **`handleRegister()`** — Liefert zuerst unACKed (Redelivery), dann neue queued Messages
- ✅ **`handleSend()`** — Online-Delivery speichert Nachricht in DB bis ACK (vorher: kein DB-Eintrag)

#### WebSocketMessagingAdapter

- ✅ **Auto-ACK** — Sendet `{ type: 'ack', messageId }` nach erfolgreichem onMessage-Callback
- ✅ **Error-Handling** — Kein ACK bei Callback-Fehler → Redelivery beim nächsten Connect

#### Multi-Device ACK-Semantik

- ✅ **Ein ACK von einem Gerät reicht** — Evolu synchronisiert zwischen Geräten
- ✅ **Doppel-Delivery harmlos** — App dedupliziert über Attestation-/Verification-ID

### Tests Week 6+

**6 neue ACK-Tests (24 total):**

```text
packages/wot-relay/tests/relay.test.ts

Delivery Acknowledgment:
✓ should remove message from queue after ACK
✓ should redeliver unACKed messages on reconnect
✓ should persist online-delivered messages until ACK
✓ should ACK messages individually
✓ should ignore ACK from unregistered client
✓ should accept ACK from any device of the same DID
```

**Gesamt: ~273 Tests** (249 wot-core + 24 wot-relay) — alle passing ✅

### Commits

32. **feat: delivery acknowledgment protocol** — ACK-Typ, Queue-Schema, Redelivery, Auto-ACK, Schema-Migration, 6 Tests

---

## Week 6++: Offline Polish + i18n (2026-02-18) ✅

### Übersicht

Drei zusammenhängende Verbesserungen: (1) Zuverlässiges Offline-Profil-Loading in allen Browsern, (2) Deduplizierung von Verifikationen, (3) vollständige Internationalisierung der Demo-App (Deutsch + Englisch).

### Implementiert

#### ProfileResolveResult: `fromCache` Flag

Neues Rückgabe-Format für `resolveProfile()` — die UI kann jetzt unterscheiden ob Daten frisch vom Server oder aus dem Cache kommen:

- ✅ **ProfileResolveResult Type** (`adapters/interfaces/DiscoveryAdapter.ts`) — `{ profile: PublicProfile | null, fromCache: boolean }`
- ✅ **HttpDiscoveryAdapter** — Gibt immer `fromCache: false` zurück
- ✅ **OfflineFirstDiscoveryAdapter** — Gibt `fromCache: true` bei Cache-Fallback zurück
- ✅ **Fetch-Timeout** — 5s `AbortController`-basierter Timeout in HttpDiscoveryAdapter (Firefox hängt sonst bei Offline-Fetch)
- ✅ **Cache-Fallback für Verifications/Attestations** — `OfflineFirstDiscoveryAdapter` fällt auf `graphCache.getCachedVerifications/Attestations` zurück statt `[]`

**Vorher:** UI konnte nicht unterscheiden ob Daten frisch oder gecached waren → Chrome zeigte kein Offline-Banner, Firefox hing endlos.

**Nachher:** Ein einziger Code-Pfad in PublicProfile.tsx:

```typescript
const profileResult = await discovery.resolveProfile(did)
setState(profileResult.fromCache ? 'loaded-offline' : 'loaded')
```

#### PublicProfile.tsx Vereinfachung

- ✅ **Entfernt:** `tryCachedFallback()` Funktion (100+ Zeilen → ~20 Zeilen)
- ✅ **Entfernt:** `navigator.onLine` Pre-Check, `useOnlineStatus` Hook
- ✅ **Entfernt:** `isNetworkError` Detection im Catch-Block
- ✅ **Vereinfacht:** Single-Layer-Caching — Adapter cached, UI liest `fromCache`

#### Attestation Color Coding

- ✅ **Eigene Attestationen grün** — `isKnownContact()` prüft jetzt auch `targetDid === myDid`
- ✅ **(Du) Label** — `displayName()` fügt automatisch Suffix hinzu

#### Verification-Deduplizierung

- ✅ **UI-Dedup** (`PublicProfile.tsx`) — `deduplicateByFrom()` filtert per Sender-DID, behält neueste Verification
- ✅ **Publish-Dedup** (`useProfileSync.ts`) — Beim Upload werden Duplikate ebenfalls gefiltert
- ✅ **Korrekte Zählung** — "Verifiziert von X Personen" zeigt deduplizierte Anzahl

#### i18n: Internationalisierung (Deutsch + Englisch)

Vollständige Internationalisierung der Demo-App mit Custom React Context Pattern:

- ✅ **6 i18n Infrastruktur-Dateien** — `de.ts`, `en.ts`, `types.ts`, `utils.ts`, `LanguageContext.tsx`, `index.ts`
- ✅ **20+ Komponenten migriert** — Alle hardcoded Strings durch `useLanguage()` Hook ersetzt
- ✅ **Browser-Spracherkennung** — Automatisch Deutsch/Englisch basierend auf `navigator.language`
- ✅ **URL-Parameter** — `?lang=en` / `?lang=de` für explizite Sprachwahl
- ✅ **Type-Safe** — `DeepStringify` Helper-Type für verschachtelte Translation-Objekte
- ✅ **`formatDate()`** — Ersetzt alle hardcoded `toLocaleDateString('de-DE')` mit Locale-awarener Formatierung
- ✅ **`plural()`** — Helper für korrekte Singular/Plural-Formen
- ✅ **`fmt()`** — Template-Interpolation: `fmt(t.key, { name: "Alice" })`
- ✅ **`.env.production`** — `VITE_PROFILE_SERVICE_URL` für Deployment konfiguriert

### Geänderte Call-Sites für ProfileResolveResult

Alle Stellen die `resolveProfile()` aufrufen wurden auf `.profile`-Zugriff aktualisiert:

- `GraphCacheService.ts` — `profileResult.profile`
- `useProfileSync.ts` — `.then(r => r.profile)`
- `App.tsx` (2 Stellen) — `.then(r => r.profile)`
- `ContactList.tsx` — `.then(r => r.profile)`
- `VerificationFlow.tsx` — `.then(r => r.profile)`

### Tests Week 6++

**4 neue Tests + bestehende Tests aktualisiert:**

#### OfflineFirstDiscoveryAdapter Tests (23 Tests, 4 neu)

```text
packages/wot-core/tests/OfflineFirstDiscoveryAdapter.test.ts

ProfileResolveResult:
✓ should return profile with fromCache=false on successful resolve
✓ should return cached profile with fromCache=true when inner fails
✓ should return null profile with fromCache=true when inner fails and no cache exists
✓ should return null profile with fromCache=false when inner returns null
```

#### GraphCacheService Tests (42 Tests, aktualisiert)

Alle `resolveProfile`-Mocks aktualisiert auf `{ profile, fromCache: false }`.

**Gesamt: ~300 Tests** (251 wot-core + 25 wot-profiles + 24 wot-relay) — alle passing ✅

### Commits

33. **fix: offline profile loading + attestation color coding** — Fetch-Timeout, Cache-Fallback, isKnownContact Fix
34. **fix: ProfileResolveResult fromCache flag + verification dedup** — Neuer Return-Type, UI-Vereinfachung, Verification-Dedup, 4 Tests
35. **feat: add i18n support (German + English) to demo app** — 6 Infrastruktur-Dateien, 20+ Komponenten migriert

---

## Unterschiede zur Spezifikation

### DID Format

**Spezifikation:** `did:wot:7Hy3kPqR9mNx2Wb5vLz8`
**Implementiert:** `did:key:z6MkpTHz...` (Standard did:key mit multibase)

**Grund:** `did:key` ist ein etablierter W3C-Standard mit breiter Tool-Unterstützung. Eine custom `did:wot` Methode würde eigenen DID Resolver erfordern.

**Konsequenz:** Interoperabilität mit bestehenden DID-Tools und Verifiers.

### Master Key Derivation

**Spezifikation:** BIP39 → PBKDF2 → Ed25519
**Implementiert:** BIP39 → HKDF Master Key (non-extractable) → Ed25519 Identity Key

**Grund:**
- Master Key als HKDF-Quelle ermöglicht sichere Framework-Key-Derivation
- Non-extractable CryptoKey nutzt Hardware-Isolation
- Ermöglicht Ableitung von Evolu-Keys ohne Identity-Key-Exposition

**Vorteil:**
```typescript
// Framework-spezifische Keys ableiten ohne Private Key zu exportieren
const evolKey = await identity.deriveFrameworkKey('evolu-storage-v1')
```

### Wortliste

**Spezifikation / poc-plan:** Englische BIP39-Wortliste
**Implementiert:** Deutsche BIP39-Wortliste (dys2p/wordlists-de)

**Grund:** Deutschsprachige Zielgruppe, bessere Merkbarkeit. User-facing Begriff: "Magische Wörter".

### Storage Passphrase

**Neu implementiert:** Passphrase-Schutz für verschlüsselten Seed

**Grund:** Browser haben keine sichere OS-Keychain. Passphrase bietet zusätzlichen Schutz.

**Workflow:**
1. Identity erstellen (storeSeed=false, kein Passphrase nötig)
2. Passphrase setzen und Seed verschlüsselt speichern (storeSeed=true)
3. Unlock mit gleicher Passphrase

### Mnemonic Länge

**poc-plan:** Teils 24 Wörter (256 bit) erwähnt
**Implementiert:** 12 Wörter (128 bit)

**Grund:** 128 bit bietet ausreichende Security bei besserer UX. BIP39-Standard unterstützt beides.

---

## Nächste Schritte

### Priorität 1: Demo App — Spaces UI ⬅️ NÄCHSTER SCHRITT

- **Spaces-Seite in Demo App** — AutomergeReplicationAdapter in AdapterContext einbinden
  - Space erstellen, Members einladen, geteilte Daten bearbeiten
  - Verschlüsselte Sync-Funktionalität live testen
  - useSpaces Hook für React-Integration

### Priorität 2: Polish + UX

- **Spaces-Persistenz** — Automerge Docs in IndexedDB persistieren (aktuell nur in-memory)

### Priorität 3: RLS Integration & Module

- **RLS Module Integration** — Kanban, Kalender, Karte
- **AuthorizationAdapter** — UCAN-like Capabilities (read/write)

### Erledigt

- ✅ i18n (Deutsch + Englisch)
- ✅ Offline-First Profile Loading (ProfileResolveResult)
- ✅ Verification-Deduplizierung
- ✅ Attestation Color Coding

- ~~MessagingAdapter Interface in wot-core definieren~~ ✅
- ~~Custom WebSocket Relay implementieren~~ ✅
- ~~Attestation Delivery E2E~~ ✅
- ~~Profil-Sync (JWS-signierte Profile, wot-profiles Service)~~ ✅
- ~~Symmetrische Encryption (AES-256-GCM)~~ ✅
- ~~Asymmetrische Encryption (X25519 ECIES)~~ ✅
- ~~EncryptedSyncService (Encrypt-then-sync)~~ ✅
- ~~GroupKeyService (Key Generation, Rotation, Generations)~~ ✅
- ~~wot-profiles Deployment (Docker, profiles.utopia-lab.org)~~ ✅
- ~~DiscoveryAdapter (7. Adapter, HttpDiscoveryAdapter)~~ ✅
- ~~Offline-First Discovery (OfflineFirstDiscoveryAdapter, DiscoverySyncStore)~~ ✅
- ~~Reactive Identity (watchIdentity, useProfile reaktiv)~~ ✅
- ~~localStorage eliminiert (Evolu = Single Source of Truth)~~ ✅
- ~~Profile-Upload Fix (Dirty-Flag-basiert statt unconditional)~~ ✅
- ~~Messaging Outbox (OutboxMessagingAdapter + EvoluOutboxStore)~~ ✅
- ~~WebSocket Heartbeat (Ping/Pong, tote Verbindungen erkennen)~~ ✅
- ~~Fire-and-Forget Sends (Verifications, Attestations)~~ ✅
- ~~DiscoverySyncStore → GraphCacheStore + PublishStateStore~~ ✅ (Week 6)
- ~~Batch Profile Resolution (resolveSummaries, /p/batch)~~ ✅ (Week 6)
- ~~Relay Multi-Device Support~~ ✅ (Week 6)
- ~~Notification Queue (Dedup + Konfetti-Fix)~~ ✅ (Week 6)
- ~~Attestation Emoji-Fix (btoa → saveIncomingAttestation)~~ ✅ (Week 6)
- ~~Delivery Acknowledgment (ACK-Protokoll, Redelivery, Schema-Migration)~~ ✅ (Week 6+)
- **Identity-System konsolidieren** — altes IdentityService/useIdentity entfernen (Plan existiert, niedrige Priorität)

### Zurückgestellt

- **DID Server** (poc-plan Week 2) — did:key reicht für POC, kein Server nötig
- **Evolu Sync Transports** — Kommt wenn Multi-Device relevant wird
- **Matrix Integration** — Erst nach POC-Phase wenn Federation nötig

---

## Technische Entscheidungen

### WebCrypto API vs. Externe Libraries

**Entscheidung:** Native WebCrypto API + @noble/ed25519
**Grund:**
- WebCrypto für HKDF, PBKDF2, AES-GCM, X25519 ECDH (zero dependencies)
- @noble/ed25519 für Ed25519 Signing (WebCrypto Ed25519 hat Browser-Kompatibilitätsprobleme)
- X25519 über separaten HKDF-Pfad (kein @noble/curves nötig)
- Hardware-backed wenn verfügbar
- Browser-Security-Updates automatisch

### IndexedDB vs. LocalStorage

**Entscheidung:** IndexedDB
**Grund:**
- Kann CryptoKey-Objekte direkt speichern
- Größere Storage-Limits
- Async API (non-blocking)

### Fake-IndexedDB für Tests

**Entscheidung:** fake-indexeddb npm package
**Grund:**
- Node.js hat kein natives IndexedDB
- happy-dom alleine reicht nicht
- Ermöglicht echte Storage-Tests ohne Browser

### Evolu als Storage/Sync Framework

**Entscheidung:** Evolu (SQLite WASM + CRDT)
**Grund:**
- Custom Keys seit Nov 2025 (`externalAppOwner` in `DbConfig`)
- `deriveFrameworkKey('evolu-storage-v1')` → 32-byte `OwnerSecret` passt perfekt
- Local-first mit CRDT-basiertem Sync (Relay kommt später)
- Effect Schema für Type Safety (branded types)
- OPFS-basiertes Storage im Browser (kein IndexedDB-Limit)
- React Provider + Hooks Integration

**Trade-off:** Identity-Daten bleiben in eigenem IndexedDB (SeedStorage), nicht in Evolu. Grund: Verschlüsselter Seed darf nicht gesynct werden.

### Deutsche Wortliste

**Entscheidung:** dys2p/wordlists-de (2048 Wörter)
**Grund:**
- Etablierte, BIP39-konforme deutsche Wortliste
- Breite Community-Nutzung
- Keine Umlaute-Verwirrung (ae/ue/oe statt ä/ü/ö)

---

## Commits & Git History

### Week 1 Commits

1. **Initial WotIdentity implementation** - BIP39 + Ed25519 + did:key
2. **Add SeedStorage with PBKDF2+AES-GCM**
3. **Refactor: SecureWotIdentity → WotIdentity** - Cleaner naming
4. **Add comprehensive tests (29 tests)** - WotIdentity + SeedStorage
5. **Update wot-core README** - API documentation
6. **Add Implementation Status** - This document

### Week 2 Commits

7. **Week 2 Core Complete: Verification with WotIdentity** - ContactStorage + VerificationHelper
8. **feat: Add QR code support for in-person verification**
9. **fix: QR scanner DOM timing and update docs**
10. **fix: Handle lost challenge state in completeVerification**
11. **feat: Add delete identity button to /identity page**
12. **fix: Delete all data when navigate to root**
13. **Add nonce fallback test for lost challenge state**

### Week 2+ Commits

14. **feat: Add German BIP39 wordlist and fix identity persistence** - Deutsche Wortliste, 3 Persistence-Bugs, Enter-Navigation

### Week 3 Commits

15. **feat: Integrate Evolu as storage backend** - Schema, EvoluStorageAdapter, Provider-Hierarchie, Custom Keys

---

## File Structure (aktuell)

### wot-core Package

```
packages/wot-core/src/
├── identity/
│   ├── WotIdentity.ts              # Ed25519 + X25519 + JWS + HKDF
│   ├── SeedStorage.ts              # Encrypted seed in IndexedDB
│   └── index.ts
├── contact/
│   ├── ContactStorage.ts           # Contact CRUD in IndexedDB
│   └── index.ts
├── verification/
│   ├── VerificationHelper.ts       # Challenge-Response-Protokoll
│   └── index.ts
├── wordlists/
│   ├── german-positive.ts          # 2048 deutsche BIP39-Wörter
│   └── index.ts
├── crypto/
│   ├── did.ts                      # DID utilities (createDid, didToPublicKeyBytes)
│   ├── encoding.ts                 # Base64/multibase
│   ├── jws.ts                      # JWS signing/verification
│   └── index.ts
├── adapters/
│   ├── interfaces/
│   │   ├── StorageAdapter.ts
│   │   ├── ReactiveStorageAdapter.ts  # + watchIdentity()
│   │   ├── Subscribable.ts
│   │   ├── CryptoAdapter.ts        # + Symmetric + EncryptedPayload Type
│   │   ├── MessagingAdapter.ts     # Cross-User Messaging
│   │   ├── DiscoveryAdapter.ts     # Public Profile Discovery
│   │   ├── GraphCacheStore.ts      # Profile-Summary Cache Interface
│   │   ├── PublishStateStore.ts   # Profile-Publish Dirty-Flags Interface
│   │   ├── OutboxStore.ts         # Messaging Outbox Interface
│   │   ├── ReplicationAdapter.ts   # CRDT Spaces + SpaceHandle<T>
│   │   └── index.ts
│   ├── crypto/
│   │   └── WebCryptoAdapter.ts     # Ed25519 + X25519 + AES-256-GCM
│   ├── messaging/
│   │   ├── InMemoryMessagingAdapter.ts  # Shared-Bus für Tests
│   │   ├── InMemoryOutboxStore.ts       # In-Memory Outbox für Tests
│   │   ├── OutboxMessagingAdapter.ts    # Offline-Queue Decorator
│   │   └── WebSocketMessagingAdapter.ts # Browser WebSocket Client + Heartbeat
│   ├── discovery/
│   │   ├── HttpDiscoveryAdapter.ts          # HTTP-based (wot-profiles)
│   │   ├── OfflineFirstDiscoveryAdapter.ts  # Offline-Cache Wrapper
│   │   ├── InMemoryGraphCacheStore.ts       # In-Memory Cache für Tests
│   │   └── InMemoryPublishStateStore.ts     # In-Memory Dirty-Flags für Tests
│   ├── replication/
│   │   └── AutomergeReplicationAdapter.ts   # Automerge + E2EE + GroupKeys
│   ├── storage/
│   │   └── LocalStorageAdapter.ts
│   └── index.ts
├── services/
│   ├── ProfileService.ts           # signProfile, verifyProfile (JWS)
│   ├── GraphCacheService.ts        # Batch Profile Resolution
│   ├── EncryptedSyncService.ts     # Encrypt/Decrypt CRDT Changes (AES-256-GCM)
│   ├── GroupKeyService.ts          # Group Key Management (per Space, Generations)
│   └── index.ts
├── types/
│   ├── identity.ts                 # + PublicProfile
│   ├── contact.ts
│   ├── verification.ts
│   ├── attestation.ts
│   ├── proof.ts
│   ├── messaging.ts                # MessageEnvelope, DeliveryReceipt, MessagingState
│   ├── resource-ref.ts             # ResourceRef branded type (wot:<type>:<id>)
│   ├── space.ts                    # SpaceInfo, SpaceMemberChange, ReplicationState
│   └── index.ts
└── index.ts
```

### wot-profiles Package

```
packages/wot-profiles/
├── src/
│   ├── profile-store.ts             # SQLite Store (better-sqlite3, WAL)
│   ├── jws-verify.ts                # Standalone JWS Verify (keine wot-core Dep)
│   ├── server.ts                    # HTTP Server (CORS, GET/PUT /p/{did})
│   └── start.ts                     # Entry Point (PORT, DB_PATH env)
├── tests/
│   ├── profile-store.test.ts        # 4 Tests
│   └── profile-rest.test.ts         # 7 Tests
├── Dockerfile                       # Multi-Stage Build (Node 22-slim)
├── docker-compose.yml               # Port 8788, SQLite Volume
├── tsconfig.docker.json             # Standalone tsconfig für Docker
├── package.json
└── tsconfig.json
```

### Demo App

```
apps/demo/src/
├── components/
│   ├── identity/
│   │   ├── OnboardingFlow.tsx       # Neuer Identity-Flow (4 Steps)
│   │   ├── RecoveryFlow.tsx         # Mnemonic-Import
│   │   ├── UnlockFlow.tsx           # Passphrase-Unlock
│   │   ├── IdentityManagement.tsx   # Routing: Onboarding/Unlock/Recovery
│   │   ├── CreateIdentity.tsx
│   │   ├── IdentityCard.tsx
│   │   └── index.ts
│   ├── verification/
│   │   ├── VerificationFlow.tsx
│   │   ├── ShowCode.tsx             # QR-Code Generation
│   │   ├── ScanCode.tsx             # QR-Code Scanner
│   │   ├── Confetti.tsx             # Konfetti-Animation nach Verification
│   │   └── index.ts
│   ├── contacts/
│   │   ├── ContactCard.tsx
│   │   ├── ContactList.tsx
│   │   └── index.ts
│   ├── attestation/
│   │   ├── AttestationCard.tsx
│   │   ├── AttestationList.tsx
│   │   ├── CreateAttestation.tsx
│   │   ├── ImportAttestation.tsx
│   │   └── index.ts
│   ├── shared/
│   │   ├── Avatar.tsx
│   │   ├── AvatarUpload.tsx
│   │   ├── ProgressIndicator.tsx
│   │   ├── SecurityChecklist.tsx
│   │   ├── InfoTooltip.tsx
│   │   └── index.ts
│   └── layout/
│       ├── AppShell.tsx
│       ├── Navigation.tsx
│       └── index.ts
├── adapters/
│   ├── EvoluStorageAdapter.ts         # StorageAdapter + ReactiveStorageAdapter via Evolu
│   ├── EvoluGraphCacheStore.ts        # Evolu-basierter Graph-Cache für Profile-Summaries
│   ├── EvoluPublishStateStore.ts      # Evolu-basierte Dirty-Flags für Profile-Publish
│   ├── EvoluOutboxStore.ts            # Evolu-basierte persistente Messaging-Outbox
│   └── rowMappers.ts                  # Evolu Row ↔ WoT Type Konvertierung
├── context/
│   ├── AdapterContext.tsx             # Evolu init + alle Adapter (Storage, Messaging, Discovery)
│   ├── IdentityContext.tsx
│   ├── PendingVerificationContext.tsx # Globaler Verification-State
│   └── index.ts
├── hooks/
│   ├── useVerification.ts
│   ├── useContacts.ts
│   ├── useAttestations.ts
│   ├── useMessaging.ts                # Relay send/onMessage/state
│   ├── useOutboxStatus.ts            # Reaktiver Outbox-Pending-Count
│   ├── useProfileSync.ts             # Upload/Fetch Profile, Dirty-Flag-Sync
│   ├── useGraphCache.ts              # Batch Profile Resolution für Trust-Graph
│   ├── useProfile.ts                  # Reaktives Profil via watchIdentity()
│   ├── useSubscribable.ts            # Subscribable<T> → React State
│   ├── useOnlineStatus.ts            # navigator.onLine + Events
│   ├── useSyncStatus.ts              # Dirty-Count Anzeige
│   └── index.ts
├── services/
│   ├── VerificationService.ts
│   ├── ContactService.ts
│   ├── AttestationService.ts
│   └── index.ts
├── pages/
│   ├── Home.tsx
│   ├── Identity.tsx
│   ├── Verify.tsx
│   ├── Contacts.tsx
│   ├── Attestations.tsx
│   ├── PublicProfile.tsx           # Öffentliches Profil (auch ohne Login)
│   └── index.ts
├── db.ts                            # Evolu Schema + createWotEvolu()
├── App.tsx                          # RequireIdentity + Loading/Unlock
└── main.tsx
```

### Tests

```
packages/wot-core/tests/                              # 205 Tests
├── WotIdentity.test.ts              # 20 Tests  (+3 signJws)
├── SeedStorage.test.ts              # 12 Tests
├── ContactStorage.test.ts           # 15 Tests
├── VerificationIntegration.test.ts  # 20 Tests
├── OnboardingFlow.test.ts           # 13 Tests
├── ResourceRef.test.ts              # 14 Tests
├── MessagingAdapter.test.ts         # 14 Tests
├── ProfileService.test.ts           # 6 Tests
├── SymmetricCrypto.test.ts          # 10 Tests
├── AsymmetricCrypto.test.ts         # 16 Tests
├── EncryptedSyncService.test.ts     # 8 Tests
├── GroupKeyService.test.ts          # 10 Tests
├── AutomergeReplication.test.ts     # 16 Tests
├── OfflineFirstDiscoveryAdapter.test.ts  # 19 Tests
├── OutboxMessagingAdapter.test.ts   # 18 Tests  NEU (Week 5++++)
└── setup.ts                         # fake-indexeddb setup

packages/wot-profiles/tests/                          # 19 Tests
├── profile-store.test.ts            # 4 Tests
└── profile-rest.test.ts             # 15 Tests

packages/wot-relay/tests/                              # 18 Tests
├── relay.test.ts                    # 12 Tests (inkl. 3 Multi-Device)
└── integration.test.ts              # 6 Tests
```

---

## Lessons Learned

### Was gut funktioniert hat

- **BIP39 für Recovery** - Standard-Wortliste, breite Tool-Unterstützung
- **Deutsche Wortliste** - Bessere Merkbarkeit für Zielgruppe
- **did:key Format** - Keine eigene Infrastruktur nötig
- **Deterministic Keys** - Gleicher Mnemonic → gleiche DID
- **Test-First Approach** - Tests helfen Bugs früh zu finden
- **User-Testing** - 3 kritische Persistence-Bugs durch reales Testen gefunden
- **storeSeed Parameter** - Feine Kontrolle über Speicherzeitpunkt

### Herausforderungen

- **WebCrypto Complexity** - Viele subtile Details (extractable, usages, etc.)
- **Test Environment** - IndexedDB Mocking erforderte fake-indexeddb
- **Passphrase Storage** - Browser haben keine sichere OS-Keychain
- **Identity Persistence** - Timing wann Identity gespeichert wird ist kritisch
- **React State vs. Storage** - hasStoredIdentity muss beim Mount geprüft werden

### Für nächste Weeks

- ~~MessagingAdapter implementieren~~ ✅ (Week 3++)
- ~~Attestation Delivery E2E~~ ✅ (Week 3++)
- ~~Profil-Sync~~ ✅ (Week 4) — JWS-signierte Profile, wot-profiles Service, useProfileSync Hook
- ~~Symmetrische Encryption~~ ✅ (Week 4) — AES-256-GCM im CryptoAdapter
- ~~Asymmetrische Encryption~~ ✅ (Week 5) — X25519 ECIES, separater HKDF-Pfad
- ~~EncryptedSyncService + GroupKeyService~~ ✅ (Week 5) — Encrypt-then-sync Foundations
- ~~wot-profiles Deployment~~ ✅ (Week 5) — Docker, profiles.utopia-lab.org
- ~~AutomergeReplicationAdapter~~ ✅ (Week 5+) — CRDT Spaces mit verschlüsseltem Transport, 16 Tests
- ~~Relay Deployment~~ ✅ — Live unter `wss://relay.utopia-lab.org`
- ~~DiscoveryAdapter~~ ✅ (Week 5++) — 7. Adapter, HttpDiscoveryAdapter, Demo-App Refactoring
- ~~Offline-First Discovery~~ ✅ (Week 5+++) — OfflineFirstDiscoveryAdapter, DiscoverySyncStore, 19 Tests
- ~~Reactive Identity~~ ✅ (Week 5+++) — watchIdentity(), useProfile reaktiv, Offline-Fallback
- ~~localStorage eliminiert~~ ✅ (Week 5+++) — Evolu = Single Source of Truth
- **Spaces UI in Demo App** — AutomergeReplicationAdapter testbar machen (nächster Schritt)
- **Encrypted Blob Store** — Private Profilbilder/Anhänge verschlüsselt teilen (siehe `docs/konzepte/encrypted-blob-store.md`)
- **Evolu Sync** - Transports konfigurieren für Multi-Tab/Device Sync
- **Social Recovery (Shamir)** - Seed-Backup über verifizierte Kontakte

---

## Architektur-Entscheidungen (Forschung)

### DID-Methode: did:key (bestätigt)

Nach umfassender Evaluation von 6 DID-Methoden (did:key, did:peer, did:web, did:webvh, did:dht, did:plc) bleibt **did:key** unsere Wahl für den POC.

**Gründe:**
- Keine Infrastruktur nötig (kein Server, kein DHT)
- Offline-fähig und self-certifying
- BIP39 Seed → deterministische DID → Multi-Device gelöst (gleicher Seed = gleiche DID)
- Bestätigt durch Murmurations Network (nutzt ebenfalls did:key + Ed25519)

**Mittelfristig:** did:key + did:peer Hybrid (did:peer für 1:1-Kanäle mit Key Rotation)

**Langfristig:** WoT-Layer methoden-agnostisch (verschiedene Nutzer können verschiedene DID-Methoden nutzen)

Details: [docs/konzepte/did-methoden-vergleich.md](./konzepte/did-methoden-vergleich.md)

### Multi-Device: Seed-basiert

Multi-Device ist durch BIP39 bereits gelöst: Gleicher Seed auf allen Geräten eingeben → gleiche DID, gleicher Key.

Kein Login-Token-System, kein Server, keine Email nötig. Murmurations braucht dafür Login Tokens und Email-Recovery, weil ihre Keys non-exportable sind.

### Recovery: Social Recovery (geplant)

Drei Schutzschichten geplant:

1. **BIP39 Mnemonic** (✅ implementiert) - Seed aufschreiben
2. **Shamir Secret Sharing** (nächster Schritt) - Seed in Shards aufteilen, an verifizierte Kontakte verteilen
3. **Guardian Recovery** (später) - Verifizierte Kontakte autorisieren neuen Key (braucht Key Rotation)

Unser WoT ist gleichzeitig das Guardian-Netzwerk: Verifizierte Kontakte = natürliche Recovery-Partner.

Details: [docs/konzepte/social-recovery.md](./konzepte/social-recovery.md)

### UCAN → AuthorizationAdapter (aktiv geplant)

Murmurations nutzt UCAN (User Controlled Authorization Networks) für capability-basierte Delegation. In der Architektur-Revision v2 ist dies zum **AuthorizationAdapter** geworden — inspiriert von UCAN und Willow/Meadowcap:

- Signierte, delegierbare Capabilities
- Attenuation (jede Delegation kann nur einschränken)
- Offline-verifizierbare Proof Chains
- Phasen: NoOp (POC) → Basis-Capabilities (Phase 2) → Volle UCAN-Kompatibilität (Phase 4)

Details: [Adapter-Architektur v2](./protokolle/adapter-architektur-v2.md#authorizationadapter)

---

*Dieses Dokument wird nach jeder Week aktualisiert.*