---
title: "Technisches Design: Wie die Demo funktioniert"
description: "Ein Blick unter die Haube: 6-Adapter Architektur, Ed25519-Kryptographie, Evolu als CRDT-Storage und ein blinder WebSocket Relay."
date: 2026-02-09
author: Anton Tranelis
---

# Technisches Design: Wie die Demo funktioniert

*9. Februar 2026 — Anton Tranelis*

Dieser Artikel beschreibt die technische Architektur der Web-of-Trust Demo. Er richtet sich an Entwickler, die verstehen wollen, wie die Bausteine zusammenspielen — oder die auf dem Projekt aufbauen möchten. Wer die Demo erst einmal ausprobieren will, findet eine Anleitung im [Einführungsartikel](/blog/demo-ausprobieren).

## Die 6-Adapter Architektur

Die gesamte Anwendungslogik ist über sechs Adapter abstrahiert (implementiert in [`wot-core`](https://github.com/antontranelis/web-of-trust/tree/main/packages/wot-core)). Das ermöglicht es, die Implementierung auszutauschen, ohne die Business-Logik zu ändern.

| Adapter | Aufgabe | POC-Implementierung |
|---------|---------|---------------------|
| **StorageAdapter** | Lesen/Schreiben von Identitäten, Kontakten, Attestierungen | Evolu (CRDT) |
| **ReactiveStorageAdapter** | Reaktive Subscriptions auf Datenänderungen | Evolu (watch) |
| **CryptoAdapter** | Signieren, Verifizieren, Verschlüsseln | WebCrypto (Ed25519) |
| **MessagingAdapter** | DID-zu-DID Nachrichtenversand | WebSocket Relay |
| **ReplicationAdapter** | CRDT-Sync zwischen Geräten/Nutzern | noch nicht implementiert |
| **AuthorizationAdapter** | Berechtigungen und Capabilities | noch nicht implementiert |

Die Adapter lassen sich in zwei Gruppen einteilen:

```
┌──────────────────────────────────────────────────┐
│                       Lokal                      │
│                                                  │
│  StorageAdapter    ReactiveStorage   Crypto      │
│  ┌────────────┐   ┌─────────────┐   ┌─────────┐  │
│  │ Identität  │   │  Reaktive   │   │Signieren│  │
│  │ Kontakte   │   │  Queries    │   │Prüfen   │  │
│  │ Atteste    │   │  (watch)    │   │Ableiten │  │
│  └────────────┘   └─────────────┘   └─────────┘  │
├──────────────────────────────────────────────────┤
│                    Cross-User                    │
│                                                  │
│  MessagingAdapter  ReplicationAdapter  AuthZ     │
│  ┌────────────┐   ┌─────────────┐   ┌────────┐   │
│  │ DID→DID    │   │ CRDT-Sync   │   │Zugriffs│   │
│  │ Nachrichten│   │ Räume       │   │rechte  │   │
│  │ (Relay)    │   │ (Automerge) │   │(UCAN)  │   │
│  └────────────┘   └─────────────┘   └────────┘   │
└──────────────────────────────────────────────────┘
```

Die lokalen Adapter sind das Fundament: alles was ein einzelner Nutzer auf seinem Gerät braucht. Die Cross-User Adapter bauen darauf auf und ermöglichen Interaktion — von Echtzeit-Nachrichten über synchronisierte Datenräume bis hin zu feingranularen Berechtigungen.

## Kryptographie

Die Identität basiert auf einer Kette von Ableitungen:

```
BIP39 Mnemonic (12 Wörter)
  → Seed (512 bit)
    → HKDF Master Key
      → Ed25519 Signing Key
        → did:key:z6Mk...
```

**BIP39** generiert 12 merkbare Wörter. Daraus wird ein Seed abgeleitet, aus dem über **HKDF** (HMAC-based Key Derivation) ein Master Key entsteht. Vom Master Key werden dann verschiedene Schlüssel für unterschiedliche Zwecke abgeleitet — der primäre ist ein **Ed25519**-Signaturschlüssel, aus dem die **DID** (Decentralized Identifier) im `did:key`-Format berechnet wird.

Warum did:key? Nach einer Evaluation von sechs DID-Methoden (did:web, did:peer, did:dht, did:plc, did:key, did:jwk) war did:key der klare Gewinner: selbst-zertifizierend, offline-fähig, kein Resolver nötig, Ed25519-nativ.

## Storage: Evolu

[Evolu](https://evolu.dev) ist ein CRDT-Framework, das Daten lokal in SQLite (über OPFS im Browser) speichert. Jeder Nutzer hat seine eigene Datenbank mit einem aus der Identität abgeleiteten Schlüssel.

**Vorteile:**
- Daten verlassen das Gerät nie unverschlüsselt
- Offline-first: Alles funktioniert ohne Netzwerk
- Reaktive Queries: UI aktualisiert sich automatisch bei Änderungen

**Grenze:**
Evolu ist für Single-Owner Daten konzipiert. Cross-User Sync (z.B. geteilte Räume, Profil-Sync zu anderen Nutzern) ist nicht möglich. Dafür planen wir den Umstieg auf **Automerge** für den Production-Stack.

## Messaging: WebSocket Relay

Weil Evolu keine Daten zwischen Nutzern austauschen kann, brauchen wir einen separaten Kanal für alles, was von Person A zu Person B muss — konkret: Attestierungen. Wenn Alice eine Attestierung über Bob erstellt, muss diese irgendwie bei Bob ankommen. Dafür nutzen wir einen WebSocket Relay.

Der Relay-Server ([`wot-relay`](https://github.com/antontranelis/web-of-trust/tree/main/packages/wot-relay)) ist bewusst minimal gehalten:

- **Blind:** Der Relay sieht nur verschlüsselte Envelopes. Er weiß wer sendet und wer empfängt (DIDs), aber nicht was.
- **Stateless Mapping:** DID → WebSocket Verbindung im Memory. Kein dauerhafter State über Nutzer.
- **Offline Queue:** SQLite-basiert. Nachrichten für offline Nutzer werden gespeichert und bei Reconnect ausgeliefert.
- **Protokoll:** JSON über WebSocket mit vier Message-Typen: `register`, `send`, `message`, `receipt`.

```
Alice                    Relay                     Bob
  |-- register(did_a) -->|                          |
  |<-- registered -------|                          |
  |                       |<-- register(did_b) -----|
  |                       |--- registered --------->|
  |-- send(envelope) --->|                          |
  |                       |--- message(envelope) -->|
  |<-- receipt(delivered) |                          |
```

Der Relay ist ein Platzhalter. Langfristig wollen wir auf ein föderiertes Protokoll umsteigen. Kandidaten sind Matrix (Ed25519-kompatibel, Megolm-E2EE, Federation), Nostr (einfach, relay-basiert) und DIDComm (DID-natives Messaging). Die Entscheidung steht noch aus.

## Verification: Challenge-Response

Die persönliche Verifizierung nutzt ein einfaches Challenge-Response-Protokoll:

1. **Alice** generiert eine Challenge (zufällige Bytes, Base64-kodiert), die ihre DID und ihren Public Key enthält.
2. **Bob** empfängt die Challenge, extrahiert Alices Public Key, generiert eine Response mit seiner eigenen DID und Public Key.
3. **Alice** empfängt die Response, verifiziert die Signatur und speichert Bob als verifizierten Kontakt.
4. Beide Seiten haben am Ende den Public Key des anderen — verifiziert durch physische Anwesenheit.

Kein Relay nötig. Kein Server involviert. Der Austausch passiert über Copy/Paste oder QR-Codes.

## Attestierungen

Eine Attestierung ist eine signierte JSON-Struktur:

```json
{
  "id": "uuid",
  "fromDid": "did:key:z6Mk...",
  "toDid": "did:key:z6Mk...",
  "claim": "Hat mir bei der Gartenarbeit geholfen",
  "tags": ["nachbarschaft", "garten"],
  "timestamp": "2026-02-09T14:30:00Z",
  "signature": "base64..."
}
```

Der Ablauf: Erstellen → Signieren → über Relay senden → Empfänger verifiziert Signatur → Akzeptieren/Ablehnen → In lokaler DB speichern.

## Ausblick

Die Demo beweist, dass die Grundbausteine funktionieren. Für den Production-Stack sind drei größere Schritte geplant:

1. **Automerge** ersetzt Evolu für Cross-User CRDT-Spaces (geteilte Räume, Profil-Sync)
2. **Föderiertes Messaging** ersetzt den WebSocket Relay (Kandidaten: Matrix, Nostr, DIDComm)
3. **Capability-basierte Berechtigungen** für feingranulare Zugriffsrechte (orientiert an Konzepten aus UCAN und Meadowcap/Willow)

Der Code ist Open Source: [github.com/antontranelis/web-of-trust](https://github.com/antontranelis/web-of-trust)
