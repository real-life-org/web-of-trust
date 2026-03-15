# Best Practices

> Implementierungsrichtlinien für das Web of Trust

## Kryptografie

### Private Key Speicherung

| Plattform | Empfehlung | Fallback |
|-----------|------------|----------|
| **iOS** | Keychain + Secure Enclave | Keychain |
| **Android** | Keystore (Hardware-backed) | Keystore (Software) |
| **Web** | Web Crypto API (`extractable: false`) | - |

```javascript
// Web Crypto API Beispiel
const keyPair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  false, // extractable = false!
  ["sign", "verify"]
);
```

### Schlüsselableitung

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Recovery Phrase → Seed → Key Pair                          │
│                                                             │
│  ✅ BIP39 für Mnemonic                                      │
│  ✅ PBKDF2 oder Argon2 für Seed                             │
│  ✅ Ed25519 für Key Pair                                    │
│                                                             │
│  ❌ Keine eigenen Ableitungsfunktionen                      │
│  ❌ Kein MD5, SHA1                                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Verschlüsselung

| Zweck | Algorithmus | Modus |
|-------|-------------|-------|
| Symmetrisch | AES-256 | GCM (authentifiziert) |
| Asymmetrisch | X25519 | + HKDF |
| Signaturen | Ed25519 | - |

### Zufallszahlen

```javascript
// ✅ Korrekt
const randomBytes = crypto.getRandomValues(new Uint8Array(32));

// ❌ Falsch
const bad = Math.random(); // Nicht kryptografisch sicher!
```

---

## Signaturvalidierung

### Bei jedem Sync prüfen

```javascript
async function validateVerification(verification) {
  // 1. Schema validieren
  if (!isValidSchema(verification)) {
    throw new Error("Ungültiges Schema");
  }

  // 2. DID Format prüfen
  if (!verification.from.startsWith("did:key:")) {
    throw new Error("Ungültiges DID Format");
  }

  // 3. Signatur verifizieren
  const publicKey = extractPublicKey(verification.from);
  const payload = canonicalize({
    type: verification.type,
    from: verification.from,
    to: verification.to,
    timestamp: verification.timestamp
  });

  if (!await verify(payload, verification.proof.proofValue, publicKey)) {
    throw new Error("Ungültige Signatur");
  }

  return true;
}
```

### Kanonisierung

Vor dem Signieren/Verifizieren: Objekt kanonisieren (deterministisch serialisieren).

```javascript
// ✅ Korrekt: Deterministische Sortierung
function canonicalize(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

// ❌ Falsch: JSON.stringify Reihenfolge ist nicht garantiert
```

---

## Transport

### TLS

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ✅ TLS 1.3                                                 │
│  ✅ Certificate Pinning für Production                      │
│  ✅ HSTS                                                    │
│                                                             │
│  ❌ Kein TLS 1.0/1.1                                        │
│  ❌ Keine selbstsignierten Zertifikate in Production        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Certificate Pinning

```javascript
// React Native Beispiel
const sslPinning = {
  certs: ["sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="]
};

fetch(url, { sslPinning });
```

---

## Lokale Speicherung

### Datenbank-Verschlüsselung

| Plattform | Empfehlung |
|-----------|------------|
| iOS | Core Data + Data Protection |
| Android | SQLCipher oder EncryptedSharedPreferences |
| Web | IndexedDB (Browser-Encryption) |

### Sensitive Daten

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  NIE im Klartext speichern:                                 │
│                                                             │
│  ❌ Private Key (nur in Keychain/Keystore)                  │
│  ❌ Recovery Phrase (nie speichern nach Onboarding)         │
│  ❌ Item Keys (verschlüsselt speichern)                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Input-Validierung

### Schema-Validierung

Alle eingehenden Daten gegen JSON-Schema validieren.

```javascript
import Ajv from "ajv";
import profileSchema from "./schemas/profile.schema.json";

const ajv = new Ajv();
const validate = ajv.compile(profileSchema);

function validateProfile(data) {
  if (!validate(data)) {
    console.error(validate.errors);
    throw new Error("Ungültiges Profil");
  }
}
```

### DID-Validierung

```javascript
function isValidDid(did) {
  // 1. Format prüfen
  if (!did.match(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/)) {
    return false;
  }

  // 2. Public Key extrahieren und validieren
  try {
    const publicKey = extractPublicKey(did);
    return publicKey.length === 32; // Ed25519
  } catch {
    return false;
  }
}
```

---

## Fehlerbehandlung

### Keine sensitiven Infos in Fehlern

```javascript
// ❌ Falsch
throw new Error(`Decryption failed for key ${privateKey}`);

// ✅ Korrekt
throw new Error("Decryption failed");
```

### Timing-Attacken vermeiden

```javascript
// ❌ Falsch: Early return verrät Informationen
function checkPassword(input, stored) {
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== stored[i]) return false;
  }
  return true;
}

// ✅ Korrekt: Konstante Zeit
function checkPassword(input, stored) {
  let result = 0;
  for (let i = 0; i < input.length; i++) {
    result |= input.charCodeAt(i) ^ stored.charCodeAt(i);
  }
  return result === 0;
}
```

---

## Logging

### Was NICHT loggen

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ❌ Private Keys                                            │
│  ❌ Recovery Phrase                                         │
│  ❌ Verschlüsselungsschlüssel                               │
│  ❌ Vollständige DIDs (nur gekürzt)                         │
│  ❌ Nachrichteninhalte                                      │
│  ❌ Attestation-Texte                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Akzeptables Logging

```javascript
// ✅ OK
console.log(`Sync completed: ${itemCount} items`);
console.log(`Verification with did:key:z6Mk...${did.slice(-8)}`);

// ❌ Nicht OK
console.log(`Private key: ${privateKey}`);
console.log(`Attestation: ${attestation.claim}`);
```

---

## Updates und Dependencies

### Dependency-Management

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ✅ Regelmäßige Security-Updates                            │
│  ✅ Dependabot oder Snyk aktivieren                         │
│  ✅ Lock-Files committen                                    │
│  ✅ Nur vertrauenswürdige Crypto-Libraries                  │
│                                                             │
│  Empfohlene Libraries:                                      │
│  • @noble/curves (Ed25519, X25519)                          │
│  • @noble/ciphers (AES-GCM)                                 │
│  • libsodium-wrappers                                       │
│                                                             │
│  ❌ Keine unbekannten NPM-Pakete für Crypto                 │
│  ❌ Keine veralteten Libraries                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Checkliste

### Vor Release prüfen

- [ ] Private Keys nur in Secure Storage
- [ ] Alle Signaturen werden validiert
- [ ] Certificate Pinning aktiv
- [ ] Keine sensitiven Daten in Logs
- [ ] JSON-Schema-Validierung aktiv
- [ ] TLS 1.3 erzwungen
- [ ] Dependencies aktuell
- [ ] Security-Review durchgeführt

---

## Weiterführend

- [Threat Model](threat-model.md) - Risiken verstehen
- [Verschlüsselung](../protocols/verschluesselung.md) - Kryptografische Details
- [OWASP Mobile Security](https://owasp.org/www-project-mobile-security/)
