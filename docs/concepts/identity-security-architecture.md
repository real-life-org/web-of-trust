# Identity Security Architecture

> Konzept für sichere, portable und framework-agnostische Identitätsverwaltung im Web of Trust

**Status:** Design Phase
**Erstellt:** 06. Februar 2026
**Kontext:** POC Planung mit Real Life Stack + Web of Trust

---

## Problem Statement

Web of Trust braucht:
1. **Stabile DIDs** - Identität bleibt über Prototypen hinweg gleich
2. **Framework-Agnostik** - Unabhängig von Evolu/Jazz/Custom
3. **Starke Security** - Non-extractable Keys wo möglich
4. **Recovery** - BIP39 Mnemonic für Portabilität
5. **Key Rotation** - Keys können gewechselt werden ohne Identity zu verlieren

Externe Frameworks (Evolu, Jazz) haben Constraints:
- Brauchen Keys als serialisierbare Bytes
- Haben eigenes Key-Management
- Non-extractable CryptoKeys funktionieren nicht

---

## Architektur-Optionen

### Option A: Pure Non-Extractable (❌ funktioniert nicht)

```
Master Key (non-extractable)
    ↓ deriveBits
Derived Keys (extractable bytes) ← Problem!
```

**Problem:** WebCrypto deriveBits gibt extractable Bytes zurück, die von Frameworks gebraucht werden.

### Option B: WebAuthn Only (⚠️ zu komplex)

```
WebAuthn Credential (Hardware-backed)
    ↓ PRF Extension
Derived Keys
```

**Problem:**
- PRF Extension nicht überall supported
- Recovery schwierig (kein Mnemonic)
- Zu komplex für POC

### Option C: Baseline + Optional WebAuthn (✅ Empfohlen)

```
┌─────────────────────────────────────────┐
│ BASELINE (alle User)                    │
│ • BIP39 Mnemonic                        │
│ • Master Seed verschlüsselt at rest     │
│ • Identity Private Key non-extractable  │
│ • Framework Keys extractable            │
└─────────────────────────────────────────┘
         │
         ▼ (optional upgrade)
┌─────────────────────────────────────────┐
│ WEBAUTHN UPGRADE (Power User)           │
│ • Hardware-backed encryption            │
│ • Biometric Auth (TouchID/FaceID)       │
│ • Master Seed mit PRF verschlüsselt     │
└─────────────────────────────────────────┘
```

---

## Option C im Detail

### Key-Hierarchie

```
BIP39 Mnemonic (24 Wörter, User schreibt auf)
    ↓
Master Seed (32 bytes, verschlüsselt at rest)
    ↓ HKDF
    ├─→ Identity Key (Ed25519, Private Key non-extractable!)
    │   └─→ DID (did:key oder did:web)
    │
    ├─→ Evolu Key (extractable, für Framework)
    │
    ├─→ Jazz Key (extractable, für Framework)
    │
    └─→ Custom Key (extractable, für Framework)
```

### Security Layers

1. **Verschlüsselung at Rest**
   - Master Seed mit AES-GCM verschlüsselt
   - PBKDF2 (600k iterations) von User Passphrase
   - In IndexedDB gespeichert

2. **Non-Extractable Private Keys**
   - Identity Private Key als non-extractable importiert
   - JavaScript kann nicht exportieren
   - Nur via crypto.subtle.sign() nutzbar

3. **Content Security Policy**
   - Inline Scripts verboten
   - Nur eigene Scripts erlaubt

4. **Session Timeout**
   - Master Seed aus Memory löschen nach Inaktivität
   - User muss neu unlocken

5. **Optional: WebAuthn**
   - Hardware-backed encryption
   - Biometric Auth

### Migration zu Custom Framework

Später mit Custom Framework: Alle Keys non-extractable!

```typescript
// Custom Framework: Volle Kontrolle
const masterKey = await crypto.subtle.importKey(
  'raw', seed,
  { name: 'HKDF' },
  false,  // non-extractable
  ['deriveKey']
)

// Alle derived Keys auch non-extractable
const storageKey = await crypto.subtle.deriveKey(
  { name: 'HKDF', ... },
  masterKey,
  { name: 'AES-GCM', length: 256 },
  false,  // non-extractable!
  ['encrypt', 'decrypt']
)
```

---

## DID Method & Key Rotation

### Problem mit did:key

```
did:key:z6MkABC... ← Encoded den Public Key direkt

Problem:
- Key Rotation unmöglich
- Neuer Key = Neue DID = Neue Identity
- Alle Verifications verloren!
```

### Lösung: did:web

```
did:web:real-life-stack.de:users:anton
    ↓
DID Document (updatable!)
{
  "id": "did:web:...",
  "verificationMethod": [
    { "id": "#key-1", "created": "2026-02-01", ... },
    { "id": "#key-2", "created": "2026-06-01", ... }  ← Neuer Key
  ],
  "authentication": ["#key-2"]  ← Aktueller Key
}
```

**Vorteile:**
- DID bleibt stabil
- Keys können rotiert werden
- Alte Verifications bleiben gültig (timestamp-based)
- Migration von did:key → did:web möglich (via Equivalence Proofs)

---

## KRITISCHER PUNKT: Community Onboarding

### ⚠️ Problem

**Wenn POC mit did:key startet:**
```
User erstellt Identity:
  → did:key:z6MkABC...
  → Verifications sammeln
  → Community wächst

Migration zu did:web:
  → did:web:real-life-stack.de:users/anton
  → ANDERE DID!
  → Alle Verifications verloren ❌
  → Community fragmentiert ❌
```

### ✅ Lösungen

#### Option 1: Start mit did:web (Empfohlen!)

```
POC nutzt did:web von Anfang an:
  → did:web:poc.real-life-stack.de:users:u-abc123
  → Key Rotation möglich
  → Verifications bleiben bei Migration
  → Braucht Server für DID Documents
```

#### Option 2: Equivalence Proofs

```
Migration did:key → did:web:
  → Equivalence Proof erstellen (signiert mit altem Key)
  → Verifier können Äquivalenz prüfen
  → Alte Verifications bleiben technisch gültig
  → ABER: Komplexer für Verifier
```

#### Option 3: Soft Launch

```
POC ohne externe Tester:
  → Nur Dev-Team (Anton, Sebastian, Mathias)
  → Migration zu did:web vor Community-Launch
  → Community startet mit stabiler Architektur
```

---

## Empfehlung für POC

### Phase 1: Foundation (2-3 Wochen)

**Identity System:**
- ✅ BIP39 Mnemonic + Passphrase (Baseline)
- ✅ **did:web** von Anfang an (für Key Rotation!)
- ✅ HKDF Key Derivation (framework-agnostisch)
- ✅ Non-extractable Identity Private Key
- ❌ WebAuthn noch nicht (später)

**DID Infrastructure:**
- Server-Endpoint für DID Document Publishing
- DID Resolution (/.well-known/did.json)
- Einfaches Backend (Express/Hono)

**Vorteil:**
- Community kann onboarden ohne Datenverlust
- Key Rotation ist möglich
- Framework-agnostisch
- Upgrade-Path existiert

### Phase 2: WebAuthn Upgrade (1 Woche)

- Optional Hardware Security
- Biometric Auth
- Für Power User

### Phase 3: Custom Framework (3-4 Monate, parallel)

- Alle Keys non-extractable
- Optimiert für Web of Trust
- Full Control

---

## Implementation Checklist

### Baseline Identity

- [ ] BIP39 Mnemonic Generation
- [ ] Master Seed Derivation
- [ ] HKDF Key Derivation (Identity, Evolu, etc.)
- [ ] Ed25519 KeyPair (Private Key non-extractable)
- [ ] Master Seed Encryption (PBKDF2 + AES-GCM)
- [ ] IndexedDB Storage
- [ ] Session Management (unlock/lock)

### DID Infrastructure

- [ ] did:web Implementation
- [ ] DID Document Schema
- [ ] Server Endpoint (POST /api/did/publish)
- [ ] DID Resolution (GET /.well-known/did.json)
- [ ] Authentication für DID Updates

### Key Rotation

- [ ] DID Document Update Flow
- [ ] Multiple Verification Methods Support
- [ ] Revocation Mechanism
- [ ] Timestamp-based Verification
- [ ] Migration Tools (did:key → did:web falls nötig)

### Security

- [ ] CSP Headers
- [ ] Subresource Integrity
- [ ] Session Timeout
- [ ] Memory Cleanup (seed.fill(0))
- [ ] XSS Prevention

### Optional WebAuthn

- [ ] WebAuthn Support Check
- [ ] PRF Extension Check
- [ ] Enrollment Flow
- [ ] Unlock Flow
- [ ] Settings UI

---

## Trade-offs

| Aspekt | did:key | did:web |
|--------|---------|---------|
| **Komplexität** | ⭐ Einfach | ⭐⭐ Mittel |
| **Server nötig** | ❌ Nein | ✅ Ja |
| **Offline** | ✅ Ja | ⚠️ Resolution braucht Online |
| **Key Rotation** | ❌ Unmöglich | ✅ Möglich |
| **Community-ready** | ❌ Nein (Migration-Risiko) | ✅ Ja |
| **POC Timeline** | +0 Wochen | +1 Woche |

---

## Nächste Schritte

1. **Entscheidung:** did:key oder did:web für POC?
2. **Implementation:** Baseline Identity System
3. **DID Server:** Einfaches Backend für DID Documents
4. **Testing:** Identity Creation, Recovery, Key Rotation
5. **Community:** Soft Launch mit did:web

---

## Offene Fragen

1. **DID Method:** did:key (einfach) vs. did:web (community-ready)?
2. **Server Hosting:** Wo hosten wir DID Documents?
3. **Backup Strategy:** Wie backupen wir DID Documents?
4. **Migration:** Was wenn did:web Server down? Fallback?

---

**Fazit:** did:web von Anfang an ist die sicherste Option für Community-Building, auch wenn es etwas mehr Implementierungsaufwand bedeutet.
