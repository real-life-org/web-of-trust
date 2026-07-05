# Web of Trust ↔ LoRa-Mesh (Meshtastic) — Konzept & Use Cases

> Status: Konzept / Exploration. Ausgelöst durch das Mesh-Netz auf dem DWeb Camp
> 2026 (868-MHz-LoRa, Meshtastic). Noch nicht implementiert.

## Kontext

Auf dem DWeb Camp gibt es ein **Meshtastic**-Netz (868 MHz LoRa). Vorgeflashte
Nodes sind vor Ort ausleihbar; dazu ein Mesh-Workshop. Frage: Was lässt sich
sinnvoll mit Web of Trust verbinden?

**Hardware (unser Setup):**
- **Heltec LoRa32 V4** (ESP32-S3) → Gateway-Node am Raspberry Pi (USB-Serial).
- **Elecrow ThinkNode M1** (nRF52840, BLE, E-Ink, GPS, 48 h+) → Handy-Node.
- Camp-„Companion"-Node → dritter Node / Reserve.
- Alle: Meshtastic, Region **EU_868**.

## Grundprinzip: komplementär, nicht Transport-Ersatz

**Harter Constraint — LoRa-Bandbreite:** ~237 Byte pro Paket, dazu strenge
Duty-Cycle-Grenzen (EU 868 ≈ 1 %). Realistisch nur **wenige kurze Nachrichten
pro Minute im gesamten Mesh**. WoT syncst dagegen **KB-große** JWS-Envelopes und
CRDT-Log-Einträge (encrypt-then-sync).

→ **Den WoT-Relay „über LoRa" laufen zu lassen ist keine Option** (Größenordnungen
zu wenig Durchsatz). Das versuchen wir bewusst nicht.

**Das Modell stattdessen — zwei Schichten, die sich ergänzen:**

| Schicht | Rolle | Transport |
|---|---|---|
| **WiFi-Box (der Pi)** | volle E2EE-Daten: Spaces, Attestations, Vault | WLAN `wot-demo`, WebSocket-Relay |
| **LoRa-Mesh** | winzige, hochwertige Signale über km, offline | Meshtastic, custom portnum |
| **Web of Trust** | **Identitäts- + Vertrauensschicht** über beidem | `did:key`, Ed25519-Signaturen |

Kurz: **LoRa = offline-Transport für Kurzsignale, WoT = wer-ist-wer + Vertrauen,
die Box = voller Sync-Hub.**

## Use Cases (nach Machbarkeit / Wert)

### 1. Node-Binding-Attestation (Kern, gut machbar)
Eine WoT-Attestation bindet einen **Meshtastic-Node(-Key) an eine `did:key`**:
„Node X gehört zu did:key:… — signiert von did:key:…". Der Austausch läuft
**out-of-band** über WiFi/QR (die Box), **nicht** über LoRa. Danach sind
Mesh-Pakete dieses Nodes einer **verifizierten WoT-Identität** zuordenbar.
→ Ermöglicht Attribution + Trust-Filter (Use Case 4). Reine Software plus
Auslesen der Node-Identität über die Meshtastic-API.

### 2. Signierte Micro-Messages
Auf einem **eigenen portnum**: `Ed25519-Signatur (64 B) + kurzer DID-Verweis +
Kurztext (~100 Zeichen)` passt knapp in ein LoRa-Paket. Ergebnis:
**authentifizierte** Kurznachrichten statt pseudonymer Node-IDs.

### 3. Präsenz-/Discovery-Beacons
Kleine Broadcasts „ich bin hier, did:key:X" → **offline WoT-Identitäten
entdecken** am Camp (wer aus meinem Netz ist in Funkreichweite?).

### 4. Trust-Graph-Filter
Mesh-Nachrichten nach **WoT-Nähe** anzeigen: real verifiziert / 1 Hop entfernt /
unbekannt. Macht aus einem offenen Broadcast-Kanal ein **vertrauens-gewichtetes**
Erlebnis — der eigentliche WoT-Mehrwert.

### 5. Pi-Box als LoRa↔WiFi-Gateway
Meshtastic kann per MQTT bridgen. Ein LoRa-Radio am Pi macht die Box zum
**Gateway**: Leute weit weg vom `wot-demo`-WLAN erreichen über das Mesh trotzdem
kleine WoT-Primitive (Präsenz, „neue Attestation für dich"-Notice,
Verifikations-Pointer); WiFi-Nutzer schicken kurze Signale ins Mesh.

## Architektur-Skizze

```
did:key + Ed25519 (WoT-Identität, wot-core)
        │  signiert / verifiziert
        ▼
Python-Bridge (auf dem Pi)  ── USB-Serial ──►  Heltec V4  ── LoRa ──►  Mesh
        │  (meshtastic-python API, custom portnum)                      ▲
        └── WLAN: WoT-Relay/Box (voller E2EE-Sync)                      │
                                                    Handy ── BLE ──► ThinkNode M1
```

- **Custom portnum** trägt WoT-Frames (Beacon / signierte Nachricht).
- **Payload-Budget:** WoT-Frame ≤ ~200 B (Rest für Meshtastic-Header).
- **Duty-Cycle-Leitplanke:** Beacons selten (z.B. Präsenz alle N Minuten), keine
  Chat-Fluten.

## Was bewusst NICHT über LoRa läuft
- Relay-/CRDT-/Vault-Sync, Log-Einträge, ganze Attestations (nur **Referenzen/
  Pointer**, die Daten holt man über WiFi/Box).

## Offene Fragen
- Meshtastics eigene per-Node-PKI (Curve25519 in neuerer Firmware) —
  wiederverwenden oder separate Bindung?
- Custom portnums via App/MQTT: was erlaubt die Firmware konkret?
- Schema der Node-Binding-Attestation in `wot-core`.
- EU_868 Duty-Cycle-Compliance bei Beacon-Frequenz.

## Demo-Narrativ (DWebCamp)
„**Face-to-face verifizieren** (WoT, über die Box), dann über **km hinweg im Camp
signiert & trust-gefiltert funken** (Mesh) — beides **ohne Internet**." Die Box
ist Sync-Hub *und* Mesh-Gateway.

## Nächste Schritte
1. Hardware: M1 vorab optional (solo-Entwicklung), Heltec kommt Mi am Camp,
   Camp-Node vor Ort.
2. Bauen (solo mit **einem** Node testbar): Python-Bridge-Gerüst +
   Node-Binding-Attestation-Datenmodell + signierter Präsenz-Beacon
   (Encode/Sign/Verify + Sende-Pfad).
3. Am Camp: echte Funkstrecke mit ≥ 2 Radios verifizieren, Trust-Filter zeigen.

> Verwandt: [deploy/offline-pi/README.md](../../deploy/offline-pi/README.md) — die
> Offline-Box, die als Mesh-Gateway erweitert würde.
