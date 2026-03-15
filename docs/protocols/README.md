# Protokolle

> Kommunikations- und Verschlüsselungsprotokolle im Web of Trust

## Inhalt

| Dokument | Beschreibung |
|----------|--------------|
| [**Adapter-Architektur v2**](adapter-architektur-v2.md) | **6-Adapter-Spezifikation, Interaction-Flows, Phase-1-Kriterien** |
| [Framework-Evaluation v2](framework-evaluation.md) | 16 Frameworks evaluiert, Anforderungs-Matrix |
| [Verschlüsselung](verschluesselung.md) | E2E-Verschlüsselung, Protokoll-Vergleich |
| [Sync-Protokoll](sync-protokoll.md) | Offline/Online Synchronisation |
| [QR-Code-Formate](qr-code-formate.md) | QR-Code-Strukturen für Verifizierung |

---

## Überblick

```mermaid
flowchart TD
    subgraph Verschluesselung["Verschlüsselung"]
        E2E[E2E-Encryption]
        GK[Group Key Management]
        IK[Item Keys]
    end

    subgraph Sync["Synchronisation"]
        CRDT[CRDT-basiert]
        Offline[Offline-First]
        Conflict[Konfliktauflösung]
    end

    subgraph Transport["Transport"]
        QR[QR-Codes]
        Server[Sync-Server]
    end

    E2E --> Server
    GK --> Server
    IK --> Server

    CRDT --> Server
    Offline --> CRDT

    QR --> E2E
```

---

## Kernprinzipien

### 1. End-to-End-Verschlüsselung

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Der Server sieht nur verschlüsselte Daten                  │
│                                                             │
│  Anna's Gerät ──[verschlüsselt]──► Server                   │
│                                        │                    │
│                                        ▼                    │
│  Ben's Gerät  ◄──[verschlüsselt]────────                    │
│                                                             │
│  Entschlüsselung nur auf den Geräten der Empfänger          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2. Offline-First

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Alle Operationen funktionieren offline:                    │
│                                                             │
│  ✅ Kontakte ansehen                                        │
│  ✅ Items erstellen/bearbeiten                              │
│  ✅ Attestationen erstellen                                 │
│                                                             │
│  Bei Verbindung:                                            │
│  🔄 Automatischer Sync                                      │
│  🔄 Konfliktauflösung                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3. Dezentral

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Kein Single Point of Failure:                              │
│                                                             │
│  • Identität = eigener Private Key                          │
│  • Verifizierung = direkt zwischen Personen                 │
│  • Server = nur Transport & Speicher (austauschbar)         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Protokoll-Stack

| Schicht | Protokoll | Zweck |
|---------|-----------|-------|
| **Identität** | did:key | Dezentrale Identifier |
| **Signaturen** | Ed25519 | Verifizierungen, Attestationen |
| **Verschlüsselung** | X25519 + AES-256-GCM | Item-Verschlüsselung |
| **Gruppenschlüssel** | Item-Keys (POC), [weitere Optionen](verschluesselung.md) | Key Management für Gruppen |
| **Sync** | CRDT-basiert (Evolu lokal, Automerge cross-user) | Konfliktfreie Synchronisation |
| **Messaging** | WebSocket Relay (POC), Matrix (Produktion) | Cross-User Nachrichtenzustellung |
| **Transport** | HTTPS / WebSocket | Server-Kommunikation |

---

## Weiterführend

- [Adapter-Architektur v2](adapter-architektur-v2.md) - 6-Adapter-Spezifikation und Interaction-Flows
- [Framework-Evaluation v2](framework-evaluation.md) - 16 Frameworks evaluiert
- [Verschlüsselung im Detail](verschluesselung.md) - Wie Items verschlüsselt werden
- [Sync-Protokoll](sync-protokoll.md) - Wie Offline-Änderungen synchronisiert werden
- [QR-Code-Formate](qr-code-formate.md) - QR-Strukturen für Verifizierung
- [Datenmodell](../data-model/README.md) - Entitäten und Schemas
