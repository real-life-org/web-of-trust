# Web of Trust Demo

Eine Demo-Anwendung für das Web-of-Trust Konzept. Identität erstellen, Kontakte persönlich verifizieren, Attestierungen austauschen — alles lokal verschlüsselt im Browser.

## Features

- **Identität erstellen**: BIP39-Mnemonic (12 Wörter, deutsche Wortliste), Ed25519-Schlüssel, `did:key`-Format
- **Session-Cache**: Nach Passworteingabe bleibt die Identität 30 Minuten entsperrt (CryptoKey in IndexedDB)
- **Kontakte verifizieren**: Challenge-Response via QR-Code oder manuellem Code-Austausch
- **Attestierungen**: Signierte Aussagen über Kontakte, Versand über WebSocket Relay
- **Lokale Speicherung**: Alle Daten bleiben verschlüsselt im Browser (Evolu/SQLite via OPFS)

## Tech Stack

- React 19 + TypeScript
- Tailwind CSS 4
- Vite
- `@web.of.trust/core` (Identität, Krypto, Verification, Messaging)
- Evolu (CRDT-basierte lokale Datenbank)
- WebSocket Relay (`wot-relay`) für DID-zu-DID Messaging

## Architektur

Die Demo nutzt die 6-Adapter-Architektur aus `wot-core`:

```
┌─────────────────────────────────────────────────┐
│                    UI Layer                      │
│  React Components + Pages                       │
├─────────────────────────────────────────────────┤
│                   Hooks Layer                    │
│  useContacts, useAttestations, useMessaging,     │
│  useVerification                                 │
├─────────────────────────────────────────────────┤
│                 Service Layer                    │
│  ContactService, AttestationService,             │
│  VerificationService                             │
├─────────────────────────────────────────────────┤
│            Adapter Interfaces (wot-core)         │
│                                                  │
│  Lokal:                                          │
│  StorageAdapter · ReactiveStorageAdapter · Crypto │
│                                                  │
│  Cross-User:                                     │
│  MessagingAdapter · ReplicationAdapter · AuthZ   │
├─────────────────────────────────────────────────┤
│            Adapter Implementations               │
│  EvoluStorageAdapter │ WebSocket Relay            │
│  WotIdentity (Ed25519, HKDF, WebCrypto)          │
└─────────────────────────────────────────────────┘
```

## Installation

```bash
# Aus dem Monorepo-Root:
pnpm install
pnpm --filter demo dev
```

Die App läuft dann unter <http://localhost:5173> (oder nächster freier Port).

## Multi-User Testing

### Verifizierung testen

1. **Tab A**: Öffne <http://localhost:5173> → Identität erstellen
2. **Tab B**: Öffne <http://localhost:5173> im Inkognito-Fenster → Identität erstellen
3. **Tab A**: Gehe zu "Verifizieren" → QR-Code wird angezeigt
4. **Tab B**: Gehe zu "Verifizieren" → QR-Code scannen (oder Code manuell kopieren)
5. **Tab A**: Antwort-Code scannen/einfügen → Verifizierung abschließen
6. Beide Tabs zeigen den jeweils anderen als verifizierten Kontakt

### Attestierungen testen

1. Erstelle eine Attestierung in Tab A für einen verifizierten Kontakt
2. Die Attestierung wird automatisch über den WebSocket Relay zugestellt
3. In Tab B erscheint die Attestierung unter "Erhalten"
4. Der Empfänger kann sie annehmen oder ablehnen

## Projektstruktur

```
demo/src/
├── adapters/           # Adapter-Implementierungen
│   └── EvoluStorageAdapter.ts
├── components/
│   ├── attestation/    # AttestationCard, AttestationList, Create, Import
│   ├── contacts/       # ContactList, ContactCard
│   ├── identity/       # IdentityManagement, Onboarding, Recovery, Unlock
│   ├── layout/         # AppShell, Navigation
│   ├── shared/         # Avatar, AvatarUpload, InfoTooltip, etc.
│   └── verification/   # VerificationFlow, ShowCode, ScanCode
├── context/            # React Context (AdapterContext, IdentityContext)
├── hooks/              # useContacts, useAttestations, useMessaging, etc.
├── pages/              # Home, Identity, Contacts, Verify, Attestations
└── services/           # ContactService, AttestationService, VerificationService
```

## Nächste Schritte

- [ ] Profil-Sync (Name bei Verification + Broadcast an Kontakte)
- [ ] Automerge für Cross-User CRDT-Spaces
- [ ] Föderiertes Messaging (Matrix)
- [ ] Gruppen-Räume
- [ ] Capability-basierte Berechtigungen

## Lizenz

MIT
