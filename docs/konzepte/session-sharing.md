# E2E-verschlüsseltes Session-Sharing

> Konzeptdokument — Stand: 2. März 2026
> Diskussionsgrundlage aus dem Gespräch Anton + Tillmann (1. März 2026)

## Ziel

Nutzer im Web of Trust können einzelne Claude-Sessions gezielt miteinander teilen. Die Sessions werden Ende-zu-Ende verschlüsselt, sodass weder der Relay-Server noch Dritte den Inhalt lesen können. Empfänger erhalten die Sessions in ihrem lokalen Session-Archiv.

---

## Entscheidungen (1. März 2026)

| Entscheidung | Begründung |
|---|---|
| **WoT-Identity nutzen** (Ed25519/X25519) | Existiert bereits, kein zweites Schlüsselsystem nötig |
| **Item-Key-Pattern** (nicht Attestations) | Attestations sind für Vertrauensaussagen, nicht für Datenübertragung |
| **AES-256-GCM + X25519 Wrap** | Bewährt, offline-fähig, im CryptoAdapter bereits implementiert |
| **MLS für Gruppenfreigabe** (Zukunft) | Item-Keys skalieren bei >50 Empfängern schlecht (O(N)) |
| **Relay als Transport** | Store-and-forward, kein P2P nötig, existiert bereits |
| **Local-First** | Sessions werden lokal gespeichert, Relay ist nur Transport |

---

## Architektur

```
┌─────────────┐                          ┌─────────────┐
│   Anton      │                          │  Tillmann    │
│              │                          │              │
│ Session      │    ┌──────────────┐      │ Session      │
│ Archiv       │───▶│  WoT Relay   │◀─────│ Archiv       │
│ (lokal)      │    │  (encrypted  │      │ (lokal)      │
│              │    │   store &    │      │              │
│ WoT Identity │    │   forward)   │      │ WoT Identity │
│ (Ed25519)    │    └──────────────┘      │ (Ed25519)    │
└─────────────┘                          └─────────────┘
```

### Verschlüsselungsflow (1:1)

```
Sender (Anton):
1. sessionKey = AES-256-GCM random key
2. encryptedSession = AES-GCM(session_jsonl, sessionKey)
3. wrappedKey = X25519-ECIES(sessionKey, tillmann.publicKey)
4. → Relay: { encryptedSession, wrappedKey, from: anton.did, to: tillmann.did }

Relay:
- Speichert verschlüsselten Blob
- Liefert bei Tillmanns nächster Verbindung aus
- Löscht nach ACK

Empfänger (Tillmann):
1. sessionKey = X25519-ECIES.decrypt(wrappedKey, myPrivateKey)
2. session_jsonl = AES-GCM.decrypt(encryptedSession, sessionKey)
3. → Import ins lokale Session-Archiv
```

### Gruppenfreigabe (Zukunft: MLS)

Für die Freigabe an mehrere Personen gleichzeitig (z.B. eine Session an ein ganzes Team):

- **Kurzfristig (POC):** Item-Key pro Empfänger wrappen (O(N), aber einfach)
- **Langfristig:** MLS (RFC 9420) — Ratchet Tree für O(log N) Key-Updates, Forward Secrecy

---

## Schlüsselspeicherung

| Nutzer | Methode | Details |
|---|---|---|
| Anton | System Keyring | GNOME Keyring / KDE Wallet über `keytar` |
| Tillmann | 1Password CLI | `op read "op://vault/wot-key/private"` |
| Allgemein | Key-Provider Interface | Abstraktion, die verschiedene Backends unterstützt |

### Key-Provider Interface (Skizze)

```typescript
interface KeyProvider {
  getPrivateKey(): Promise<Uint8Array>;
  getPublicKey(): Promise<Uint8Array>;
}

// Implementierungen:
class SystemKeychainProvider implements KeyProvider { ... }
class OnePasswordProvider implements KeyProvider { ... }
class EnvVarProvider implements KeyProvider { ... }  // für CI/Testing
```

Die WoT-Identity (BIP39 Mnemonic → Ed25519) kann über den Seed auch als X25519-Schlüssel abgeleitet werden — das ist bereits im CryptoAdapter implementiert.

---

## Integration in Claude Code

Zwei Optionen wurden diskutiert:

| | MCP Tool | Skill |
|---|---|---|
| **Aufruf** | Automatisch durch Claude | Manuell per `/share-session` |
| **Komplexität** | Höher (MCP Container braucht Zugang zu Keys) | Niedriger (läuft in Claude Code) |
| **Empfehlung** | Für Empfang (automatisch importieren) | Für Senden (bewusste Aktion) |

### Workflow: Session teilen

```
Anton: /share-session tillmann
→ Skill listet letzte Sessions auf
→ Anton wählt Session(s) aus
→ Verschlüsselung + Upload zum Relay
→ Tillmann bekommt bei nächster Verbindung die Session(s)
```

### Workflow: Sessions empfangen

```
Claude Code startet → MCP Tool prüft Relay auf neue Nachrichten
→ Verschlüsselte Sessions werden heruntergeladen
→ Entschlüsselung mit lokalem Private Key
→ Import ins Session-Archiv
→ "Du hast 2 neue Sessions von Anton erhalten"
```

---

## Transport: WoT Relay

Der bestehende WoT Relay (`wss://relay.utopia-lab.org`) wird genutzt:

- **Store-and-forward:** Nachrichten bleiben bis zum ACK des Empfängers
- **Delivery ACK:** Bereits implementiert — Relay persistiert in SQLite, redelivery bei Reconnect
- **Multi-Device:** Unterstützt mehrere Geräte pro Identity
- **Kein P2P nötig:** Relay ist immer erreichbar, Nutzer müssen nicht gleichzeitig online sein

### Relay-Vergleich (aus der Diskussion)

| | Kafka | Nostr Relays | WoT Relay |
|---|---|---|---|
| **Zweck** | Event-Streaming (Total Order) | Signed Events, Public | Encrypted Delivery, Private |
| **Persistenz** | Log (unbegrenzt) | Relay-abhängig | Bis ACK |
| **Ordering** | Total Order | Kein | Kein (nicht nötig) |
| **Auth** | Cluster-intern | Public Keys | WoT Identity (DID) |
| **Für uns** | Overkill | Inspiration | Passt |

---

## Abgrenzung

| Was | Session-Sharing | Automerge Spaces |
|---|---|---|
| **Datentyp** | JSONL (Session-Transkript) | CRDT (strukturierte Daten) |
| **Richtung** | Punkt-zu-Punkt oder selektiv | Gruppensync (alle sehen alles) |
| **Verschlüsselung** | Item-Key (pro Session) | GroupKeyService (pro Space) |
| **Transport** | Relay (store-and-forward) | Relay (sync-Protokoll) |
| **Konflikte** | Keine (immutable Sessions) | Automerge löst sie |

Session-Sharing ist **einfacher** als Automerge Spaces, weil Sessions immutable sind — keine Merge-Konflikte, keine CRDTs, kein Sync-State.

---

## Existierende Bausteine im WoT

| Baustein | Status | Wo |
|---|---|---|
| Ed25519 Identity | ✅ Fertig | `WotIdentity` |
| X25519 Key Exchange | ✅ Fertig | `CryptoAdapter.deriveSharedSecret()` |
| AES-256-GCM | ✅ Fertig | `CryptoAdapter.encryptSymmetric()` |
| X25519 ECIES (Wrap) | ✅ Fertig | `CryptoAdapter.encryptAsymmetric()` |
| Relay + ACK | ✅ Fertig | `WebSocketMessagingAdapter` |
| Delivery Persistence | ✅ Fertig | `wot-relay` (SQLite) |
| DID Discovery | ✅ Fertig | `HttpDiscoveryAdapter` |

**Was noch fehlt:**
- [ ] Session-Envelope Format (Header + verschlüsselter Body)
- [ ] `KeyProvider`-Interface (Keyring / 1Password / Env)
- [ ] `/share-session` Skill für Claude Code
- [ ] Auto-Import bei Session-Start (MCP oder Hook)
- [ ] UI im Session-Archiv: "Geteilte Sessions" Ansicht

---

## Offene Fragen

1. **Session-Granularität:** Ganze Sessions teilen oder einzelne Nachrichten/Abschnitte?
2. **Berechtigungen:** Kann Tillmann eine von Anton erhaltene Session an Timo weiterleiten?
3. **Widerruf:** Kann Anton eine geteilte Session zurückziehen? (Technisch schwierig bei Local-First)
4. **Metadaten:** Welche Metadaten sind unverschlüsselt sichtbar? (Sender-DID, Empfänger-DID, Timestamp — muss so sein für Relay-Routing)
5. **SSH-Key-Kompatibilität:** Können WoT-Keys als SSH-Keys wiederverwendet werden? (Ja, via BIP39 Seed Re-Derivation — wurde am 1. März besprochen)

---

## Nächste Schritte

1. **Prototyp:** Minimal — eine Session verschlüsseln und über den Relay senden
2. **Unabhängig vom Session-Archiv:** Eigener lokaler Store für geteilte Sessions (kein Umbau des bestehenden Archivs nötig)
3. **KeyProvider:** Interface definieren, SystemKeychain + 1Password implementieren
4. **Skill:** `/share-session` in Claude Code
