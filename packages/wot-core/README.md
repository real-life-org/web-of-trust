# @web_of_trust/core

Core library for building decentralized Web of Trust applications.

## What is Web of Trust?

A system where trust grows through real-world encounters. People meet, verify each other's identity, and build reputation through genuine actions - not followers or likes.

Three pillars:
- **Verification** - Confirm identity through meeting in person
- **Cooperation** - Share encrypted content (calendars, maps, projects)
- **Attestation** - Build reputation through real deeds

## Migration to 0.6

0.6 removes the Old-World message channel (wot#386); the relay never accepted it.

- `new VerificationWorkflow({ crypto })` → `new VerificationWorkflow()` — the `crypto` option is gone (all options are optional now).
- Removed from `VerificationWorkflow`: `createChallenge` (old form), `decodeChallenge`, `prepareChallenge`, `createResponse`, `decodeResponse`, `completeVerification`, `createVerificationFor`, `verifySignature`, and the types `VerificationChallenge` / `VerificationResponse`. Verification runs over `createOnlineQrChallenge` and verification attestations delivered via `inbox/1.0` (Trust 002).
- `OutboxMessagingAdapter`: `skipTypes` defaults to `[]` (was `['profile-update']`).
- `InMemoryMessagingAdapter` rejects everything outside the relay whitelist with `{ status: 'failed', reason: 'MALFORMED_MESSAGE' }`.
- New: `inbox/1.0` body `{ kind: 'profile-update', profile }` (`createProfileUpdateBody`, `assertProfileUpdateBody`), `Contact.profileUpdatedAt`, `Contact.offers` / `Contact.needs`.

## Installation

```bash
npm install @web_of_trust/core
# or
pnpm add @web_of_trust/core
```

## Quick Start

```typescript
import {
  IdentityWorkflow,
  IndexedDbIdentitySeedVault,
  WebCryptoProtocolCryptoAdapter,
} from '@web_of_trust/core'

// Create a new identity
const workflow = new IdentityWorkflow({
  crypto: new WebCryptoProtocolCryptoAdapter(),
  vault: new IndexedDbIdentitySeedVault(),
})
const { mnemonic, identity } = await workflow.createIdentity({
  passphrase: 'your-secure-passphrase',
  storeSeed: true,
})

console.log(mnemonic)          // 12-word BIP39 mnemonic
console.log(identity.getDid()) // did:key:z6Mk...

// Later: Unlock from storage
const { identity: restored } = await workflow.unlockStoredIdentity({
  passphrase: 'your-secure-passphrase',
})
console.log(restored.getDid()) // Same DID
```

## Core Concepts

### Identity Management with IdentityWorkflow

`IdentityWorkflow` is the reference identity entry point. It creates, recovers,
unlocks, and deletes identities through an `IdentitySeedVault` and exposes a
`PublicIdentitySession` for DID, signing, encryption, and framework-key
operations.

**Key Features:**

- **BIP39 Mnemonic**: 12-word recovery phrase (128-bit entropy)
- **Deterministic**: Same mnemonic always produces same DID
- **Vault-backed Storage**: Seed material is stored and unlocked through `IdentitySeedVault`
- **Native WebCrypto**: Pure browser crypto, no external dependencies
- **Operation-shaped Session**: Workflow callers receive signing/decryption operations, not raw seed bytes

```typescript
import {
  IdentityWorkflow,
  IndexedDbIdentitySeedVault,
  WebCryptoProtocolCryptoAdapter,
} from '@web_of_trust/core'

// Create new identity
const workflow = new IdentityWorkflow({
  crypto: new WebCryptoProtocolCryptoAdapter(),
  vault: new IndexedDbIdentitySeedVault(),
})
const { mnemonic, identity } = await workflow.createIdentity({
  passphrase: 'passphrase',
  storeSeed: true,
})
// Save the mnemonic securely! It's the only way to recover your identity

// Recover from mnemonic
const { identity: recovered } = await workflow.recoverIdentity({
  mnemonic,
  passphrase: 'passphrase',
  storeSeed: false,
})

// Sign data
const signature = await recovered.sign('Hello, World!')

// Get public key
const pubKey = await recovered.getPublicKeyMultibase()
```

### Decentralized Identifiers (DIDs)

Every identity is a `did:key` - a self-sovereign identifier derived from an Ed25519 public key. No central authority needed.

```typescript
const did = identity.getDid()
console.log(did) // did:key:z6MkpTHz...
```

### Encrypted Storage

Identity seeds are stored encrypted in IndexedDB:

- Seed encrypted with PBKDF2 (600k iterations) + AES-GCM
- Random salt and IV per storage operation
- Keys derived at runtime as non-extractable CryptoKey objects
- Keys cleared from memory on lock/reload

```typescript
// Check if identity exists
const hasIdentity = await workflow.hasStoredIdentity()

// Delete stored identity
await workflow.deleteStoredIdentity()
```

## Adapter Interfaces

The core defines 7 adapter interfaces. Each can be implemented independently — swap your CRDT, messaging protocol, or storage backend without touching application code.

### StorageAdapter

Local persistence for identity, contacts, and attestations. Follows the **Receiver Principle**: attestations are stored at the recipient, not the sender.

```typescript
interface StorageAdapter {
  createIdentity(did: string, profile: Profile): Promise<Identity>
  getContacts(): Promise<Contact[]>
  addContact(contact: Contact): Promise<void>
  saveAttestation(attestation: Attestation): Promise<void>
  // ... full CRUD for all entity types
}
```

**Implementations:** `LocalStorageAdapter` (IndexedDB)

### ReactiveStorageAdapter

Extends StorageAdapter with live queries and subscriptions. UI components subscribe to data changes and re-render automatically.

```typescript
interface ReactiveStorageAdapter extends StorageAdapter {
  watchIdentity(): Subscribable<Identity | null>
  watchContacts(): Subscribable<Contact[]>
  watchReceivedAttestations(): Subscribable<Attestation[]>
  // ... observables for all entity types
}
```

**Implementations:** Yjs-based (default), Automerge-based (option)

### CryptoAdapter

Signing, verification, and symmetric encryption. Uses WebCrypto API internally — no external crypto dependencies for core operations.

```typescript
interface CryptoAdapter {
  sign(data: Uint8Array, privateKey: CryptoKey): Promise<Uint8Array>
  verify(data: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean>
  generateSymmetricKey(): Promise<Uint8Array>
  encryptSymmetric(data: Uint8Array, key: Uint8Array): Promise<Uint8Array>
  decryptSymmetric(data: Uint8Array, key: Uint8Array): Promise<Uint8Array>
}
```

**Implementations:** `WebCryptoCryptoAdapter` (Ed25519, AES-256-GCM)

### DiscoveryAdapter

Public profile lookup — find information about a DID before establishing contact. Profiles are JWS-signed for authenticity.

```typescript
interface DiscoveryAdapter {
  lookupProfile(did: string): Promise<PublicProfile | null>
  publishProfile(profile: PublicProfile): Promise<void>
}
```

**Implementations:** `HttpDiscoveryAdapter` (wot-profiles server), `OfflineFirstDiscoveryAdapter` (cache + dirty flags)

### MessagingAdapter

Point-to-point message delivery between DIDs. Messages are E2E encrypted and delivered via the Relay with ACK-based guaranteed delivery.

```typescript
interface MessagingAdapter {
  connect(myDid: string): Promise<void>
  disconnect(): Promise<void>
  getState(): MessagingState
  onStateChange(callback: (state: MessagingState) => void): () => void
  send(envelope: WireMessage): Promise<DeliveryReceipt>
  sendControlFrame?(frame: ControlFrame): Promise<ControlFrameReceipt>   // required for log sync
  rebindDeviceId?(newDeviceId: string): Promise<void>                    // restore-clone re-bind
  onMessage(callback: (envelope: WireMessage) => void | Promise<void>): () => void
  onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void
  registerTransport(did: string, transportAddress: string): Promise<void>
  resolveTransport(did: string): Promise<string | null>
}
```

The relay accepts only the Sync 003 whitelist: `ack`, `log-entry`, `sync-request`, control frames and the four encrypted inbox types (`inbox`, `space-invite`, `member-update`, `key-rotation`). `InMemoryMessagingAdapter` enforces the same whitelist in tests.

**Implementations:** `WebSocketMessagingAdapter` (wot-relay), `OutboxMessagingAdapter` (decorator, queues for offline)

### ReplicationAdapter

Encrypted CRDT-based shared spaces. Multiple users collaborate on the same document with automatic conflict resolution and group key encryption.

```typescript
interface ReplicationAdapter {
  createSpace(info: SpaceInfo): Promise<SpaceHandle>
  joinSpace(spaceId: string, info: SpaceInfo): Promise<SpaceHandle>
  getSpace(spaceId: string): SpaceHandle | undefined
  listSpaces(): SpaceHandle[]
}
```

**Implementations:** `YjsReplicationAdapter` (default), `AutomergeReplicationAdapter` (option)

### AuthorizationAdapter

UCAN-inspired capability system. Capabilities are offline-verifiable, delegable, and attenuable. The private key stays encapsulated via the SignFn pattern.

```typescript
interface AuthorizationAdapter {
  createCapability(scope: string, actions: string[], subject: string): Promise<Capability>
  verifyCapability(capability: Capability): Promise<boolean>
  delegateCapability(capability: Capability, to: string, attenuate?: Attenuation): Promise<Capability>
}
```

**Implementations:** `InMemoryAuthorizationAdapter` + `application/authorization/capabilities.ts`

---

## API Reference

### IdentityWorkflow

Reference identity lifecycle service.

#### Constructor

```typescript
const workflow = new IdentityWorkflow({
  crypto: new WebCryptoProtocolCryptoAdapter(),
  vault: new IndexedDbIdentitySeedVault(),
})
```

#### Methods

**`createIdentity(input): Promise<{ mnemonic: string, identity: PublicIdentitySession }>`**

Create a new identity with a BIP39 mnemonic.

```typescript
const { mnemonic, identity } = await workflow.createIdentity({
  passphrase: 'secure-passphrase',
  storeSeed: true,
})
// Save mnemonic securely! It's your only recovery method
```

**`recoverIdentity(input): Promise<{ identity: PublicIdentitySession }>`**

Restore identity from BIP39 mnemonic.

```typescript
const { identity } = await workflow.recoverIdentity({
  mnemonic,
  passphrase: 'secure-passphrase',
})
```

**`unlockStoredIdentity(input): Promise<{ identity: PublicIdentitySession }>`**

Unlock identity from the configured vault.

```typescript
const { identity } = await workflow.unlockStoredIdentity({
  passphrase: 'secure-passphrase',
})
```

### PublicIdentitySession

Operation-shaped identity session returned by `IdentityWorkflow`.

**`sign(data: string): Promise<string>`**

Sign data with Ed25519, returns base64url signature.

```typescript
const signature = await identity.sign('Hello, World!')
```

**`getDid(): string`**

Get the current DID (throws if locked).

```typescript
const did = identity.getDid() // did:key:z6Mk...
```

**`getPublicKeyMultibase(): Promise<string>`**

Get public key in multibase format (z-prefixed base58btc).

```typescript
const pubKey = await identity.getPublicKeyMultibase()
```

**`deriveFrameworkKey(info: string): Promise<Uint8Array>`**

Derive framework-specific keys using HKDF.

```typescript
const evolKey = await identity.deriveFrameworkKey('evolu-storage-v1')
```

### Identity Seed Persistence

The legacy `WotIdentity` implementation and the `SeedStorage` /
`SeedStorageAdapter` abstraction have been removed from the reference
TypeScript source.

`IndexedDbIdentitySeedVault` is the supported browser-side identity-seed
persistence boundary. It owns its encrypted IndexedDB layer internally and
satisfies the `IdentitySeedVault` contract used by `IdentityWorkflow`.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck
```

### Testing

The package includes comprehensive test coverage:

- **29 tests** covering identity creation, encryption, deterministic key derivation
- Uses Vitest with happy-dom and fake-indexeddb for browser environment simulation
- Tests validate BIP39 mnemonic generation, PBKDF2+AES-GCM encryption, and Ed25519 signing

Run tests with:

```bash
pnpm test
```

## Part of the Web of Trust Project

This package is the foundation for:
- [Demo App](../apps/demo) - Try the Web of Trust
- [Protocol Docs](../docs) - Full specification

## License

MIT
