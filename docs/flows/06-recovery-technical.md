# Recovery Flow (Technical Perspective)

> How an identity is restored from the recovery phrase

## Overview

```mermaid
flowchart TD
    Input(["Enter 12 words"]) --> Validate["BIP39 validate"]

    Validate --> Derive["Derive master key via HKDF"]

    Derive --> Generate["Derive Ed25519 KeyPair"]

    Generate --> ComputeDID["Compute DID"]

    ComputeDID --> Unlock["WotIdentity.unlock()"]

    Unlock --> Fetch["Fetch encrypted snapshot from Vault"]

    Fetch --> Decrypt["Decrypt PersonalDoc with derived key"]

    Decrypt --> Store["Write to PersonalDoc CRDT (Y.Map)"]

    Store --> Done(["Restored"])
```

---

## Main flow: Recovery

```mermaid
sequenceDiagram
    participant User as User
    participant App as App
    participant Crypto as WotIdentity
    participant Vault as Relay + Vault
    participant Store as PersonalDoc CRDT

    User->>App: Enters 12 words

    App->>Crypto: validateMnemonic(words)
    Crypto->>Crypto: Check against BIP39 word list
    Crypto->>Crypto: Check checksum

    alt Invalid
        Crypto->>App: invalid
        App->>User: Error: Invalid phrase
    else Valid
        Crypto->>App: valid
    end

    App->>Crypto: WotIdentity.unlock(mnemonic)
    Crypto->>Crypto: BIP39 → entropy → seed
    Crypto->>Crypto: HKDF → master key (non-extractable)
    Crypto->>Crypto: HKDF path → Ed25519 signing key
    Crypto->>Crypto: HKDF path → X25519 encryption key

    App->>Crypto: getDid()
    Crypto->>App: did:key:z6Mk...

    App->>Vault: fetchSnapshot(did, signedCapability)
    Vault->>Vault: Verify capability signature
    Vault->>App: Encrypted PersonalDoc bytes

    App->>Crypto: decrypt(snapshot, derivedKey)
    Crypto->>App: Y.Doc state bytes

    App->>Store: Y.applyUpdate(ydoc, bytes)
    Note over Store: PersonalDoc CRDT (Y.Map) populated

    App->>User: Restoration complete
```

---

## Step 1: Validate mnemonic

### BIP39 validation

```typescript
function validateMnemonic(words: string[]): { valid: boolean; error?: string } {
  // 1. Check count
  if (words.length !== 12) {
    return { valid: false, error: 'Exactly 12 words required' };
  }

  // 2. Check all words against BIP39 list (German wordlist)
  const wordlist = getBIP39Wordlist('german');
  for (const word of words) {
    if (!wordlist.includes(word.toLowerCase())) {
      return { valid: false, error: `Unknown word: ${word}` };
    }
  }

  // 3. Check checksum
  const entropy = mnemonicToEntropy(words);
  const checksumBits = calculateChecksum(entropy);
  const expectedChecksum = extractChecksumFromMnemonic(words);

  if (checksumBits !== expectedChecksum) {
    return { valid: false, error: 'Invalid checksum' };
  }

  return { valid: true };
}
```

### Checksum calculation

```mermaid
flowchart LR
    Words["12 words"] --> Indices["11-bit indices"]
    Indices --> Concat["132 bits total"]
    Concat --> Split["128 bits entropy + 4 bits checksum"]
    Split --> Hash["SHA256(entropy)"]
    Hash --> Compare["First 4 bits == checksum?"]
```

---

## Step 2: Derive keys — WotIdentity.unlock()

### From mnemonic to key material

```mermaid
flowchart TD
    Mnemonic["12 words (German BIP39)"] --> Entropy["128-bit entropy"]

    Entropy --> Seed["BIP39 seed (512 bits)"]

    Seed --> HKDF["HKDF-SHA256<br/>(non-extractable master key)"]

    subgraph HKDF_Paths["HKDF Derivation Paths"]
        Sign["info: 'sign' → Ed25519 private key"]
        Encrypt["info: 'x25519' → X25519 key"]
        Frame["info: 'framework/{name}' → framework keys"]
    end

    HKDF --> Sign
    HKDF --> Encrypt
    HKDF --> Frame

    Sign --> PubKey["Ed25519 public key"]
    PubKey --> DID["did:key:z6Mk..."]
```

### Code example

```typescript
// WotIdentity.unlock() — simplified
async function unlock(mnemonic: string): Promise<void> {
  // 1. Mnemonic → entropy → seed
  const entropy = mnemonicToEntropy(mnemonic.split(' '));
  const seed = await mnemonicToSeed(entropy); // standard BIP39

  // 2. Seed → HKDF master key (non-extractable)
  const masterKey = await crypto.subtle.importKey(
    'raw', seed,
    { name: 'HKDF' },
    false, // non-extractable
    ['deriveKey', 'deriveBits']
  );

  // 3. Derive Ed25519 signing key
  const signingKeyBytes = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encode('sign') },
    masterKey,
    256
  );
  // → used with @noble/ed25519 for signing

  // 4. Compute DID
  const publicKey = ed25519.getPublicKey(new Uint8Array(signingKeyBytes));
  const did = createDid(publicKey); // did:key:z6Mk...
}
```

---

## Step 3: Vault restore

### Authentication for recovery

```mermaid
sequenceDiagram
    participant App as App
    participant Vault as Vault Server

    App->>App: Derive keys from phrase
    App->>App: Compute DID

    Note over App: Create signed capability token

    App->>App: capability = createCapability(did, 'vault:read', signFn)

    App->>Vault: GET /vault/{did}/snapshot
    Note over App,Vault: Authorization: Bearer {capability}

    Vault->>Vault: Extract public key from DID
    Vault->>Vault: Verify capability signature

    Vault->>App: Encrypted PersonalDoc snapshot bytes
```

### Data manifest (what is available)

```json
{
  "did": "did:key:z6Mk...",
  "dataAvailable": {
    "profile": true,
    "contacts": 23,
    "verifications": 23,
    "attestationsReceived": 47,
    "attestationsGiven": 12,
    "items": 34,
    "spaces": 3
  },
  "snapshotSize": "2.3 MB",
  "lastSync": "2026-01-08T10:00:00Z"
}
```

### Restore flow

```mermaid
flowchart TD
    Unlock(["WotIdentity.unlock() complete"]) --> Cap["Create signed capability"]

    Cap --> Fetch["GET /vault/{did}/snapshot"]

    Fetch --> Encrypted["Encrypted Y.Doc bytes"]

    Encrypted --> Decrypt["Decrypt with AES-256-GCM<br/>(key derived via HKDF)"]

    Decrypt --> Apply["Y.applyUpdate(ydoc, bytes)"]

    Apply --> Store["PersonalDoc CRDT (Y.Map) populated"]

    Store --> ReactiveUpdate["Reactive UI updates"]
```

---

## Step 4: PersonalDoc CRDT (Y.Map)

### Data model after restore

```typescript
// PersonalDoc is a Y.Doc with Y.Maps for each collection
interface PersonalDoc {
  profile:             Y.Map<ProfileDoc>
  contacts:            Y.Map<ContactDoc>        // keyed by DID
  verifications:       Y.Map<VerificationDoc>   // keyed by ID
  attestations:        Y.Map<AttestationDoc>    // keyed by ID
  attestationMetadata: Y.Map<AttestationMetaDoc>
  outbox:              Y.Map<OutboxEntryDoc>
  spaces:              Y.Map<SpaceMetadataDoc>
  groupKeys:           Y.Map<GroupKeyDoc>
}
```

### Applying the snapshot

```typescript
async function restoreFromVault(
  identity: WotIdentity,
  vaultClient: VaultClient
): Promise<YjsPersonalDocManager> {
  const did = identity.getDid();

  // 1. Fetch encrypted snapshot
  const encryptedBytes = await vaultClient.getSnapshot(did);

  if (!encryptedBytes) {
    // No vault data — fresh start
    return new YjsPersonalDocManager(identity);
  }

  // 2. Decrypt
  const vaultKey = await identity.deriveFrameworkKey('vault');
  const plainBytes = await decryptSymmetric(encryptedBytes, vaultKey);

  // 3. Apply to Y.Doc
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, plainBytes);

  // 4. Wrap in manager
  return new YjsPersonalDocManager(identity, ydoc);
}
```

---

## Step 5: Key storage after restore

### Platform-specific storage

```mermaid
flowchart TD
    MasterKey["HKDF Master Key<br/>(non-extractable)"] --> Platform{"Platform?"}

    Platform -->|iOS| Keychain["iOS Keychain<br/>kSecAttrAccessibleWhenUnlocked"]
    Platform -->|Android| Keystore["Android Keystore<br/>setUserAuthenticationRequired"]
    Platform -->|Web| IDB["IndexedDB<br/>extractable: false CryptoKey object"]

    Note["Master key is derived fresh<br/>from mnemonic on recovery.<br/>Then stored as non-extractable."]
```

### Encrypted seed storage (web)

On web, the seed is stored encrypted in IndexedDB so that subsequent unlocks only require a passphrase (not the full mnemonic):

```typescript
// After recovery: store encrypted seed for future unlockFromStorage()
async function storeSeed(seed: Uint8Array, passphrase: string): Promise<void> {
  // PBKDF2 to derive storage key from passphrase
  const storageKey = await deriveStorageKey(passphrase); // PBKDF2, 600k rounds

  // AES-256-GCM encrypt the seed
  const { ciphertext, iv } = await encryptAesGcm(seed, storageKey);

  // Store in IndexedDB
  await idb.put('seed-store', { ciphertext, iv }, 'encrypted-seed');
}
```

---

## Error handling

### Error types

```mermaid
flowchart TD
    Recovery(["Start recovery"]) --> V1{"Mnemonic valid?"}

    V1 -->|No| E1["Error: Invalid phrase"]

    V1 -->|Yes| V2{"Vault reachable?"}

    V2 -->|No| E2["Error: No connection<br/>(can retry later)"]

    V2 -->|Yes| V3{"DID known in Vault?"}

    V3 -->|No| E3["Error: No data found<br/>(never synced to Vault)"]

    V3 -->|Yes| V4{"Decryption successful?"}

    V4 -->|No| E4["Error: Data corrupt"]

    V4 -->|Yes| Success["Recovery successful"]
```

### Error responses

```json
{
  "error": "invalid_mnemonic",
  "message": "The recovery phrase is invalid",
  "details": {
    "invalidWord": "bananx",
    "position": 2,
    "suggestion": "banane"
  }
}
```

```json
{
  "error": "did_not_found",
  "message": "No data exists for this identity",
  "details": {
    "did": "did:key:z6Mk...",
    "hint": "Was the identity synced to the Vault before the device was lost?"
  }
}
```

---

## Security considerations

### Brute-force protection

| Measure | Description |
| ------- | ----------- |
| BIP39 entropy | 128 bits = 2^128 combinations |
| HKDF | Key derivation is fast (unlike PBKDF2) but entropy space is the protection |
| No enumeration | Vault does not reveal whether a DID exists without a valid signature |
| Capability token | Vault requires a freshly signed capability — proves key possession |

### Timing analysis

```typescript
// Constant-time comparison for signature verification
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}
```

### Recovery vs. new login

The Vault cannot distinguish between:

- A legitimate user recovering their identity
- An attacker who has stolen the phrase

**Consequence:** The phrase IS the identity. Whoever holds the phrase has control.

---

## Multi-Device vs. Recovery

### Difference

| Aspect | Multi-Device | Recovery |
| ------ | ------------ | -------- |
| Enter phrase | Yes | Yes |
| Old device still active | Yes | No |
| Sync state | Incremental from Relay | Full restore from Vault |
| Master key | Freshly derived from phrase | Freshly derived from phrase |
| PersonalDoc | Merge with existing | Replace from snapshot |

### Same phrase, multiple devices

```mermaid
flowchart TD
    Phrase["Recovery phrase"] --> Phone["Phone"]
    Phrase --> Tablet["Tablet"]
    Phrase --> Web["Browser"]

    Phone --> Same["Same HKDF master key"]
    Tablet --> Same
    Web --> Same

    Same --> SameDID["Same DID<br/>did:key:z6Mk..."]

    SameDID --> Sync["Relay + Vault keep all devices in sync"]
```

---

## Complete sequence diagram

```mermaid
sequenceDiagram
    participant U as User
    participant App as App
    participant Identity as WotIdentity
    participant Vault as Vault
    participant Secure as Secure Storage
    participant CRDT as PersonalDoc CRDT

    U->>App: Enter 12 words

    App->>Identity: validateMnemonic()
    Identity->>App: valid

    App->>Identity: unlock(mnemonic)
    Identity->>Identity: BIP39 → seed → HKDF master key
    Identity->>Identity: Derive Ed25519 + X25519 keys
    Identity->>App: DID = did:key:z6Mk...

    App->>Identity: createCapability('vault:read')
    Identity->>App: signedCapability

    App->>Vault: GET /vault/{did}/snapshot
    Vault->>Vault: verifyCapability()
    Vault->>App: encryptedBytes

    App->>Identity: deriveFrameworkKey('vault')
    Identity->>App: vaultKey

    App->>App: decryptSymmetric(encryptedBytes, vaultKey)
    App->>CRDT: Y.applyUpdate(ydoc, plainBytes)

    Note over CRDT: contacts, verifications, attestations, spaces all populated

    App->>Secure: storeSeed(seed, passphrase)
    Secure->>App: ok

    App->>U: Welcome back!
```
